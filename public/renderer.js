// ── 전역 상태 ──────────────────────────────────────────────────
const state = {
  serial: null,
  model: null,
  mirroring: false,
  recording: false,
  timerInterval: null,
  activityInterval: null,
  currentActivityName: null,
  seconds: 0,
  maxSize: 1280,
}

// ── 유틸 ───────────────────────────────────────────────────────
function $(id) { return document.getElementById(id) }

function showToast(msg, isError = false) {
  $('toastMsg').textContent = msg
  $('toastIcon').className = isError ? 'ti ti-alert-circle' : 'ti ti-check'
  $('toastIcon').style.color = isError ? 'var(--red)' : 'var(--accent2)'
  const t = $('toast')
  t.classList.add('show')
  clearTimeout(t._timeout)
  t._timeout = setTimeout(() => t.classList.remove('show'), 2400)
}

function requireDevice() {
  if (!state.serial) { showToast('기기를 먼저 연결해 주세요', true); return false }
  return true
}

// ── 페이지 전환 ────────────────────────────────────────────────
function switchPage(id, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
  $('page-' + id).classList.add('active')
  el.classList.add('active')
}

// ── 모달 ───────────────────────────────────────────────────────
function openConnectModal() {
  $('connectOverlay').classList.add('open')
  refreshDevices()
}
function closeModal() { $('connectOverlay').classList.remove('open') }
$('connectOverlay').addEventListener('click', e => { if (e.target === $('connectOverlay')) closeModal() })

function setTab(el, tab) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'))
  el.classList.add('active')
  $('usbTab').style.display  = tab === 'usb'  ? 'block' : 'none'
  $('wifiTab').style.display = tab === 'wifi' ? 'block' : 'none'
}

// ── 기기 목록 ──────────────────────────────────────────────────
async function refreshDevices() {
  const list = $('deviceList')
  list.innerHTML = '<p style="font-size:13px;color:var(--muted);text-align:center;padding:16px">검색 중...</p>'
  const devices = await window.db.getDevices()
  if (!devices.length) {
    list.innerHTML = '<p style="font-size:13px;color:var(--muted);text-align:center;padding:16px">연결된 기기가 없습니다</p>'
    return
  }
  list.innerHTML = ''
  devices.forEach(d => {
    const item = document.createElement('div')
    item.className = 'device-item'
    item.innerHTML = `<i class="ti ti-device-mobile"></i>
      <div class="device-item-info">${d.model}<span>${d.serial} · ${d.product}</span></div>
      <i class="ti ti-chevron-right" style="color:var(--muted)"></i>`
    item.onclick = () => selectDevice(d)
    list.appendChild(item)
  })
}

function selectDevice(d) {
  state.serial = d.serial
  state.model  = d.model
  closeModal()
  setConnected(d.model)
}

function setConnected(name) {
  const badge = $('connBadge')
  badge.className = 'conn-badge connected'
  $('connText').textContent = name
  $('statusText').textContent = '연결됨'
  $('statusText').style.color = 'var(--accent2)'
  $('deviceText').textContent = name
  $('bitrateText').textContent = document.getElementById('defBitrate')?.value + ' Mbps' || '8 Mbps'
  $('phoneIcon').className = 'ti ti-device-mobile'
  $('phoneMsg').textContent = '미러링 시작 버튼을 눌러주세요'
  showToast(name + ' 연결됨')
  startActivityPolling()
}

// ── 현재 화면(Activity) 조회 ───────────────────────────────────
function startActivityPolling() {
  stopActivityPolling()
  state.activityInterval = setInterval(async () => {
    if (!state.serial) return
    const r = await window.db.getCurrentActivity(state.serial)
    const el = $('activityText')
    const headerText = $('headerActivityText')
    if (el) {
      if (r.ok) {
        el.textContent = r.activity
        el.title = r.activity
        state.currentActivityName = r.activity
        if (headerText) headerText.textContent = r.activity
      } else {
        el.textContent = '—'
        el.title = '—'
        state.currentActivityName = null
        if (headerText) headerText.textContent = '—'
      }
    }
  }, 2000)
}

