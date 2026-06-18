/**
 * mirror-bridge.js — scrcpy v4.x 프로토콜 구현 (수정판)
 *
 * v4.0 와이어 프로토콜 (send_frame_meta=true 기준):
 *   [연결 후 서버가 전송]
 *   1. deviceName   : 64 bytes (UTF-8, null-padded)
 *   2. codec_id     : 4 bytes uint32 BE  (0x68323634 = "h264")
 *   3. initial_meta : 8 bytes  → width(4) + height(4) BE  ← v4.0: flags 필드 없음!
 *   4. 이후 프레임  : pts(8 bytes int64 BE) + size(4 bytes) + H.264 access unit
 *
 * [수정 사항]
 *  - SESSION_META_LEN: 12→8  (flags 필드 제거, v4.0 실제 포맷 반영)
 *  - send_frame_meta: false→true  (프레임 단위 파싱으로 안정성 향상)
 *  - max_fps 파라미터 추가
 *  - _pipe 상태 머신 완전 재작성 (frameHeader / frameData 상태 추가)
 *  - switch case 내 const 블록 명시화
 */
'use strict'

const net = require('net')
const { WebSocketServer } = require('ws')
const { execFile, spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const FALLBACK_VER = '4.0'
const H264_CODEC_ID = 0x68323634  // ASCII "h264"

class MirrorBridge {
  constructor({ adbPath, binDir, onLog }) {
    this.adbPath = adbPath
    this.binDir = binDir
    this.log = msg => onLog?.('[bridge] ' + msg)
    this.wss = null
    this.wsClient = null
    this.adbSock = null
    this.controlSock = null
    this.srvProc = null
    this.serial = null
    this.running = false
    this._metaJson = null   // 캐싱: 늦게 연결된 WS 클라이언트에게 전송
    this._frameCnt = 0
  }

  // ── adb 헬퍼 ─────────────────────────────────────────────────
  adb(args, ms = 25000) {
    return new Promise((res, rej) => {
      execFile(this.adbPath, args, { timeout: ms }, (err, out, err2) => {
        if (err) rej(new Error((err2 || err.message).trim()))
        else res(out.trim())
      })
    })
  }

  // ── WSS 시작 ─────────────────────────────────────────────────
  startWss() {
    if (this.wss) return Promise.resolve(this.wsPort)
    return new Promise((res, rej) => {
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
      wss.once('listening', () => {
        this.wsPort = wss.address().port
        this.log(`WSS ready :${this.wsPort}`)
        this.wss = wss
        res(this.wsPort)
      })
      wss.once('error', e => {
        rej(e)
      })
      wss.on('connection', ws => {
        this.wsClient = ws
        this.log('★ renderer WS 연결됨')
        // 이미 meta가 캐싱되어 있으면 즉시 전송 (늦은 연결 복구)
        if (this._metaJson) {
          try { ws.send(this._metaJson) } catch { }
          this.log('  → 캐시된 meta 전송: ' + this._metaJson)
        }
        ws.on('message', data => {
          try {
            const msg = JSON.parse(data)
            if (msg.type === 'touch') {
              this.injectTouch(msg)
            } else if (msg.type === 'keycode') {
              this.injectKeycode(msg)
            } else if (msg.type === 'text') {
              this.injectText(msg)
            }
          } catch (e) {
            this.log('WS 수신 메시지 처리 오류: ' + e.message)
          }
        })
        ws.on('close', () => { this.wsClient = null; this.log('★ renderer WS 끊김') })
        ws.on('error', e => { this.wsClient = null; this.log('★ renderer WS 오류: ' + e.message) })
      })
    })
  }

  // ── jar 확보 ─────────────────────────────────────────────────
  async ensureJar() {
    // 1. 시스템 설치 경로 탐색 (macOS / Linux)
    for (const p of [
      '/usr/share/scrcpy/scrcpy-server',
      '/usr/local/share/scrcpy/scrcpy-server',
      '/opt/homebrew/share/scrcpy/scrcpy-server',
    ]) { if (fs.existsSync(p)) { this.log('jar: system ' + p); return { path: p, ver: null } } }

    // 2. 로컬 binDir에 이미 캐싱된 scrcpy-server-v* 또는 scrcpy-server 파일이 있는지 우선 스캔 (오프라인 실행 보장)
    try {
      if (fs.existsSync(this.binDir)) {
        const files = fs.readdirSync(this.binDir)
        // scrcpy-server-v4.0 등 버전명이 명시된 캐시파일 우선 검색
        const jarFile = files.find(f => f.startsWith('scrcpy-server-v'))
        if (jarFile) {
          const cached = path.join(this.binDir, jarFile)
          const ver = this._jarVer(jarFile)
          this.log(`jar: found local cached ${jarFile} (v${ver})`)
          return { path: cached, ver }
        }
        // 일반 scrcpy-server 파일 검색
        const plainJar = files.find(f => f === 'scrcpy-server')
        if (plainJar) {
          const cached = path.join(this.binDir, plainJar)
          this.log(`jar: found local plain scrcpy-server`)
          return { path: cached, ver: null }
        }
      }
    } catch (e) {
      this.log('로컬 캐시 스캔 중 예외: ' + e.message)
    }

    // 3. 로컬에 없을 경우에만 GitHub 최신 버전 확인 및 다운로드 시도
    let ver = FALLBACK_VER
    try {
      const r = await fetch('https://api.github.com/repos/Genymobile/scrcpy/releases/latest',
        { headers: { 'User-Agent': 'droidbridge' } })
      const j = await r.json()
      ver = j.tag_name.replace(/^v/, '')
      this.log(`GitHub latest: v${ver}`)
    } catch { this.log('GitHub API 제한 또는 오프라인 — v' + ver + ' 사용') }

    const cached = path.join(this.binDir, `scrcpy-server-v${ver}`)
    if (fs.existsSync(cached)) { this.log(`jar: cache (v${ver})`); return { path: cached, ver } }

    const url = `https://github.com/Genymobile/scrcpy/releases/download/v${ver}/scrcpy-server-v${ver}`
    this.log(`downloading v${ver}...`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`jar HTTP ${res.status}`)
    fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()))
    this.log(`jar v${ver} saved`)
    return { path: cached, ver }
  }

  // ── 메인 시작 ────────────────────────────────────────────────
  async start({ serial, maxSize, videoBitrate, fps }) {
    if (this.running) await this.stop()
    this.serial = serial
    this.running = true

    try {
      // ─ 기존 좀비 scrcpy 프로세스 제거 (이전 세션 찌꺼기가 소켓을 점거하는 문제 방지)
      this.log('기존 scrcpy 프로세스 정리 중...')
      await this.adb(['-s', serial, 'shell', 'pkill', '-f', 'com.genymobile.scrcpy']).catch(() => { })
      await new Promise(r => setTimeout(r, 1200))  // Android 프로세스 종료 대기

      this.log('STEP 1: WSS 시작...')
      await this.startWss()

      this.log('STEP 2: jar 확보...')
      const { path: jarPath, ver: rawVer } = await this.ensureJar()
      const ver = rawVer || this._jarVer(jarPath) || FALLBACK_VER
      this.log(`jar v${ver} @ ${jarPath}`)

      this.log('STEP 3: adb push...')
      await this.adb(['-s', serial, 'push', jarPath, '/data/local/tmp/scrcpy-server.jar'])
      this.log('push OK')

      this.log('STEP 4: adb forward...')
      const forwardOut = await this.adb(['-s', serial, 'forward', 'tcp:0', 'localabstract:scrcpy'])
      this.forwardPort = parseInt(forwardOut.trim(), 10)
      this.log(`forward OK → tcp:${this.forwardPort}`)

      this.log(`STEP 5: scrcpy-server v${ver} 실행...`)
      await this._runServer(serial, ver, maxSize, videoBitrate, fps)

      this.log('STEP 6: 소켓 연결...')
      await this._connectWithRetry()

      this.log('STEP 7: 스트리밍 시작!')
    } catch (e) {
      this.log('ERROR: ' + e.message)
      this.running = false
      throw e
    }
  }

  // ── 서버 실행 ────────────────────────────────────────────────
  async _runServer(serial, ver, maxSize, videoBitrate, fps) {
    const args = [
      '-s', serial, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process', '/',
      'com.genymobile.scrcpy.Server',
      ver,
      'log_level=verbose',
      `max_size=${maxSize || 0}`,
      `video_bit_rate=${(videoBitrate || 8) * 1_000_000}`,
      `max_fps=${fps || 60}`,
      'tunnel_forward=true',
      'send_frame_meta=true',   // ← 핵심 수정: 프레임 단위 메타데이터로 안정적 파싱
      'control=true',
      'video_codec=h264',
      'audio=false',
      'cleanup=true',
    ]

    this.log('server args: ' + args.slice(5).join(' '))
    this.srvProc = spawn(this.adbPath, args)

    const logLine = d => d.toString().split('\n').filter(Boolean).forEach(l => this.log(l))
    this.srvProc.stdout.on('data', logLine)
    this.srvProc.stderr.on('data', logLine)
    this.srvProc.on('close', code => {
      this.log(`server exited (${code})`)
      this.running = false
      this._wsSend(JSON.stringify({ type: 'stopped', code }))
    })

    // 서버 기동 대기
    // Device: 출력 이후 추가 1.5초 대기 — abstract socket 바인딩 완료까지 시간 필요
    await new Promise(res => {
      let done = false
      const finish = () => { if (!done) { done = true; res() } }
      const onData = d => {
        const s = d.toString()
        if (s.includes('Device:') || s.includes('READY') || s.includes('send_frame_meta')) {
          this.log('서버 준비 신호 감지 — 소켓 바인딩 대기 중 (1.5초)...')
          setTimeout(finish, 1500)  // abstract socket이 완전히 열릴 때까지 대기
        }
      }
      this.srvProc.stderr.on('data', onData)
      this.srvProc.stdout.on('data', onData)
      setTimeout(finish, 8000)  // 최대 8초 타임아웃
    })
    this.log('서버 기동 대기 완료')
  }

  // ── 소켓 연결 (재시도) ───────────────────────────────────────
  _connectWithRetry(maxTries = 15, delay = 800) {
    return new Promise((res, rej) => {
      let n = 0
      const attempt = () => {
        n++
        this.log(`소켓 연결 시도 ${n}/${maxTries}`)
        const videoSock = net.connect(this.forwardPort, '127.0.0.1')
        videoSock.setTimeout(3000)

        videoSock.on('connect', () => {
          videoSock.setTimeout(0)
          this.adbSock = videoSock
          this.log('비디오 소켓 연결 성공')

          // 즉시 제어 소켓 연결 시도
          const controlSock = net.connect(this.forwardPort, '127.0.0.1')
          controlSock.setTimeout(3000)

          controlSock.on('connect', () => {
            controlSock.setTimeout(0)
            this.controlSock = controlSock
            this.log('제어 소켓 연결 성공')

            this._pipe(videoSock)
            res()
          })

          const controlFail = e => {
            this.log(`제어 소켓 연결 실패: ${e?.message}`)
            controlSock.destroy()
            videoSock.destroy()
            if (!this.running) { rej(new Error('stopped')); return }
            if (n < maxTries) setTimeout(attempt, delay)
            else rej(new Error(`제어 소켓 ${maxTries}회 연결 실패: ${e?.message}`))
          }
          controlSock.on('error', controlFail)
          controlSock.on('timeout', () => controlFail(new Error('timeout')))
        })

        const fail = e => {
          videoSock.destroy()
          if (!this.running) { rej(new Error('stopped')); return }
          if (n < maxTries) setTimeout(attempt, delay)
          else rej(new Error(`비디오 소켓 ${maxTries}회 연결 실패: ${e?.message}`))
        }
        videoSock.on('error', fail)
        videoSock.on('timeout', () => fail(new Error('timeout')))
      }
      attempt()
    })
  }

  // ── v4.0 프로토콜 파싱 (send_frame_meta=true) → WebSocket 전송 ─────────────────────
  //
  // 헤더 구조 (실측 분석, SM-G991N / Android 15):
  //   deviceName  : 65 bytes (UTF-8, null-padded  ← v4.0 변경: 64 + 1 byte separator)
  //   codec_id    : 4 bytes  uint32 BE  (0x68323634 = "h264")
  //   flags       : 4 bytes  uint32 BE  ← session_meta 선두 (무시)
  //   width       : 4 bytes  uint32 BE  (offset 4)
  //   height      : 4 bytes  uint32 BE  (offset 8)
  //   → SESSION_META_LEN = 12 bytes
  //
  // 이후 프레임 (send_frame_meta=true):
  //   pts         : 8 bytes  int64 BE   (pts=0x4000... 등, config 패킷은 pts 특수값)
  //   size        : 4 bytes  uint32 BE
  //   data        : size bytes (H.264 access unit, Annex B 포맷)
  //
  _pipe(sock) {
    let state = 'deviceName'
    let buf = Buffer.alloc(0)
    let pendingFrameSize = 0
    const meta = {}

    // ── scrcpy v4.0 프로토콜 헤더 상수 ──────────────────────────────────
    // 실측 데이터 분석 결과:
    //   누적 65B 후 코덱(h264) 4B 수신 → device name field = 65 bytes
    //   session_meta = flags(4) + width(4) + height(4) = 12 bytes
    const DEVICE_NAME_LEN = 65   // v4.0: 64 bytes name + 1 byte separator
    const CODEC_ID_LEN = 4
    const SESSION_META_LEN = 12   // flags(4) + width(4) + height(4)
    const FRAME_HEADER_LEN = 12   // pts(8) + size(4)

    let totalReceived = 0

    sock.on('data', chunk => {
      totalReceived += chunk.length
      if (totalReceived <= 160) {
        this.log(`[raw] 수신 ${chunk.length}B (누적 ${totalReceived}B): ${chunk.slice(0, Math.min(20, chunk.length)).toString('hex')}`)
      }
      buf = Buffer.concat([buf, chunk])
      let go = true

      while (go) {
        switch (state) {

          case 'deviceName': {
            if (buf.length < DEVICE_NAME_LEN) { go = false; break }
            meta.deviceName = buf.subarray(0, DEVICE_NAME_LEN)
              .toString('utf8').replace(/\0/g, '').trim()
            this.log(`기기 이름: "${meta.deviceName}"`)
            buf = buf.subarray(DEVICE_NAME_LEN)
            state = 'codecId'
            break
          }

          case 'codecId': {
            if (buf.length < CODEC_ID_LEN) { go = false; break }
            const codecId = buf.readUInt32BE(0)
            meta.codec = codecId === H264_CODEC_ID ? 'h264' : `0x${codecId.toString(16)}`
            this.log(`코덱: ${meta.codec} (0x${codecId.toString(16)})`)
            buf = buf.subarray(CODEC_ID_LEN)
            state = 'sessionMeta'
            break
          }

          case 'sessionMeta': {
            if (buf.length < SESSION_META_LEN) { go = false; break }
            // session_meta = flags(4) + width(4) + height(4)
            // flags는 사용하지 않으므로 offset 4, 8에서 width/height 읽기
            meta.width = buf.readUInt32BE(4)
            meta.height = buf.readUInt32BE(8)
            this.log(`해상도: ${meta.width}×${meta.height}`)
            buf = buf.subarray(SESSION_META_LEN)
            state = 'frameHeader'
            this._metaJson = JSON.stringify({ type: 'meta', ...meta })
            this._frameCnt = 0
            this._wsSend(this._metaJson)
            break
          }

          case 'frameHeader': {
            if (buf.length < FRAME_HEADER_LEN) { go = false; break }
            // pts: int64 BE — BigInt으로 읽음 (pts=-1 이면 config 패킷)
            // const pts = buf.readBigInt64BE(0)  ← 사용하지 않으나 구조상 존재
            pendingFrameSize = buf.readUInt32BE(8)
            buf = buf.subarray(FRAME_HEADER_LEN)
            state = 'frameData'
            break
          }

          case 'frameData': {
            if (buf.length < pendingFrameSize) { go = false; break }
            // 완전한 H.264 access unit을 그대로 WS 클라이언트에 전송
            const frame = buf.subarray(0, pendingFrameSize)
            this._wsSend(Buffer.from(frame), true)
            this._frameCnt++
            if (this._frameCnt <= 5 || this._frameCnt % 30 === 0) {
              this.log(`프레임 #${this._frameCnt}: ${pendingFrameSize}B → WS client=${this.wsClient ? '연결됨' : '없음'}`)
            }
            buf = buf.subarray(pendingFrameSize)
            pendingFrameSize = 0
            state = 'frameHeader'
            break
          }

          default:
            go = false
        }
      }
    })

    sock.on('error', e => {
      this.log(`소켓 오류 (수신 누적 ${totalReceived}B): ${e.message}`)
      this._wsSend(JSON.stringify({ type: 'stopped', error: e.message }))
    })
    sock.on('close', () => {
      this.log(`소켓 종료 — 총 수신: ${totalReceived}B / 파싱 상태: ${state} / 서버 생존: ${this.srvProc != null && !this.srvProc.killed}`)
      if (this.running) this._wsSend(JSON.stringify({ type: 'stopped' }))
    })
  }

  // ── WebSocket 전송 ───────────────────────────────────────────
  _wsSend(data, binary = false) {
    const ws = this.wsClient
    if (!ws || ws.readyState !== 1) {
      if (!binary && this._frameCnt === 0) {
        this.log(`⚠ WS 전송 실패 (client=${ws ? 'state=' + ws.readyState : '없음'}): ${typeof data === 'string' ? data.slice(0, 80) : data.length + 'B binary'}`)
      }
      return
    }
    try { binary ? ws.send(data, { binary: true }) : ws.send(data) } catch (e) {
      this.log(`⚠ WS send 예외: ${e.message}`)
    }
  }

  injectTouch({ action, x, y, screenWidth, screenHeight }) {
    if (!this.controlSock || this.controlSock.destroyed) return

    const buf = Buffer.alloc(32)
    buf.writeUInt8(2, 0) // TYPE_INJECT_TOUCH_EVENT = 2
    buf.writeUInt8(action, 1) // action
    buf.writeBigInt64BE(-1n, 2) // pointerId
    buf.writeInt32BE(x, 10)
    buf.writeInt32BE(y, 14)
    buf.writeUInt16BE(screenWidth, 18)
    buf.writeUInt16BE(screenHeight, 20)
    buf.writeUInt16BE(action === 1 ? 0 : 0xffff, 22) // pressure
    buf.writeInt32BE(0, 24) // actionButton
    buf.writeInt32BE(action === 1 ? 0 : 1, 28) // buttons

    try {
      this.controlSock.write(buf)
    } catch (e) {
      this.log('터치 이벤트 전송 실패: ' + e.message)
    }
  }

  injectKeycode({ action, keycode }) {
    if (!this.controlSock || this.controlSock.destroyed) return

    const buf = Buffer.alloc(14)
    buf.writeUInt8(0, 0) // TYPE_INJECT_KEYCODE = 0
    buf.writeUInt8(action, 1) // action: 0=DOWN, 1=UP
    buf.writeInt32BE(keycode, 2)
    buf.writeInt32BE(0, 6) // repeat
    buf.writeInt32BE(0, 10) // metaState

    try {
      this.controlSock.write(buf)
    } catch (e) {
      this.log('키코드 이벤트 전송 실패: ' + e.message)
    }
  }

  injectText({ text }) {
    if (!this.controlSock || this.controlSock.destroyed) return

    const textBytes = Buffer.from(text, 'utf8')
    // TYPE_SET_CLIPBOARD = 9
    // sequence: 8 bytes (0n)
    // paste: 1 byte (1 = true)
    // length: 4 bytes
    // text: variable
    const buf = Buffer.alloc(14 + textBytes.length)
    buf.writeUInt8(9, 0) // TYPE_SET_CLIPBOARD = 9
    buf.writeBigInt64BE(0n, 1) // sequence: 0
    buf.writeUInt8(1, 9) // paste: true
    buf.writeUInt32BE(textBytes.length, 10) // length
    textBytes.copy(buf, 14) // text

    try {
      this.controlSock.write(buf)
    } catch (e) {
      this.log('텍스트 이벤트 전송 실패: ' + e.message)
    }
  }

  _jarVer(p) {
    const m = (p || '').match(/v?(\d+\.\d+(?:\.\d+)?)/)
    return m ? m[1] : null
  }

  // ── 중지 ─────────────────────────────────────────────────────
  async stop() {
    this.running = false
    this.adbSock?.destroy(); this.adbSock = null
    this.controlSock?.destroy(); this.controlSock = null
    this.srvProc?.kill(); this.srvProc = null
    if (this.serial && this.forwardPort) {
      await this.adb(['-s', this.serial, 'forward', '--remove', `tcp:${this.forwardPort}`]).catch(() => { })
      this.serial = null
      this.forwardPort = null
    }
    this.log('중지됨')
  }

  destroy() {
    this.stop()
    this.wss?.close(); this.wss = null
  }
}

module.exports = MirrorBridge
