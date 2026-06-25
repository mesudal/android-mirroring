/**
 * CertManager – MITM 프록시를 위한 CA 인증서 생성 및 호스트별 인증서 동적 발급
 * node-forge 기반
 */
const forge = require('node-forge')
const fs = require('fs')
const path = require('path')

class CertManager {
  constructor(certDir) {
    this.certDir = certDir
    this.caKey = null
    this.caCert = null
    this.cache = new Map() // hostname → { key, cert } (PEM)
    this._init()
  }

  _init() {
    if (!fs.existsSync(this.certDir)) fs.mkdirSync(this.certDir, { recursive: true })

    const caKeyPath = path.join(this.certDir, 'ca.key')
    const caCertPath = path.join(this.certDir, 'ca.crt')

    if (fs.existsSync(caKeyPath) && fs.existsSync(caCertPath)) {
      // 기존 CA 로드
      this.caKey = forge.pki.privateKeyFromPem(fs.readFileSync(caKeyPath, 'utf8'))
      this.caCert = forge.pki.certificateFromPem(fs.readFileSync(caCertPath, 'utf8'))
    } else {
      // 새 CA 생성
      this._generateCA()
      fs.writeFileSync(caKeyPath, forge.pki.privateKeyToPem(this.caKey))
      fs.writeFileSync(caCertPath, forge.pki.certificateToPem(this.caCert))
    }
  }

  _generateCA() {
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()

    cert.publicKey = keys.publicKey
    cert.serialNumber = '01'
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10)

    const attrs = [
      { name: 'commonName', value: 'DroidBridge Proxy CA' },
      { name: 'organizationName', value: 'DroidBridge' },
      { name: 'countryName', value: 'KR' },
    ]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)

    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
      { name: 'subjectKeyIdentifier' },
    ])

    cert.sign(keys.privateKey, forge.md.sha256.create())

    this.caKey = keys.privateKey
    this.caCert = cert
  }

  /**
   * 특정 호스트명에 대한 인증서를 동적으로 발급 (CA로 서명)
   * @returns {{ key: string, cert: string }} PEM 형식
   */
  getCertForHost(hostname) {
    if (this.cache.has(hostname)) return this.cache.get(hostname)

    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()

    cert.publicKey = keys.publicKey
    cert.serialNumber = Date.now().toString(16)
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2)

    cert.setSubject([{ name: 'commonName', value: hostname }])
    cert.setIssuer(this.caCert.subject.attributes)

    cert.setExtensions([
      { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ])

    cert.sign(this.caKey, forge.md.sha256.create())

    const result = {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert),
    }
    this.cache.set(hostname, result)
    return result
  }

  /** CA 인증서 파일 경로 (.crt) — 안드로이드에 push할 때 사용 */
  getCACertPath() {
    return path.join(this.certDir, 'ca.crt')
  }

  /** CA 인증서 PEM (DER로 변환하여 안드로이드 설치용) */
  getCACertDerPath() {
    const derPath = path.join(this.certDir, 'ca.der.crt')
    if (!fs.existsSync(derPath)) {
      const pem = forge.pki.certificateToPem(this.caCert)
      // Android는 PEM(.crt)도 인식하므로 PEM 그대로 복사
      fs.copyFileSync(this.getCACertPath(), derPath)
    }
    return derPath
  }
}

module.exports = CertManager