function stopActivityPolling() {
  if (state.activityInterval) {
    clearInterval(state.activityInterval)
    state.activityInterval = null
  }
  const el = $('activityText')
  if (el) {
    el.textContent = '—'
    el.title = '—'
  }
  state.currentActivityName = null
  const headerText = $('headerActivityText')
  if (headerText) headerText.textContent = '—'
}

// ── 상세 정보 모달 ──────────────────────────────────────────────
async function showActivityInfo() {
  if (!state.currentActivityName || !state.serial) return
  $('activityModalSubtitle').textContent = state.currentActivityName
  $('activityInfoContent').textContent = '정보를 불러오는 중입니다...'
  $('activityInfoOverlay').classList.add('open')

  const r = await window.db.getActivityInfo(state.serial, state.currentActivityName)
  if (r.ok) {
    $('activityInfoContent').textContent = r.info || '정보가 없습니다.'
  } else {
    $('activityInfoContent').textContent = '정보 불러오기 실패:\n' + r.message
  }
}

function closeActivityModal() {
  $('activityInfoOverlay').classList.remove('open')
}

// ── Wi-Fi 연결 ─────────────────────────────────────────────────
async function connectWifi() {
  const ip   = $('ipInput').value.trim()
  const port = $('portInput').value || 5555
  if (!ip) { showToast('IP 주소를 입력하세요', true); return }
  $('connBadge').className = 'conn-badge searching'
  $('connText').textContent = '연결 중...'
  const r = await window.db.connect(ip, parseInt(port))
  if (r.ok) {
    state.serial = `${ip}:${port}`
    state.model  = ip
    closeModal()
    setConnected(ip)
  } else {
    $('connBadge').className = 'conn-badge disconnected'
    $('connText').textContent = '연결되지 않음'
    showToast('연결 실패: ' + r.message, true)
  }
}

function wifiQuickConnect() {
  openConnectModal()
  // Wi-Fi 탭으로 자동 전환
  setTimeout(() => {
    document.querySelectorAll('.modal-tab')[1].click()
  }, 50)
}

// ── 미러링 ─────────────────────────────────────────────────────
// ── 미러링 (WebCodecs + WebSocket) ────────────────────────────
let mirrorWs    = null   // WebSocket → bridge
let videoDecoder = null  // WebCodecs VideoDecoder

function getMirrorCanvas() {
  let c = document.getElementById('mirrorCanvas')
  if (!c) {
    // 캔버스를 phone-screen 안에 동적으로 생성
    const screen = document.getElementById('phoneScreen')
    screen.innerHTML = ''
    c = document.createElement('canvas')
    c.id = 'mirrorCanvas'
    c.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:18px;background:#000;cursor:pointer'
    
    // 숨겨진 키보드 입력용 textarea 생성
    const input = document.createElement('textarea')
    input.id = 'mirrorInput'
    input.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:0;height:0;opacity:0'
    screen.appendChild(input)

    // 마우스 제어 및 키보드 제어 이벤트 바인딩
    setupCanvasEvents(c, input)
    
    screen.appendChild(c)
  }
  return c
}

