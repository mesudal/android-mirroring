/**
 * ProxyServer – HTTP/HTTPS MITM 프록시 서버
 * HTTP 요청은 직접 중계, HTTPS는 CONNECT 터널을 가로채서 동적 인증서로 복호화
 */
const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const { URL } = require('url')

class ProxyServer {
  /**
   * @param {import('./cert-manager')} certManager
   * @param {function} onPacket – 캡처된 패킷 콜백 (packetObj)
   */
  constructor(certManager, onPacket) {
    this.certManager = certManager
    this.onPacket = onPacket || (() => {})
    this.server = null
    this.packetId = 0
  }

  start(port = 8888) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this._handleHttp.bind(this))
      this.server.on('connect', this._handleConnect.bind(this))
      this.server.on('error', reject)
      this.server.listen(port, '0.0.0.0', () => {
        console.log(`[proxy] HTTP/HTTPS MITM 프록시 시작됨 — 포트 ${port}`)
        resolve(port)
      })
    })
  }

  stop() {
    return new Promise(resolve => {
      if (this.server) {
        this.server.close(() => {
          console.log('[proxy] 프록시 서버 중지됨')
          this.server = null
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  /** HTTP (비암호화) 요청 중계 */
  _handleHttp(clientReq, clientRes) {
    const id = ++this.packetId
    const startTime = Date.now()

    let url
    try {
      url = new URL(clientReq.url)
    } catch {
      clientRes.writeHead(400)
      clientRes.end('Bad Request')
      return
    }

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: clientReq.method,
      headers: { ...clientReq.headers },
    }
    delete options.headers['proxy-connection']

    const reqBodyChunks = []
    clientReq.on('data', chunk => reqBodyChunks.push(chunk))

    clientReq.on('end', () => {
      const reqBody = Buffer.concat(reqBodyChunks)
      const proxyReq = http.request(options, proxyRes => {
        const resBodyChunks = []
        proxyRes.on('data', chunk => resBodyChunks.push(chunk))
        proxyRes.on('end', () => {
          const resBody = Buffer.concat(resBodyChunks)
          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers)
          clientRes.end(resBody)

          this.onPacket({
            id,
            protocol: 'HTTP',
            method: clientReq.method,
            host: url.hostname,
            path: url.pathname + url.search,
            url: clientReq.url,
            statusCode: proxyRes.statusCode,
            requestHeaders: clientReq.headers,
            responseHeaders: proxyRes.headers,
            requestBody: this._safeBody(reqBody, clientReq.headers['content-type']),
            responseBody: this._safeBody(resBody, proxyRes.headers['content-type']),
            requestSize: reqBody.length,
            responseSize: resBody.length,
            duration: Date.now() - startTime,
            timestamp: startTime,
          })
        })
      })
      proxyReq.on('error', err => {
        clientRes.writeHead(502)
        clientRes.end('Bad Gateway: ' + err.message)
      })
      proxyReq.end(reqBody)
    })
  }

  /** HTTPS CONNECT 터널 – MITM 가로채기 */
  _handleConnect(clientReq, clientSocket, head) {
    const [hostname, port] = clientReq.url.split(':')
    const targetPort = parseInt(port) || 443

    // 클라이언트에게 터널 수립 OK 응답
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // 호스트별 동적 인증서로 TLS 서버 생성
    const { key, cert } = this.certManager.getCertForHost(hostname)
    const tlsServer = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key,
      cert,
    })

    // TLS 핸드셰이크 성공 후 HTTP 파싱
    tlsServer.on('error', () => tlsServer.destroy())

    // TLS 소켓 위에 임시 HTTP 서버를 올려서 요청 파싱
    const fakeServer = http.createServer()
    fakeServer.emit('connection', tlsServer)

    fakeServer.on('request', (req, res) => {
      const id = ++this.packetId
      const startTime = Date.now()
      const fullUrl = `https://${hostname}${req.url}`

      const options = {
        hostname,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: hostname },
        rejectUnauthorized: false,
      }

      const reqBodyChunks = []
      req.on('data', chunk => reqBodyChunks.push(chunk))

      req.on('end', () => {
        const reqBody = Buffer.concat(reqBodyChunks)

        const proxyReq = https.request(options, proxyRes => {
          const resBodyChunks = []
          proxyRes.on('data', chunk => resBodyChunks.push(chunk))
          proxyRes.on('end', () => {
            const resBody = Buffer.concat(resBodyChunks)

            // Content-Encoding 처리 (gzip 등은 그대로 전달)
            const resHeaders = { ...proxyRes.headers }
            res.writeHead(proxyRes.statusCode, resHeaders)
            res.end(resBody)

            this.onPacket({
              id,
              protocol: 'HTTPS',
              method: req.method,
              host: hostname,
              path: req.url,
              url: fullUrl,
              statusCode: proxyRes.statusCode,
              requestHeaders: req.headers,
              responseHeaders: proxyRes.headers,
              requestBody: this._safeBody(reqBody, req.headers['content-type']),
              responseBody: this._safeBody(resBody, proxyRes.headers['content-type']),
              requestSize: reqBody.length,
              responseSize: resBody.length,
              duration: Date.now() - startTime,
              timestamp: startTime,
            })
          })
        })

        proxyReq.on('error', err => {
          try {
            res.writeHead(502)
            res.end('Bad Gateway: ' + err.message)
          } catch {}
        })
        proxyReq.end(reqBody)
      })
    })
  }

  /** Body를 안전하게 문자열로 변환 (바이너리면 크기만 표시) */
  _safeBody(buf, contentType) {
    if (!buf || buf.length === 0) return ''
    if (buf.length > 512 * 1024) return `[바이너리 데이터 ${(buf.length / 1024).toFixed(1)} KB]`

    const ct = (contentType || '').toLowerCase()
    if (ct.includes('text') || ct.includes('json') || ct.includes('xml') ||
        ct.includes('html') || ct.includes('javascript') || ct.includes('form')) {
      try { return buf.toString('utf8') } catch { }
    }
    return `[바이너리 데이터 ${(buf.length / 1024).toFixed(1)} KB]`
  }
}

module.exports = ProxyServer