function setupCanvasEvents(canvas, input) {
  let isDown = false

  const sendTouchEvent = (action, e) => {
    if (!state.mirroring || !mirrorWs || mirrorWs.readyState !== 1) return

    const rect = canvas.getBoundingClientRect()
    const clientX = e.clientX - rect.left
    const clientY = e.clientY - rect.top

    const cw = rect.width
    const ch = rect.height
    const vw = canvas.width
    const vh = canvas.height

    if (cw === 0 || ch === 0 || vw === 0 || vh === 0) return

    const vr = vw / vh
    const er = cw / ch

    let dx = 0
    let dy = 0
    let scale = 1

    if (er > vr) {
      // Pillarbox (좌우 레터박스)
      const displayedWidth = ch * vr
      dx = (cw - displayedWidth) / 2
      dy = 0
      scale = vh / ch
    } else {
      // Letterbox (상하 레터박스)
      const displayedHeight = cw / vr
      dx = 0
      dy = (ch - displayedHeight) / 2
      scale = vw / cw
    }

    // 좌표 환산
    const x = Math.round((clientX - dx) * scale)
    const y = Math.round((clientY - dy) * scale)

    // 유효 범위 검사 후 WebSocket 전송
    if (x >= 0 && x < vw && y >= 0 && y < vh) {
      mirrorWs.send(JSON.stringify({
        type: 'touch',
        action,
        x,
        y,
        screenWidth: vw,
        screenHeight: vh
      }))
    }
  }

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return // 마우스 좌클릭만 처리
    isDown = true
    if (input) input.focus()
    sendTouchEvent(0, e) // 0 = DOWN
  })

  canvas.addEventListener('mousemove', e => {
    if (!isDown) return
    sendTouchEvent(2, e) // 2 = MOVE
  })

  canvas.addEventListener('mouseup', e => {
    if (!isDown) return
    isDown = false
    sendTouchEvent(1, e) // 1 = UP
  })

  canvas.addEventListener('mouseleave', e => {
    if (!isDown) return
    isDown = false
    sendTouchEvent(1, e) // 1 = UP
  })

  canvas.addEventListener('click', () => {
    if (input) input.focus()
  })

  // ── 키보드 입력 매핑 및 전송 ────────────────────────────
  if (!input) return

  const KEYCODE_MAP = {
    'Backspace': 67,
    'Enter': 66,
    'ArrowLeft': 21,
    'ArrowRight': 22,
    'ArrowUp': 19,
    'ArrowDown': 20,
    'Delete': 112,
    'Tab': 61,
    'Escape': 111,
    'Home': 122,
    'End': 123,
    'PageUp': 92,
    'PageDown': 93
  }

  let prevText = ''

  input.addEventListener('keydown', e => {
    if (e.isComposing) return

    const keycode = KEYCODE_MAP[e.key]
    if (keycode !== undefined) {
      e.preventDefault()
      mirrorWs.send(JSON.stringify({ type: 'keycode', action: 0, keycode })) // DOWN
      if (e.key === 'Backspace' || e.key === 'Enter') {
        input.value = ''
        prevText = ''
      }
    }
  })

  input.addEventListener('keyup', e => {
    if (e.isComposing) return

    const keycode = KEYCODE_MAP[e.key]
    if (keycode !== undefined) {
      e.preventDefault()
      mirrorWs.send(JSON.stringify({ type: 'keycode', action: 1, keycode })) // UP
    }
  })

  input.addEventListener('input', e => {
    const currText = input.value
    
    // 조립(Composition) 중인 경우 마지막 글자는 아직 조립 중이므로 제외한 부분만 확정(finalized)으로 간주
    let finalized = ''
    if (e.isComposing) {
      if (currText.length > 1) {
        finalized = currText.substring(0, currText.length - 1)
      } else {
        finalized = ''
      }
    } else {
      finalized = currText
    }

    // 확정된 문자열이 이전 베이스라인(prevText)보다 늘어났을 때만 Android로 전송 (불필요한 지우기/쓰기 반복 제거)
    if (finalized.startsWith(prevText)) {
      const insertText = finalized.substring(prevText.length)
      if (insertText.length > 0) {
        mirrorWs.send(JSON.stringify({ type: 'text', text: insertText }))
        prevText = finalized
      }
    }

    // 조립이 완전히 종료된 영문/숫자/입력 완료 단계에서는 입력창과 베이스라인을 비워줌
    if (!e.isComposing) {
      input.value = ''
      prevText = ''
    }
  })

  input.addEventListener('compositionend', e => {
    const currText = input.value
    if (currText.startsWith(prevText)) {
      const insertText = currText.substring(prevText.length)
      if (insertText.length > 0) {
        mirrorWs.send(JSON.stringify({ type: 'text', text: insertText }))
      }
    }
    input.value = ''
    prevText = ''
  })
}

function resetPhoneScreen() {
  const screen = document.getElementById('phoneScreen')
  if (!screen) return
  screen.innerHTML = `
    <div class="phone-notch"></div>
    <i class="ti ti-device-mobile-off" id="phoneIcon"></i>
    <p id="phoneMsg">${state.serial ? '미러링 시작 버튼을 눌러주세요' : '기기를 연결해 주세요'}</p>
    <div class="phone-home"></div>`
}

// ── 로그 유틸 ──────────────────────────────────────────────────
function copyMirrorLog() {
  const el = document.getElementById('scrcpyLog')
  const text = el ? el.textContent : ''
  if (!text.trim()) { showToast('복사할 로그가 없습니다', true); return }

  // Electron / Chromium: navigator.clipboard 사용
  navigator.clipboard.writeText(text)
    .then(() => {
      showToast('로그가 클립보드에 복사되었습니다 ✓')
      const btn = document.getElementById('logCopyBtn')
      if (btn) {
        const orig = btn.innerHTML
        btn.innerHTML = '<i class="ti ti-check" style="font-size:11px;color:var(--accent2)"></i> 복사됨'
        setTimeout(() => { btn.innerHTML = orig }, 1500)
      }
    })
    .catch(() => {
      // 폴백: 텍스트 선택
      const range = document.createRange()
      range.selectNodeContents(el)
      window.getSelection().removeAllRanges()
      window.getSelection().addRange(range)
      showToast('Ctrl+C 로 복사하세요')
    })
}

function clearMirrorLog() {
  const el = document.getElementById('scrcpyLog')
  if (el) el.textContent = ''
}

function stopDecoder() {
  if (videoDecoder && videoDecoder.state !== 'closed') {
    try { videoDecoder.close() } catch {}
  }
  videoDecoder = null
  // WebSocket은 여기서 닫지 않음 — stopMirror()에서만 닫음
}

function closeMirrorWs() {
  if (mirrorWs) { mirrorWs.close(); mirrorWs = null }
}

function initDecoder(canvas, width, height) {
  // 기존 디코더만 정리 (WS는 유지)
  stopDecoder()
  canvas.width  = width  || 1080
  canvas.height = height || 1920
  const ctx = canvas.getContext('2d')

  const logPanel = document.getElementById('scrcpyLog')
  const logToPanel = msg => {
    if (logPanel) { logPanel.textContent += msg + '\n'; logPanel.scrollTop = logPanel.scrollHeight }
  }

  let outputCount = 0

  videoDecoder = new VideoDecoder({
    output(frame) {
      outputCount++
      if (outputCount <= 3) logToPanel(`[decoder] 출력 프레임 #${outputCount}: ${frame.codedWidth}×${frame.codedHeight}`)
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
      frame.close()
    },
    error(e) {
      console.error('[mirror] VideoDecoder error:', e)
      logToPanel(`[decoder] ❌ 오류: ${e.message}`)
    }
  })

  // SPS에서 읽은 실제 프로파일: 67 64 00 20 → High Profile Level 3.2
  videoDecoder.configure({
    codec: 'avc1.640020',
    codedWidth:  canvas.width,
    codedHeight: canvas.height,
    optimizeForLatency: true,
  })
  logToPanel(`[decoder] 초기화: ${canvas.width}×${canvas.height}, codec=avc1.640020, state=${videoDecoder.state}`)
}

// ── 프레임 공급 (config 패킷 버퍼링) ─────────────────────────
// scrcpy send_frame_meta=true 시:
//   - 첫 패킷: SPS+PPS (config only, 29B 등)
//   - 이후: IDR 또는 P-frame
// VideoDecoder는 config만으로는 디코딩 불가 → SPS+PPS를 IDR 앞에 붙여야 함
let configNalBuffer = null  // SPS+PPS 바이트 캐시

function feedFrame(uint8) {
  if (!videoDecoder || videoDecoder.state === 'closed') return

  // NAL 유닛 스캔 → 어떤 NAL 유형이 있는지 파악
  let hasSPS = false, hasPPS = false, hasIDR = false, hasSlice = false
  let i = 0
  while (i < uint8.length - 4) {
    if (uint8[i] === 0 && uint8[i + 1] === 0) {
      let startLen = 0
      if (uint8[i + 2] === 0 && uint8[i + 3] === 1) startLen = 4
      else if (uint8[i + 2] === 1) startLen = 3

      if (startLen > 0 && i + startLen < uint8.length) {
        const nalType = uint8[i + startLen] & 0x1f
        if (nalType === 7) hasSPS = true
        if (nalType === 8) hasPPS = true
        if (nalType === 5) hasIDR = true
        if (nalType === 1) hasSlice = true
        i += startLen
        continue
      }
    }
    i++
  }

  // Config 전용 패킷 (SPS/PPS만, IDR 없음) → 버퍼에 저장, 디코더에 넣지 않음
  if ((hasSPS || hasPPS) && !hasIDR && !hasSlice) {
    configNalBuffer = new Uint8Array(uint8)
    const logEl = document.getElementById('scrcpyLog')
    if (logEl) { logEl.textContent += `[decoder] SPS+PPS 캐시 (${uint8.length}B)\n`; logEl.scrollTop = logEl.scrollHeight }
    return
  }

  // IDR 프레임이면 앞에 config(SPS+PPS) 붙이기
  let feedData = uint8
  if (hasIDR && configNalBuffer) {
    const merged = new Uint8Array(configNalBuffer.length + uint8.length)
    merged.set(configNalBuffer, 0)
    merged.set(uint8, configNalBuffer.length)
    feedData = merged
  }

  const isKey = hasIDR || hasSPS
  try {
    videoDecoder.decode(new EncodedVideoChunk({
      type:      isKey ? 'key' : 'delta',
      timestamp: performance.now() * 1000,
      data:      feedData,
    }))
  } catch (e) {
    const logEl = document.getElementById('scrcpyLog')
    if (logEl) { logEl.textContent += `[decoder] decode 예외: ${e.message}\n`; logEl.scrollTop = logEl.scrollHeight }
  }
}


function connectMirrorWs(canvas) {
  if (mirrorWs) { mirrorWs.close(); mirrorWs = null }

  // bridge가 준비될 때까지 재시도 (최대 10회, 600ms 간격)
  let attempts = 0
  const MAX = 10

  const logMirror = msg => {
    const el = document.getElementById('scrcpyLog')
    if (el) { el.textContent += '[renderer] ' + msg + '\n'; el.scrollTop = el.scrollHeight }
  }
  let wsFrameCount = 0

  const tryWs = () => {
    if (!state.mirroring) return
    logMirror(`WS 연결 시도 ${attempts + 1}/${MAX}...`)
    const ws = new WebSocket('ws://127.0.0.1:7183')
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      mirrorWs = ws
      wsFrameCount = 0
      logMirror('★ WS 연결 성공!')
    }

    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          logMirror('메타 수신: ' + e.data)
          if (msg.type === 'meta') {
            state.aspectRatio = msg.width / msg.height
            changeScreenSize(currentScreenWidth)
            initDecoder(canvas, msg.width, msg.height)
            document.getElementById('resText').textContent = `${msg.width}×${msg.height}`
            showToast(`미러링 중 — ${msg.width}×${msg.height}`)
          } else if (msg.type === 'stopped') {
            logMirror('서버측 스트리밍 종료 신호')
            stopDecoder()
            resetPhoneScreen()
            state.mirroring = false
            showToast('미러링이 종료되었습니다')
          }
        } catch (err) { logMirror('JSON 파싱 오류: ' + err.message) }
      } else {
        wsFrameCount++
        const arr = new Uint8Array(e.data)
        if (wsFrameCount <= 3) {
          logMirror(`프레임 #${wsFrameCount}: ${arr.length}B`)
        }
        feedFrame(arr)
      }
    }

    ws.onerror = (ev) => {
      logMirror(`WS onerror 발생 (시도 ${attempts + 1}/${MAX})`)
      ws.close()
      attempts++
      if (attempts < MAX) {
        setTimeout(tryWs, 600)
      } else {
        logMirror('WS 최대 재시도 초과 → 미러링 중단')
        showToast('미러링 연결 오류 — 로그를 확인해 주세요', true)
        state.mirroring = false
        resetPhoneScreen()
      }
    }

    ws.onclose = (ev) => {
      logMirror(`WS onclose (code=${ev.code}, reason=${ev.reason || 'none'}, 수신프레임=${wsFrameCount})`)
      mirrorWs = null
      if (state.mirroring) {
        state.mirroring = false
        resetPhoneScreen()
      }
    }
  }

  tryWs()
}

async function startMirror() {
  if (!requireDevice()) return
  if (state.mirroring) return

  const bitrate = parseInt(document.getElementById('defBitrate')?.value || 8)
  const fps     = parseInt(document.getElementById('defFps')?.value || 60)

  // 로그 패널 초기화
  const logEl = document.getElementById('scrcpyLog')
  if (logEl) logEl.textContent = '미러링 준비 중...\n'

  // IPC 로그 핸들러 등록 (중복 방지: preload의 removeAllListeners로 처리됨)
  window.db.onMirrorLog(msg => {
    const el = document.getElementById('scrcpyLog')
    if (!el) return
    el.textContent += msg + '\n'
    el.scrollTop = el.scrollHeight
  })

  state.mirroring = true
  const canvas = getMirrorCanvas()

  // WS 연결 시도 (bridge보다 먼저 시작 — retry로 버팀)
  connectMirrorWs(canvas)

  // bridge 시작 (jar 푸시 + 서버 실행 + 소켓 연결)
  const r = await window.db.startMirror({
    serial:       state.serial,
    videoBitrate: bitrate,
    maxSize:      state.maxSize || 0,
    fps,
  })

  if (!r.ok) {
    state.mirroring = false
    stopDecoder()
    resetPhoneScreen()
    if (logEl) logEl.textContent += '\n[ERROR] ' + (r.message || '알 수 없는 오류') + '\n'
    showToast('미러링 실패 — 로그 패널 확인', true)
    return
  }

  document.getElementById('statusText').textContent = '미러링 중'
  document.getElementById('statusText').style.color = 'var(--accent2)'
}

async function stopMirror() {
  stopDecoder()
  closeMirrorWs()
  configNalBuffer = null
  await window.db.stopMirror()
  state.mirroring = false
  resetPhoneScreen()
  document.getElementById('statusText').textContent = '연결됨'
  document.getElementById('statusText').style.color = 'var(--accent2)'
  showToast('미러링 중지됨')
}


function setQuality(el, label, size) {
  document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'))
  el.classList.add('active')
  state.maxSize = size
  showToast('화질: ' + label)
}

// ── 키 이벤트 ──────────────────────────────────────────────────
async function keyevent(code) {
  if (!requireDevice()) return
  const r = await window.db.keyevent({ serial: state.serial, keycode: code })
  if (!r.ok) showToast('키 전송 실패', true)
}

// ── 화면 캡처 ──────────────────────────────────────────────────
async function takeScreenshot() {
  if (!requireDevice()) return
  showToast('캡처 중...')
  const r = await window.db.screenshot(state.serial)
  if (r.ok) {
    showToast('저장 완료: ' + r.path)
    const res = $('captureResult')
    const msg = $('captureMsg')
    if (res) {
      res.style.display = 'block'
      msg.textContent = '저장됨: ' + r.path
      msg.style.color = 'var(--accent2)'
    }
  } else {
    showToast(r.message || '캡처 실패', true)
  }
}

// ── 화면 녹화 ──────────────────────────────────────────────────
async function toggleRecord() {
  if (!requireDevice()) return
  if (!state.recording) {
    const bitrate = parseInt($('recBitrate').value)
    const size    = $('recSize').value
    const r = await window.db.recordStart({ serial: state.serial, bitrate, size: size || null })
    if (!r.ok) { showToast('녹화 시작 실패', true); return }
    state.recording = true
    state.seconds = 0
    $('recordBtn').classList.add('recording')
    $('recordIcon').className = 'ti ti-player-stop'
    $('recordStatus').textContent = '녹화 중...'
    $('recordStatus').style.color = 'var(--red)'
    state.timerInterval = setInterval(() => {
      state.seconds++
      const h = Math.floor(state.seconds / 3600)
      const m = Math.floor((state.seconds % 3600) / 60)
      const s = state.seconds % 60
      $('timer').textContent = [h,m,s].map(n => String(n).padStart(2,'0')).join(':')
    }, 1000)
    showToast('녹화 시작됨')
  } else {
    clearInterval(state.timerInterval)
    state.recording = false
    $('recordBtn').classList.remove('recording')
    $('recordIcon').className = 'ti ti-player-record'
    $('recordStatus').textContent = '파일 저장 중...'
    $('recordStatus').style.color = 'var(--amber)'
    const r = await window.db.recordStop(state.serial)
    if (r.ok) {
      $('recordStatus').textContent = '저장 완료: ' + r.path
      $('recordStatus').style.color = 'var(--accent2)'
      showToast('녹화 파일 저장됨')
    } else {
      $('recordStatus').textContent = r.message || '저장 실패'
      $('recordStatus').style.color = 'var(--red)'
      showToast('저장 실패: ' + r.message, true)
    }
  }
}

// ── APK 설치 ───────────────────────────────────────────────────
async function openApkPicker() {
  if (!requireDevice()) return
  const paths = await window.db.openApkDialog()
  paths.forEach(p => installApk(p))
}

async function handleApkDrop(e) {
  e.preventDefault()
  $('dropZone').classList.remove('dragging')
  if (!requireDevice()) return
  const files = [...e.dataTransfer.files].filter(f => f.name.endsWith('.apk') || f.name.endsWith('.xapk'))
  files.forEach(f => installApk(f.path))
}

async function installApk(apkPath) {
  const name = apkPath.split(/[\\/]/).pop()
  const queue = $('installQueue')
  const fillId = 'fill_' + Date.now()
  const pctId  = 'pct_'  + Date.now()
  const item = document.createElement('div')
  item.className = 'install-item'
  item.innerHTML = `<i class="ti ti-package"></i>
    <div class="install-info"><p>${name}</p><span>설치 중...</span>
      <div class="progress-bar"><div class="progress-fill" id="${fillId}" style="width:5%"></div></div>
    </div><span class="install-status progress" id="${pctId}">설치 중</span>`
  queue.prepend(item)

  // 진행 바 애니메이션 (실제 진행률 adb는 제공 안 함)
  let pct = 5
  const iv = setInterval(() => {
    pct = Math.min(pct + Math.random() * 8, 90)
    const el = $(fillId)
    if (el) el.style.width = pct.toFixed(0) + '%'
  }, 400)

  const r = await window.db.install({ serial: state.serial, apkPath })
  clearInterval(iv)
  const fill = $(fillId); const pctEl = $(pctId)
  if (fill) fill.style.width = '100%'
  if (r.ok) {
    if (pctEl) { pctEl.textContent = '설치 완료'; pctEl.className = 'install-status done' }
    showToast(name + ' 설치 완료')
  } else {
    if (pctEl) { pctEl.textContent = '설치 실패'; pctEl.style.color = 'var(--red)' }
    showToast('설치 실패', true)
  }
}

// ── 파일 전송 ──────────────────────────────────────────────────
async function pushFileDialog() {
  if (!requireDevice()) return
  const paths = await window.db.openFileDialog()
  if (!paths || !paths.length) return
  for (const localPath of paths) {
    const name       = localPath.split(/[\\/]/).pop()
    const remotePath = '/sdcard/Download/' + name
    const r = await window.db.pushFile({ serial: state.serial, localPath, remotePath })
    addFileQueueItem(name, r.ok)
  }
}

async function pullFileDialog() {
  if (!requireDevice()) return
  const remotePath = prompt('Android 경로를 입력하세요 (예: /sdcard/DCIM/photo.jpg)')
  if (!remotePath) return
  const r = await window.db.pullFile({ serial: state.serial, remotePath })
  if (r.ok) showToast('저장 완료: ' + r.path)
  else showToast('가져오기 실패', true)
}

async function handleFileDrop(e) {
  e.preventDefault()
  if (!requireDevice()) return
  const files = [...e.dataTransfer.files]
  for (const f of files) {
    const r = await window.db.pushFile({
      serial: state.serial,
      localPath: f.path,
      remotePath: '/sdcard/Download/' + f.name,
    })
    addFileQueueItem(f.name, r.ok)
  }
}

function addFileQueueItem(name, ok) {
  const queue = $('fileQueue')
  const item = document.createElement('div')
  item.className = 'install-item'
  item.innerHTML = `<i class="ti ti-file" style="color:var(--accent2)"></i>
    <div class="install-info"><p>${name}</p><span>/sdcard/Download/</span>
      <div class="progress-bar"><div class="progress-fill" style="width:100%"></div></div>
    </div><span class="install-status ${ok ? 'done' : ''}" style="${ok ? '' : 'color:var(--red)'}">${ok ? '전송 완료' : '실패'}</span>`
  queue.prepend(item)
  showToast(ok ? name + ' 전송 완료' : '전송 실패', !ok)
}

// ── 클립보드 ───────────────────────────────────────────────────
async function sendClipboard() {
  if (!requireDevice()) return
  const text = $('pcText').value.trim()
  if (!text) { showToast('텍스트를 입력하세요', true); return }
  const r = await window.db.clipboardSend({ serial: state.serial, text })
  if (r.ok) showToast('전송 완료')
  else showToast('전송 실패 (Clipper 앱 필요)', true)
}

async function fetchClipboard() {
  if (!requireDevice()) return
  const r = await window.db.clipboardGet(state.serial)
  if (r.ok) { $('androidText').value = r.text; showToast('가져오기 완료') }
  else showToast('가져오기 실패 (Clipper 앱 필요)', true)
}

let currentScreenWidth = 260 // 기본 너비

function changeScreenSize(width) {
  currentScreenWidth = parseInt(width)
  const screen = document.getElementById('phoneScreen')
  if (!screen) return
  
  screen.style.width = currentScreenWidth + 'px'
  
  // 가로세로 비율 계산 (메타 데이터 없으면 기본 9:16.36)
  const aspect = state.aspectRatio || (9 / 16.36)
  const height = currentScreenWidth / aspect
  screen.style.height = Math.round(height) + 'px'
  
  const textEl = document.getElementById('screenSizeText')
  if (textEl) textEl.textContent = currentScreenWidth + 'px'
  localStorage.setItem('db_screen_width', currentScreenWidth)
}

// ── 설정 ───────────────────────────────────────────────────────
function saveSettings() {
  localStorage.setItem('db_bitrate', $('defBitrate').value)
  localStorage.setItem('db_fps', $('defFps').value)
  showToast('설정이 저장되었습니다')
}

function loadSettings() {
  const b = localStorage.getItem('db_bitrate')
  const f = localStorage.getItem('db_fps')
  if (b) $('defBitrate').value = b
  if (f) $('defFps').value = f

  const w = localStorage.getItem('db_screen_width')
  if (w) {
    currentScreenWidth = parseInt(w)
    const slider = $('screenSizeSlider')
    if (slider) slider.value = currentScreenWidth
  }
  changeScreenSize(currentScreenWidth)
}

loadSettings()

// ── 세팅 자동 점검 ──────────────────────────────────────────────
async function runSetupCheck() {
  const r = await window.db.setupCheck()
  const banner = $('setupBanner')
  const issues = []

  if (!r.adb.found) {
    issues.push(r.platform === 'win32'
      ? 'adb를 찾을 수 없습니다 — 폴더 내의 <b>Windows에서_시작.bat</b>을 실행하면 자동으로 설치됩니다'
      : 'adb를 찾을 수 없습니다 — 폴더 내의 <b>Mac_Linux에서_시작.command</b>를 실행하면 자동으로 설치됩니다')
  }
  if (!r.scrcpy.found) {
    issues.push(r.platform === 'win32'
      ? 'scrcpy를 찾을 수 없습니다 — 폴더 내의 <b>Windows에서_시작.bat</b>을 실행하면 자동으로 설치됩니다'
      : 'scrcpy를 찾을 수 없습니다 — 폴더 내의 <b>Mac_Linux에서_시작.command</b>를 실행하면 자동으로 설치됩니다')
  }
  if (r.adb.found && r.deviceCount === 0) {
    issues.push('연결된 기기가 없습니다 — USB 연결 후 폰에서 "USB 디버깅 허용"을 눌러주세요 (Wi-Fi 연결도 가능)')
  }

  if (issues.length) {
    banner.style.display = 'block'
    $('setupIssues').innerHTML = issues.map(i => `<li>${i}</li>`).join('')
  } else {
    banner.style.display = 'none'
    if (r.scrcpy.version) console.log('setup ok:', r.adb.version, '/', r.scrcpy.version)
  }
}

runSetupCheck()
setInterval(runSetupCheck, 5000) // 기기 연결/해제 자동 반영
