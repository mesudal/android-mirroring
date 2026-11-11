// ── 전역 상태 ──────────────────────────────────────────────────
function createDeviceState(slot) {
  return {
    slot,
    panel: null,
    serial: null,
    model: null,
    viewRot: 0,
    mirroring: false,
    recording: false,
    screenOff: false,
    viewBrightness: 100,
    recordBusy: false,
    timerInterval: null,
    activityInterval: null,
    currentActivityName: null,
    currentPkg: null,
    currentPid: null,
    logcatPidFilter: null,
    deviceInfo: null,
    seconds: 0,
    maxSize: 1280,
    videoWidth: 0,
    videoHeight: 0,
    aspectRatio: 9 / 19.5,
    mirrorWs: null,
    videoDecoder: null,
    mirrorSession: 0,
    keyboardMode: 'clipboard',
    configNalBuffer: null,
    logcatInputPending: '',
    logcatRunning: false,
    logcatLines: [],
    logcatShown: [],
    logcatDirty: false,
    logcatLast: null,
    logcatMinLevel: 0,
    logcatPreset: '',
    lastIssueLines: [],
    logcatFont: parseInt(localStorage.getItem('db_logcat_font')) || 11,
    logcatEntryLast: null,
  }
}

const deviceSlots = [createDeviceState('A'), createDeviceState('B'), createDeviceState('C')]
let qaBadgesReady = false   // QA 대상 앱 목록을 받은 뒤 true (updateDevicePanels 참고)
let activeDevice = deviceSlots[0]
let mirrorLogListenerRegistered = false
let dualLogTab = 'mirror'
let dualLogDevice = 'all'
const allLogEntries = []

function createThirdDevicePanel() {
  const workspace = document.querySelector('.dual-workspace')
  const secondPanel = workspace?.querySelector('.device-panel[data-slot="B"]')
  if (!workspace || !secondPanel || workspace.querySelector('.device-panel[data-slot="C"]')) return
  const panel = secondPanel.cloneNode(true)
  panel.dataset.slot = 'C'
  panel.querySelector('strong').textContent = '기기 C'
  panel.querySelectorAll('[onclick], [ondrop], [oninput]').forEach(element => {
    for (const attribute of ['onclick', 'ondrop', 'oninput']) {
      const handler = element.getAttribute(attribute)
      if (handler) element.setAttribute(attribute, handler.replaceAll("'B'", "'C'"))
    }
  })
  const screen = panel.querySelector('[data-role="phoneScreen"]')
  if (screen) screen.dataset.slot = 'C'
  workspace.insertBefore(panel, workspace.querySelector('.dual-log-resize'))
}

createThirdDevicePanel()

function bindSlotProperty(name, property = name) {
  Object.defineProperty(window, name, {
    configurable: true,
    get: () => activeDevice[property],
    set: value => { activeDevice[property] = value },
  })
}

for (const name of [
  'mirrorWs', 'videoDecoder', 'mirrorSession', 'keyboardMode', 'configNalBuffer',
  'currentPkg', 'currentPid', 'logcatPidFilter', 'deviceInfo', 'lastIssueLines',
  'logcatLines', 'logcatShown', 'logcatDirty', 'logcatLast', 'logcatMinLevel',
  'logcatPreset', 'logcatRunning',
  'logcatFont',
]) bindSlotProperty(name)
bindSlotProperty('logcatPending', 'logcatInputPending')

const state = new Proxy({}, {
  get: (_, key) => activeDevice[key],
  set: (_, key, value) => { activeDevice[key] = value; return true },
})

// ── 보기 회전 ──────────────────────────────────────────────────
// 기기를 실제로 돌리지 않고 우리가 그리는 방향만 90°씩 바꾼다.
// (기기 회전은 앱이 세로 고정이면 거부당한다 — 삼성 런처가 그렇다. 실측으로 확인했다)
// rot: 0=원본, 1=우로 90°, 2=180°, 3=좌로 90°. 그리기 변환과 터치 역변환이 한 쌍이라
// 어긋나면 바로 터치가 깨지므로 둘을 붙여 둔다.
function rotTransform(rot, vw, vh) {
  // setTransform(a,b,c,d,e,f) 는 (x,y) → (ax+cy+e, bx+dy+f)
  if (rot === 1) return [0, 1, -1, 0, vh, 0]      // (x,y) → (vh-y, x)
  if (rot === 2) return [-1, 0, 0, -1, vw, vh]    // (x,y) → (vw-x, vh-y)
  if (rot === 3) return [0, -1, 1, 0, 0, vw]      // (x,y) → (y, vw-x)
  return null
}

// 캔버스 좌표 → 기기 좌표. rotTransform 의 역변환이다. dw/dh 는 기기 해상도.
function unrotate(rot, cx, cy, dw, dh) {
  if (rot === 1) return [cy, dh - 1 - cx]
  if (rot === 2) return [dw - 1 - cx, dh - 1 - cy]
  if (rot === 3) return [dw - 1 - cy, cx]
  return [cx, cy]
}

// ── 유틸 ───────────────────────────────────────────────────────
function $(id) {
  const scoped = activeDevice?.panel?.querySelector(`[data-role="${id}"]`)
  return scoped || document.getElementById(id)
}

function slotElement(device, role) {
  return device?.panel?.querySelector(`[data-role="${role}"]`) || null
}

deviceSlots.forEach(device => {
  device.panel = document.querySelector(`.device-panel[data-slot="${device.slot}"]`)
  device.panel?.addEventListener('pointerdown', () => activateSlot(device.slot), true)
})

function updateDevicePanels() {
  const connected = deviceSlots.filter(device => device.serial)
  const visible = connected.length ? connected : [deviceSlots[0]]
  deviceSlots.forEach(device => {
    if (device.panel) device.panel.style.display = visible.includes(device) ? 'flex' : 'none'
    const disconnectButton = slotElement(device, 'slotDisconnectButton')
    if (disconnectButton) disconnectButton.hidden = !device.serial
  })
  const workspace = document.querySelector('.dual-workspace')
  if (workspace) workspace.style.setProperty('--device-count', visible.length)
  const addButton = document.getElementById('deviceAddButton')
  if (addButton) {
    const full = deviceSlots.every(device => device.serial)
    addButton.disabled = full
    addButton.title = full ? '최대 3대까지 연결할 수 있습니다' : '연결할 Android 기기를 추가합니다'
  }
  // QA 앱 상태는 아래쪽에서 let 으로 선언된다. 이 함수는 스크립트 로드 중에도 불리므로
  // 그때 건드리면 TDZ 예외로 스크립트 전체가 죽는다 — 앱 목록을 받은 뒤에만 그린다.
  if (qaBadgesReady) renderQaAppBadges()
}

function addDevicePanel() {
  const next = deviceSlots.find(device => !device.serial)
  if (!next) {
    showToast('동시에 최대 3대까지 연결할 수 있습니다', true)
    return
  }
  activateSlot(next.slot)
  openConnectModal()
}

updateDevicePanels()

function activateSlot(slot) {
  const target = deviceSlots.find(device => device.slot === slot)
  if (!target) return
  activeDevice = target
  document.querySelectorAll('.device-panel').forEach(panel =>
    panel.classList.toggle('active', panel.dataset.slot === slot))
  const toggle = document.getElementById('logcatToggle')
  if (toggle) {
    toggle.innerHTML = target.logcatRunning
      ? '<i class="ti ti-player-stop"></i>'
      : '<i class="ti ti-player-play"></i>'
    toggle.title = target.logcatRunning ? '로그 중지' : '로그 시작'
  }
  const level = document.getElementById('logcatLevel')
  if (level) level.value = String(target.logcatMinLevel)
  const preset = document.getElementById('logcatPreset')
  if (preset) preset.value = target.logcatPreset
  updateLogFilterBtn()
  renderLogcat()
}

function withActiveDevice(device, callback) {
  const previous = activeDevice
  activeDevice = device
  try { return callback() } finally { activeDevice = previous }
}

// 요소가 없어도(주석처리·레이아웃 변경) 죽지 않는 설정자. renderer.js 는 클래식
// 스크립트 한 덩어리라 한 곳에서 예외가 나면 그 뒤 핸들러가 통째로 죽는다.
function setText(id, text, color) {
  const el = $(id)
  if (!el) return
  el.textContent = text
  if (color) el.style.color = color
}

// 미러링 로그 패널에 한 줄 남긴다 (브리지 로그와 같은 자리)
function mirrorLog(msg) {
  const el = $('scrcpyLog')
  if (!el) return
  el.textContent += `[기기 ${activeDevice.slot}] ${msg}\n`
  el.scrollTop = el.scrollHeight
}

function setClass(id, cls) {
  const el = $(id)
  if (el) el.className = cls
}

// sticky=true 면 다음 showToast 가 덮어쓸 때까지 남는다. 설치처럼 수십 초 걸리는
// 작업에서 "먹통인가?" 싶은 공백을 없애려는 용도다.
function showToast(msg, isError = false, sticky = false) {
  const dual = document.getElementById('dualToast')
  if (dual) {
    dual.textContent = msg
    dual.classList.toggle('error', isError)
    dual.classList.add('show')
    clearTimeout(dual._timeout)
    if (!sticky) dual._timeout = setTimeout(() => dual.classList.remove('show'), msg.length > 60 ? 8000 : 2400)
    return
  }
  $('toastMsg').textContent = msg
  const icon = $('toastIcon')
  icon.className = sticky ? 'ti ti-package toast-busy'
    : isError ? 'ti ti-alert-circle' : 'ti ti-check'
  icon.style.color = sticky ? 'var(--accent)'
    : isError ? 'var(--red)' : 'var(--accent2)'
  const t = $('toast')
  t.classList.add('show')
  clearTimeout(t._timeout)
  // 긴 안내문(원인 설명 등)은 2.4초로는 못 읽는다
  if (!sticky) t._timeout = setTimeout(() => t.classList.remove('show'), msg.length > 60 ? 8000 : 2400)
}

function requireDevice() {
  if (!state.serial) { showToast('기기를 먼저 연결해 주세요', true); return false }
  return true
}

// ── 페이지 전환 ────────────────────────────────────────────────
// 사이드바가 사라지고 우측 패널의 탭이 그 역할을 한다
let currentPage = 'mirror'

function switchPage(id, el) {
  currentPage = id
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.tool-tab').forEach(n => n.classList.remove('active'))
  $('page-' + id)?.classList.add('active')
  el?.classList.add('active')
  updateConnToggle()   // 하단 버튼은 지금 보고 있는 탭의 역할을 맡는다
}

// ── QA 기기·앱 선택과 화면 요소 확인 ────────────────────────────
const QA_ROLES = ['A', 'B', 'C']
// ── QA 대상 앱 ──────────────────────────────────────────────────
// 앱 목록(앱 → 타입 → 패키지)은 메인의 src/qa-apps.js 가 원본이다.
// 고른 앱은 하나(전역)이고, 타입은 기기마다 다르다 — 무료용 기기와 관리자 기기를 함께 쓰는 항목이 있다.
// 타입은 슬롯(A/B/C)이 아니라 기기 시리얼에 묶는다. 그래서 왼쪽 메뉴에서 고르든
// QA 탭의 역할 카드에서 고르든 같은 값을 보고, 기기를 다른 슬롯에 다시 꽂아도 유지된다.
//   db_qa_target = { appId, variants: { [appId]: { [serial]: variantId } } }
let qaAppList = []
let qaAppsPromise = null
let qaTarget = loadQaTarget()
let qaPickerSerial = ''
let qaPickerToken = 0

function loadQaTarget() {
  try {
    const t = JSON.parse(localStorage.getItem('db_qa_target') || '{}')
    const variants = t && typeof t.variants === 'object' && !Array.isArray(t.variants) ? t.variants : {}
    return { appId: typeof t?.appId === 'string' ? t.appId : '', variants }
  } catch { return { appId: '', variants: {} } }
}

function saveQaTarget() {
  try { localStorage.setItem('db_qa_target', JSON.stringify(qaTarget)) } catch (error) {
    console.warn('QA 대상 앱 설정을 저장하지 못했습니다:', error)
  }
}

async function ensureQaApps() {
  if (qaAppList.length) return qaAppList
  if (!qaAppsPromise) {
    qaAppsPromise = window.db.qaApps().then(r => {
      qaAppList = r?.ok && Array.isArray(r.apps) ? r.apps : []
      if (!qaAppList.some(app => app.id === qaTarget.appId)) qaTarget.appId = qaAppList[0]?.id || ''
    }).finally(() => { qaAppsPromise = null })
  }
  await qaAppsPromise
  return qaAppList
}

function qaCurrentApp() {
  return qaAppList.find(app => app.id === qaTarget.appId) || null
}

function qaVariantFor(serial) {
  const app = qaCurrentApp()
  const id = app && serial ? qaTarget.variants[app.id]?.[serial] : ''
  return app?.variants.find(v => v.id === id) || null
}

function setQaVariant(serial, variantId) {
  const app = qaCurrentApp()
  if (!app || !serial) return
  const bySerial = qaTarget.variants[app.id] || (qaTarget.variants[app.id] = {})
  if (variantId) bySerial[serial] = variantId
  else delete bySerial[serial]
  saveQaTarget()
  renderQaAppBadges()
}

// 기기 패널 머리의 "제로톡 · 무료용" 표시와 왼쪽 메뉴 버튼 강조
function renderQaAppBadges() {
  const app = qaCurrentApp()
  for (const device of deviceSlots) {
    const badge = slotElement(device, 'qaAppBadge')
    const button = slotElement(device, 'qaAppButton')
    const variant = device.serial ? qaVariantFor(device.serial) : null
    if (badge) {
      badge.hidden = !variant
      badge.textContent = variant ? `${app.name} · ${variant.name}` : ''
    }
    if (button) {
      button.classList.toggle('active', !!variant)
      button.title = variant ? `QA 대상 앱: ${app.name} · ${variant.name}` : 'QA 대상 앱 선택'
    }
  }
}

async function selectQaApp(appId) {
  await ensureQaApps()
  if (!qaAppList.some(app => app.id === appId)) return
  qaTarget.appId = appId
  saveQaTarget()
  renderQaAppBadges()
  renderQaAppSelect()
  await Promise.all(QA_ROLES.map(renderQaPackageSelect))
  refreshQaAutomation()
}

function renderQaAppSelect() {
  const select = document.getElementById('qaAppSelect')
  if (!select) return
  select.replaceChildren(...qaAppList.map(app => new Option(app.name, app.id)))
  select.value = qaTarget.appId
  select.disabled = qaAppList.length < 2
}

// 왼쪽 메뉴의 앱 버튼 — 지금 활성 슬롯의 기기에 대해 연다
async function openQaAppPicker() {
  const device = activeDevice
  if (!device?.serial) { showToast('기기를 먼저 연결해 주세요', true); return }
  await ensureQaApps()
  if (!qaAppList.length) { showToast('등록된 QA 앱이 없습니다', true); return }
  qaPickerSerial = device.serial
  const label = document.getElementById('qaAppPickerDevice')
  if (label) label.textContent = `기기 ${device.slot} · ${device.model || device.serial} — 이 기기에서 테스트할 앱 타입을 고르세요`
  document.getElementById('qaAppOverlay')?.classList.add('open')
  await renderQaAppPicker()
}

function closeQaAppPicker() {
  qaPickerToken++
  document.getElementById('qaAppOverlay')?.classList.remove('open')
  // 다른 기기로 다시 열었을 때 이전 기기의 목록(과 그 기기를 가리키는 클릭 핸들러)이 남지 않게
  document.getElementById('qaVariantList')?.replaceChildren()
  const apkBox = document.getElementById('qaApkSection')
  if (apkBox) { apkBox.replaceChildren(); apkBox.hidden = true }
}

async function renderQaAppPicker() {
  const options = document.getElementById('qaAppOptions')
  const list = document.getElementById('qaVariantList')
  if (!options || !list) return
  const app = qaCurrentApp()
  options.replaceChildren(...qaAppList.map(a => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'qa-app-option' + (a.id === qaTarget.appId ? ' active' : '')
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(a.id === qaTarget.appId))
    b.textContent = a.name
    b.onclick = async () => { await selectQaApp(a.id); renderQaAppPicker() }
    return b
  }))
  const empty = text => { const d = document.createElement('div'); d.className = 'qa-picker-empty'; d.textContent = text; return d }
  const apkBox = document.getElementById('qaApkSection')
  if (!app) { list.replaceChildren(empty('등록된 QA 앱이 없습니다')); if (apkBox) apkBox.hidden = true; return }

  const token = ++qaPickerToken
  const serial = qaPickerSerial
  list.replaceChildren(empty('기기에 설치된 버전을 확인하는 중...'))
  let status
  try { status = await window.db.qaAppStatus({ serial, appId: app.id }) } catch (error) {
    status = { ok: false, message: error.message }
  }
  if (token !== qaPickerToken) return   // 그 사이 다른 앱을 눌렀거나 창을 닫았다
  if (!status.ok) { list.replaceChildren(empty(`설치 정보를 읽지 못했습니다: ${status.message}`)); if (apkBox) apkBox.hidden = true; return }

  const current = qaVariantFor(serial)
  list.replaceChildren(...status.variants.map(v => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'qa-variant' + (current?.id === v.id ? ' active' : '')
    row.disabled = !v.installed
    row.setAttribute('role', 'radio')
    row.setAttribute('aria-checked', String(current?.id === v.id))
    const icon = document.createElement('i')
    icon.className = current?.id === v.id ? 'ti ti-circle-check-filled' : 'ti ti-circle'
    const main = document.createElement('span')
    main.className = 'qa-variant-main'
    const name = document.createElement('span')
    name.className = 'qa-variant-name'
    name.textContent = v.name
    const pkg = document.createElement('span')
    pkg.className = 'qa-variant-pkg'
    pkg.textContent = v.pkg
    main.append(name, pkg)
    const ver = document.createElement('span')
    ver.className = 'qa-variant-ver' + (v.installed ? '' : ' missing')
    ver.textContent = v.installed ? `v${v.versionName} (${v.versionCode})` : '설치 안 됨'
    row.append(icon, main, ver)
    // 고른 뒤에도 창을 닫지 않는다 — 아래 업데이트 APK 영역을 이어서 쓸 수 있게
    row.onclick = () => {
      setQaVariant(serial, v.id)
      syncQaRoleCards(serial)
      showToast(`QA 대상: ${app.name} · ${v.name} (v${v.versionName})`)
      renderQaAppPicker()
    }
    return row
  }))
  await renderQaApkSection(app, serial, token)
}

// ── 업데이트 테스트용 APK ───────────────────────────────────────
// 고른 타입에 dev APK 두 개(기존 버전·업데이트)를 등록하고, 이 기기에
//   ① 기존 버전 설치 (깔린 앱은 지우고 새로 — 데이터 초기화)
//   ② 업데이트 설치 (덮어 설치 — 데이터 유지)
// 순서로 설치한다. 등록·판정·설치는 메인(qa:apk-*)이 하고, 여기서는 결과만 그린다.
const QA_APK_KIND_NAMES = { base: '기존 버전', update: '업데이트' }

function qaEl(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function qaButton(icon, label, onclick, opts = {}) {
  const b = qaEl('button', 'btn-sm' + (opts.primary ? ' primary' : ''))
  b.type = 'button'
  b.innerHTML = `<i class="ti ${icon}"></i>`
  b.append(label)
  b.onclick = onclick
  b.disabled = !!opts.disabled
  if (opts.title) b.title = opts.title
  return b
}

const qaVer = x => `v${x.versionName} (${x.versionCode})`

async function renderQaApkSection(app, serial, token) {
  const box = document.getElementById('qaApkSection')
  if (!box) return
  const variant = qaVariantFor(serial)
  box.hidden = false
  if (!variant) {
    box.replaceChildren(qaEl('div', 'qa-apk-title', '업데이트 테스트'),
      qaEl('div', 'qa-apk-meta', '타입을 고르면 기존 버전·업데이트 APK 를 등록할 수 있습니다'))
    return
  }
  box.replaceChildren(qaEl('div', 'qa-apk-title', `업데이트 테스트 · ${variant.name}`), qaEl('div', 'qa-apk-meta', '확인하는 중...'))

  let status
  try { status = await window.db.qaApkStatus({ serial, appId: app.id, variantId: variant.id }) } catch (error) {
    status = { ok: false, message: error.message }
  }
  if (token !== qaPickerToken) return
  const title = qaEl('div', 'qa-apk-title', `업데이트 테스트 · ${variant.name}`)
  if (!status.ok) { box.replaceChildren(title, qaEl('div', 'qa-apk-check error', status.message)); return }

  const ctx = { appId: app.id, variantId: variant.id, serial, variantName: variant.name }
  const parts = [title]
  parts.push(qaEl('div', 'qa-apk-meta',
    status.installed ? `이 기기에 설치된 버전: ${qaVer(status.installed)}` : `이 기기에는 ${variant.name} 이(가) 설치돼 있지 않습니다`))

  // 기존 버전 → 업데이트 순서로 카드 두 장
  for (const [i, kind] of [['1', 'base'], ['2', 'update']]) {
    const apk = status[kind]
    const card = qaEl('div', 'qa-apk-card')
    card.append(qaEl('div', 'qa-apk-card-title', `${i}. ${QA_APK_KIND_NAMES[kind]} APK`))
    if (!apk.registered) {
      card.append(qaEl('div', 'qa-apk-meta', kind === 'base'
        ? '업데이트 전 버전(예: 55)의 dev 빌드 APK 를 등록하세요'
        : '업데이트할 버전(예: 56)의 dev 빌드 APK 를 등록하세요'))
      const actions = qaEl('div', 'qa-apk-actions')
      actions.append(qaButton('ti-file-upload', 'APK 등록', () => registerQaApk(ctx, kind), { primary: true }))
      card.append(actions)
      parts.push(card)
      continue
    }
    card.append(qaEl('div', 'qa-apk-file', apk.fileName))
    if (apk.ok) {
      const mb = (apk.size / 1024 / 1024).toFixed(1)
      const sign = apk.signer ? `서명 ${apk.signer.scheme} ${apk.signer.hash}` : '서명 정보 없음(v1)'
      card.append(qaEl('div', 'qa-apk-meta', `${qaVer(apk)} · 최소 SDK ${apk.minSdk ?? '?'} · ${mb}MB · ${sign}`))
    }
    card.append(qaEl('div', 'qa-apk-meta qa-apk-path', apk.path))
    const check = status.checks?.[kind] || (apk.ok ? null : { level: 'error', canInstall: false, message: apk.message })
    if (check) card.append(qaEl('div', `qa-apk-check ${check.level}`, check.message))
    const actions = qaEl('div', 'qa-apk-actions')
    const installLabel = kind === 'base' ? '기존 버전 설치' : '업데이트 설치'
    const installTitle = kind === 'base'
      ? (check?.message || '기존 버전을 설치합니다')
      : '앱 데이터를 유지한 채 덮어 설치합니다 (adb install -r)'
    actions.append(
      qaButton(kind === 'base' ? 'ti-player-play' : 'ti-download', installLabel, () => installQaApk(ctx, kind, status), {
        primary: true, disabled: !check?.canInstall, title: check?.canInstall ? installTitle : (check?.message || ''),
      }),
      qaButton('ti-replace', '변경', () => registerQaApk(ctx, kind)),
      qaButton('ti-trash', '등록 해제', () => unregisterQaApk(ctx, kind)),
    )
    card.append(actions)
    parts.push(card)
  }
  // 두 APK 가 한 쌍으로 맞는지 (패키지·서명·버전 순서)
  if (status.pair) parts.push(qaEl('div', `qa-apk-check ${status.pair.level}`, status.pair.message))
  box.replaceChildren(...parts)
}

async function registerQaApk({ appId, variantId, variantName }, kind) {
  const r = await window.db.qaApkRegister({ appId, variantId, kind })
  if (r.canceled) return
  if (!r.ok) { showToast(r.message, true); return }
  showToast(`${variantName} ${QA_APK_KIND_NAMES[kind]} APK 등록: ${qaVer(r.apk)}`)
  renderQaAppPicker()
}

async function unregisterQaApk({ appId, variantId, variantName }, kind) {
  if (!confirm(`${variantName} 의 ${QA_APK_KIND_NAMES[kind]} APK 등록을 해제할까요? (APK 파일은 지우지 않습니다)`)) return
  const r = await window.db.qaApkUnregister({ appId, variantId, kind })
  if (!r.ok) { showToast(r.message, true); return }
  renderQaAppPicker()
}

async function installQaApk({ appId, variantId, serial, variantName }, kind, status) {
  const device = deviceSlots.find(d => d.serial === serial)
  const where = device ? `기기 ${device.slot}(${device.model || serial})` : serial
  const apk = status[kind]
  const from = status.installed ? qaVer(status.installed) : '미설치'
  // 기존 버전은 판정(action)에 따라 데이터를 지킬 수도, 지워야 할 수도 있다 — 판정 문구를 그대로 보여 준다
  const baseCheck = status.checks?.base
  const question = kind === 'base'
    ? `${where} · ${variantName} 기존 버전 설치\n\n${baseCheck?.message || `${qaVer(apk)} 를 설치합니다`}` +
      (baseCheck?.action === 'reinstall' ? '\n\n※ 앱 데이터가 지워집니다. 진행할까요?' : '\n\n진행할까요?')
    : `${where}의 ${variantName}을(를) ${from} → ${qaVer(apk)}(으)로 업데이트합니다.\n앱 데이터는 유지됩니다. 진행할까요?`
  if (!confirm(question)) return
  showToast(`${variantName} ${QA_APK_KIND_NAMES[kind]} 설치 중... (최대 몇 분 걸릴 수 있습니다)`, false, true)
  const r = await window.db.qaApkInstall({ appId, variantId, serial, kind })
  showToast(r.message, !r.ok)
  if (document.getElementById('qaAppOverlay')?.classList.contains('open')) renderQaAppPicker()
  syncQaRoleCards(serial)
}

function clearQaVariantFromPicker() {
  setQaVariant(qaPickerSerial, '')
  syncQaRoleCards(qaPickerSerial)
  renderQaAppPicker()
}

function openQaTabFromPicker() {
  closeQaAppPicker()
  const tab = document.querySelector('.tool-tab[onclick*="\'qa\'"]')
  if (!document.querySelector('.tool-col')?.classList.contains('visible')) toggleToolDrawer()
  switchPage('qa', tab)
  loadQaSetup()
}

// 왼쪽 메뉴에서 바꾼 값을, 같은 기기를 쓰는 QA 탭 역할 카드에도 반영한다
function syncQaRoleCards(serial) {
  for (const role of QA_ROLES) {
    if (qaRoleCard(role)?.querySelector('.qa-device-select')?.value === serial) renderQaPackageSelect(role)
  }
}

// 시작할 때 앱 목록을 한 번 받아 둔다 — 그래야 기기를 연결하자마자 패널 머리에 대상 앱이 보인다
ensureQaApps().then(() => { qaBadgesReady = true; renderQaAppBadges() })
  .catch(error => console.warn('QA 앱 목록을 받지 못했습니다:', error))

let qaAssignments = loadQaAssignments()
let qaDevices = []
let qaElements = []
let qaSelectedElement = null
let qaInspectResult = null
let qaLoadPromise = null

function loadQaAssignments() {
  try {
    const saved = JSON.parse(localStorage.getItem('db_qa_roles') || '{}')
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  } catch { return {} }
}

function saveQaAssignments() {
  try { localStorage.setItem('db_qa_roles', JSON.stringify(qaAssignments)) } catch (error) {
    console.warn('QA 역할 설정을 저장하지 못했습니다:', error)
  }
}

function qaRoleCard(role) {
  return document.querySelector(`.qa-role-card[data-qa-role="${role}"]`)
}

function renderQaDeviceSelect(role) {
  const select = qaRoleCard(role)?.querySelector('.qa-device-select')
  if (!select) return
  const assigned = qaAssignments[role] || {}
  select.replaceChildren(new Option('기기 선택', ''))
  for (const device of qaDevices) {
    select.add(new Option(`${device.model} · ${device.serial}`, device.serial))
  }
  // 역할을 아직 정하지 않았으면 같은 글자의 화면 슬롯에 연결된 기기를 기본으로 쓴다
  // (기기 A 화면 왼쪽 메뉴에서 앱을 고르면 그대로 역할 A 로 이어지게)
  const slotSerial = deviceSlots.find(device => device.slot === role)?.serial
  const preferred = qaDevices.some(device => device.serial === assigned.serial) ? assigned.serial
    : qaDevices.some(device => device.serial === slotSerial) ? slotSerial : ''
  if (preferred) select.value = preferred
  select.onchange = async () => {
    qaAssignments[role] = { serial: select.value, pkg: '' }
    saveQaAssignments()
    await renderQaPackageSelect(role)
  }
}

async function renderQaPackageSelect(role) {
  const card = qaRoleCard(role)
  const select = card?.querySelector('.qa-package-select')
  const serial = card?.querySelector('.qa-device-select')?.value || ''
  if (!select) return
  select.disabled = true
  select.replaceChildren(new Option(serial ? '설치된 앱 조회 중...' : '기기를 먼저 선택하세요', ''))
  if (!serial) return

  await ensureQaApps()
  const app = qaCurrentApp()
  if (!app) { select.replaceChildren(new Option('등록된 QA 앱이 없습니다', '')); return }
  let result
  try { result = await window.db.qaAppStatus({ serial, appId: app.id }) } catch (error) {
    result = { ok: false, message: error.message }
  }
  // 그 사이 기기나 앱을 바꿨으면 이 결과는 버린다
  if (card.querySelector('.qa-device-select').value !== serial || qaCurrentApp() !== app) return
  if (!result.ok) {
    select.replaceChildren(new Option('앱 목록을 불러오지 못했습니다', ''))
    return `역할 ${role}: ${result.message}`
  }
  const installed = result.variants.filter(v => v.installed)
  select.replaceChildren(new Option(installed.length ? `${app.name} 타입 선택` : `${app.name}이(가) 설치돼 있지 않습니다`, ''))
  for (const v of result.variants) {
    const label = v.installed ? `${v.name} · v${v.versionName} (${v.versionCode})` : `${v.name} · 설치 안 됨`
    const option = new Option(label, v.pkg)
    option.disabled = !v.installed
    select.add(option)
  }
  select.disabled = installed.length === 0
  const chosen = qaVariantFor(serial)
  if (chosen && installed.some(v => v.id === chosen.id)) select.value = chosen.pkg
  qaAssignments[role] = { serial, pkg: select.value }
  saveQaAssignments()
  select.onchange = () => {
    const variant = result.variants.find(v => v.pkg === select.value)
    setQaVariant(serial, variant?.id || '')
    qaAssignments[role] = { serial, pkg: select.value }
    saveQaAssignments()
    if (role === 'A') previewQaRun()
    // 같은 기기를 다른 역할에도 배정했으면 그쪽도 맞춘다
    for (const other of QA_ROLES) {
      if (other !== role && qaRoleCard(other)?.querySelector('.qa-device-select')?.value === serial) renderQaPackageSelect(other)
    }
  }
  return null
}

async function loadQaSetup() {
  if (qaLoadPromise) return qaLoadPromise
  qaLoadPromise = (async () => {
    setQaStatus('연결된 기기와 설치된 앱을 확인하는 중...')
    await ensureQaApps()
    renderQaAppSelect()
    qaDevices = await window.db.getDevices()
    for (const role of QA_ROLES) renderQaDeviceSelect(role)
    const packageErrors = (await Promise.all(QA_ROLES.map(renderQaPackageSelect))).filter(Boolean)
    if (!qaDevices.length) setQaStatus('연결된 Android 기기가 없습니다', true)
    else if (packageErrors.length) setQaStatus(packageErrors.join(' / '), true)
    else setQaStatus('역할별 기기와 앱을 선택한 뒤 현재 화면을 조회하세요')
    refreshQaAutomation()
  })().catch(error => {
    setQaStatus(`QA 기기 목록을 불러오지 못했습니다: ${error.message}`, true)
  }).finally(() => { qaLoadPromise = null })
  return qaLoadPromise
}

function setQaStatus(message, isError = false) {
  const status = document.getElementById('qaStatus')
  if (!status) return
  status.textContent = message
  status.classList.toggle('error', isError)
}

async function inspectQaScreen() {
  const role = document.getElementById('qaInspectRole')?.value || 'A'
  const card = qaRoleCard(role)
  const serial = card?.querySelector('.qa-device-select')?.value || ''
  const pkg = card?.querySelector('.qa-package-select')?.value || ''
  if (!serial || !pkg) {
    setQaStatus(`역할 ${role}의 기기와 앱 변형을 선택해 주세요`, true)
    return
  }

  const button = document.getElementById('qaInspectButton')
  if (button) button.disabled = true
  setQaStatus(`역할 ${role}의 현재 화면을 읽는 중...`)
  qaSelectedElement = null
  const tapButton = document.getElementById('qaTapButton')
  if (tapButton) tapButton.disabled = true
  try {
    const result = await window.db.qaInspect(serial)
    if (!result.ok) throw new Error(result.message || '화면 조회에 실패했습니다')
    qaInspectResult = { ...result, serial, role, pkg }
    qaElements = result.elements
    const xmlSource = document.getElementById('qaXmlSource')
    if (xmlSource) xmlSource.textContent = result.xml
    const packageWarning = result.appPackage && result.appPackage !== pkg
      ? `선택한 ${pkg} 대신 현재 화면은 ${result.appPackage} 입니다. 선택한 앱을 기기에서 열고 다시 조회하세요.`
      : `${qaElements.length}개 요소를 찾았습니다 · 역할 ${role} · ${pkg}`
    setQaStatus(packageWarning, result.appPackage !== pkg)
    renderQaElements()
  } catch (error) {
    qaInspectResult = null
    qaElements = []
    renderQaElements()
    setQaStatus(`화면 조회 실패: ${error.message}`, true)
  } finally {
    if (button) button.disabled = false
  }
}

function renderQaElements() {
  const list = document.getElementById('qaElementList')
  if (!list) return
  list.replaceChildren()
  const query = (document.getElementById('qaElementFilter')?.value || '').trim().toLocaleLowerCase()
  const filtered = qaElements.filter(element =>
    [element.text, element.desc, element.id, element.className]
      .some(value => value.toLocaleLowerCase().includes(query)))
  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'qa-empty'
    empty.textContent = qaElements.length ? '검색 결과가 없습니다' : '표시할 요소가 없습니다'
    list.appendChild(empty)
    return
  }

  for (const element of filtered) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'qa-element-row'
    row.classList.toggle('selected', qaSelectedElement?.index === element.index)
    row.addEventListener('click', () => selectQaElement(element))

    const title = document.createElement('span')
    title.className = 'qa-element-title'
    title.textContent = element.text || element.desc || element.id || element.className || '(이름 없는 요소)'
    row.appendChild(title)

    const meta = document.createElement('span')
    meta.className = 'qa-element-meta'
    meta.textContent = [
      element.text && `글자: ${element.text}`,
      element.desc && `설명: ${element.desc}`,
      element.id && `ID: ${element.id}`,
      element.center && `좌표: ${element.center.x}, ${element.center.y}`,
      `활성: ${element.enabled ? '예' : '아니요'}`,
    ].filter(Boolean).join(' · ')
    row.appendChild(meta)
    list.appendChild(row)
  }
}

function selectQaElement(element) {
  qaSelectedElement = element
  const label = document.getElementById('qaSelectedLabel')
  if (label) {
    const name = element.text || element.desc || element.id || element.className || '이름 없는 요소'
    label.textContent = `${name}${element.center ? ` · ${element.center.x}, ${element.center.y}` : ''}`
  }
  const button = document.getElementById('qaTapButton')
  if (button) button.disabled = !element.center || !element.enabled || !qaInspectResult
  renderQaElements()
}

async function tapQaElement() {
  if (!qaSelectedElement?.center || !qaInspectResult) return
  const { serial, role } = qaInspectResult
  const { x, y } = qaSelectedElement.center
  const button = document.getElementById('qaTapButton')
  if (button) button.disabled = true
  try {
    const result = await window.db.qaTap({ serial, x, y })
    if (!result.ok) {
      setQaStatus(`요소 탭 실패: ${result.message}`, true)
      return
    }
    setQaStatus(`역할 ${role} 화면의 (${x}, ${y}) 요소를 탭했습니다. 화면을 다시 조회해 결과를 확인하세요.`)
  } catch (error) {
    setQaStatus(`요소 탭 실패: ${error.message}`, true)
  } finally {
    if (button) button.disabled = !qaSelectedElement?.center || !qaSelectedElement.enabled
  }
}

// 입력한 글자의 요소를 찾아 누른다. 좌표 탭과 달리 메인 프로세스가 화면을 다시 읽어
// 찾으므로 목록을 조회한 뒤 화면이 바뀌었어도 맞는 위치를 누른다.
// 완전히 같은 글자를 먼저 찾고, 없으면 그 글자를 포함하는 요소를 누른다.
async function tapQaByText() {
  const role = document.getElementById('qaInspectRole')?.value || 'A'
  const serial = qaRoleCard(role)?.querySelector('.qa-device-select')?.value || ''
  const text = (document.getElementById('qaTapText')?.value || '').trim()
  if (!serial) { setQaStatus(`역할 ${role}의 기기를 선택해 주세요`, true); return }
  if (!text) { setQaStatus('누를 버튼의 글자를 입력해 주세요', true); return }

  const button = document.getElementById('qaTapTextButton')
  if (button) button.disabled = true
  setQaStatus(`역할 ${role} 화면에서 "${text}" 을(를) 찾는 중...`)
  try {
    let result = await window.db.qaTap({ serial, sel: { text } })
    if (!result.ok) result = await window.db.qaTap({ serial, sel: { textContains: text }, timeout: 1000 })
    if (!result.ok) {
      setQaStatus(`글자로 누르기 실패: ${result.message}`, true)
      return
    }
    setQaStatus(`역할 ${role} 화면의 "${result.label || text}" (${result.x}, ${result.y}) 을(를) 눌렀습니다. 화면을 다시 조회해 결과를 확인하세요.`)
  } catch (error) {
    setQaStatus(`글자로 누르기 실패: ${error.message}`, true)
  } finally {
    if (button) button.disabled = false
  }
}

// ── QA 자동 진행 ───────────────────────────────────────────────
// 체크리스트(CSV) + 시나리오(JSON) → 실행 → 회차별 결과. 실제 실행·저장은 메인(qa:*)이 하고,
// 여기서는 설정을 모아 보내고 진행·결과를 그린다. 계정 비밀번호는 여기로 오지 않는다.
const qaAuto = {
  checklist: null, scenarios: [], scenarioErrors: [], accounts: [], latest: {},
  picked: new Set(), running: false, total: 0, done: 0, runId: '', curItem: '',
  runs: [], run: null, ask: null,
}
const QA_STATUS_CLASS = { Pass: 'pass', Fail: 'fail', Blocked: 'blocked', Skipped: 'skipped', 'To do': 'todo' }
const QA_CHANGE_LABEL = { fixed: '수정 확인', regression: '회귀', still: '미해결', new: '처음' }
const QA_PHASE_LABEL = { before: '업데이트 전', after: '업데이트 후' }

function qaCurAppId() { return qaCurrentApp()?.id || '' }

function qaEl2(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function qaLoadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback }
}
function qaSaveJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)) } catch { } }

// 역할별 테스트 계정 선택 — 계정 자체(비밀번호 포함)는 메인에 있고 여기는 키만 기억한다
function loadQaRoleAccounts() { return qaLoadJson('db_qa_role_accounts', {}) || {} }
function saveQaRoleAccount(role, key) {
  const m = loadQaRoleAccounts()
  if (key) m[role] = key; else delete m[role]
  qaSaveJson('db_qa_role_accounts', m)
}

// '직접 고른 항목' — 앱마다
function loadQaPicked(appId) { return (qaLoadJson('db_qa_picked', {}) || {})[appId] || [] }
function saveQaPicked(appId, ids) {
  const all = qaLoadJson('db_qa_picked', {}) || {}
  all[appId] = ids
  qaSaveJson('db_qa_picked', all)
}

async function refreshQaAutomation() {
  await ensureQaApps()
  const appId = qaCurAppId()
  if (!appId) return
  const [c, s, a] = await Promise.all([
    window.db.qaChecklist(appId), window.db.qaScenarios(appId), window.db.qaAccountsLoad(),
  ]).catch(() => [null, null, null])
  qaAuto.checklist = c?.checklist || null
  qaAuto.scenarios = s?.ok ? s.scenarios : []
  qaAuto.scenarioErrors = s?.ok ? s.errors : [s?.message || '시나리오를 읽지 못했습니다']
  qaAuto.accounts = a?.ok ? a.accounts : []
  qaAuto.picked = new Set(loadQaPicked(appId))
  renderQaChecklistInfo()
  renderQaAccountSelects()
  await previewQaRun()
}

function renderQaChecklistInfo() {
  const c = qaAuto.checklist
  const info = document.getElementById('qaChecklistInfo')
  if (info) {
    info.textContent = c
      ? `${c.name || '체크리스트'} · ${c.items.length}개 항목 · ${new Date(c.importedAt).toLocaleDateString()} 가져옴${c.warnings?.length ? ` · 경고 ${c.warnings.length}` : ''}`
      : '가져온 체크리스트가 없습니다 — 구글 시트 탭을 CSV 로 내려받아 가져오세요'
    info.title = c?.warnings?.join('\n') || ''
  }
  const sc = document.getElementById('qaScenarioInfo')
  if (sc) {
    const n = m => qaAuto.scenarios.filter(s => s.mode === m).length
    const linked = c ? c.items.filter(i => qaAuto.scenarios.some(s => s.id === i.id)).length : 0
    sc.textContent = `시나리오 ${qaAuto.scenarios.length}개 (자동 ${n('auto')} · 반자동 ${n('semi')} · 수동 ${n('manual')})`
      + (c ? ` · 체크리스트와 연결 ${linked}개` : '')
      + (qaAuto.scenarioErrors.length ? ` · 오류 ${qaAuto.scenarioErrors.length}건` : '')
    sc.title = qaAuto.scenarioErrors.join('\n')
    sc.classList.toggle('error', qaAuto.scenarioErrors.length > 0)
  }
}

function renderQaAccountSelects() {
  const saved = loadQaRoleAccounts()
  for (const role of QA_ROLES) {
    const sel = qaRoleCard(role)?.querySelector('.qa-account-select')
    if (!sel) continue
    sel.replaceChildren(new Option('테스트 계정 없음', ''), ...qaAuto.accounts.map(a => new Option(`${a.label}${a.id ? ` · ${a.id}` : ''}`, a.key)))
    if (qaAuto.accounts.some(a => a.key === saved[role])) sel.value = saved[role]
  }
}

// 역할 카드에서 고른 기기·타입·계정
function collectQaRoles() {
  const app = qaCurrentApp()
  const accounts = loadQaRoleAccounts()
  const roles = {}
  for (const role of QA_ROLES) {
    const card = qaRoleCard(role)
    const serial = card?.querySelector('.qa-device-select')?.value || ''
    const pkg = card?.querySelector('.qa-package-select')?.value || ''
    if (!serial || !pkg) continue
    const variant = app?.variants.find(v => v.pkg === pkg)
    roles[role] = { serial, variantId: variant?.id || '', accountKey: accounts[role] || '' }
  }
  return roles
}

function qaRunOptions() {
  const roles = collectQaRoles()
  const keep = document.getElementById('qaKeepPriority')?.value
  return {
    appId: qaCurAppId(),
    variantId: roles.A?.variantId || '',
    roles,
    scope: document.getElementById('qaRunScope')?.value || 'default',
    picked: [...qaAuto.picked],
    keepPriority: keep ? Number(keep) : null,
    manualForUnscripted: !!document.getElementById('qaManualUnscripted')?.checked,
    update: !!document.getElementById('qaRunUpdate')?.checked,
  }
}

function onQaRunOptionChange() { previewQaRun() }

// 이번 범위에 몇 항목이 드는지 미리 보여 준다
async function previewQaRun() {
  const el = document.getElementById('qaRunPreview')
  if (!el) return
  if (!qaAuto.checklist) { el.textContent = '체크리스트를 먼저 가져와 주세요'; return }
  const o = qaRunOptions()
  if (!o.variantId) { el.textContent = '역할 A 의 기기와 앱 타입을 선택해 주세요'; return }
  const r = await window.db.qaRunPreview(o)
  if (!r.ok) { el.textContent = r.message; return }
  qaAuto.latest = r.latest || {}
  const manualNote = o.manualForUnscripted ? `사람 판정 ${r.manual}` : `시나리오 없는 ${r.manual}개는 To do 로 남김`
  el.textContent = `이번 실행: ${r.count}개 (시나리오 ${r.withScenario} · ${manualNote}) / 전체 ${r.total}개`
    + (o.scope === 'custom' && !o.picked.length ? ' — 항목 보기에서 실행할 항목을 골라 주세요' : '')
}

async function importQaChecklist() {
  const appId = qaCurAppId()
  if (!appId) { showToast('QA 대상 앱을 먼저 선택해 주세요', true); return }
  const r = await window.db.qaChecklistImport({ appId })
  if (r.canceled) return
  if (!r.ok) { showToast(r.message, true); return }
  showToast(`체크리스트 ${r.checklist.items.length}개 항목을 가져왔습니다${r.checklist.warnings.length ? ` (경고 ${r.checklist.warnings.length}건 — 마우스를 올려 확인)` : ''}`)
  await refreshQaAutomation()
}

async function openQaScenarioFolder() {
  const appId = qaCurAppId()
  if (!appId) return
  const r = await window.db.qaScenarioFolder(appId)
  if (!r.ok) showToast(r.message, true)
}

// ── 실행 ──
function setQaRunningUI(running) {
  qaAuto.running = running
  const runBtn = document.getElementById('qaRunBtn')
  const stopBtn = document.getElementById('qaStopBtn')
  if (runBtn) runBtn.disabled = running
  if (stopBtn) stopBtn.disabled = !running
  const prog = document.getElementById('qaRunProgress')
  if (prog) prog.hidden = !running
}

function setQaProgress(text) {
  setText('qaRunNow', text)
  const bar = document.getElementById('qaRunBar')
  if (bar) bar.style.width = `${qaAuto.total ? Math.min(100, Math.round(qaAuto.done / qaAuto.total * 100)) : 0}%`
}

async function startQaRun() {
  if (qaAuto.running) return
  const o = qaRunOptions()
  if (!qaAuto.checklist) { showToast('체크리스트를 먼저 가져와 주세요', true); return }
  if (!o.roles.A) { showToast('역할 A(시험 대상)의 기기와 앱 타입을 선택해 주세요', true); return }
  if (o.scope === 'custom' && !o.picked.length) { showToast('항목 보기에서 실행할 항목을 골라 주세요', true); openQaChecklist(); return }
  const preview = document.getElementById('qaRunPreview')?.textContent || ''
  const lines = [`${qaCurrentApp()?.name} 자동 QA 를 시작합니다.`, preview]
  if (o.update) lines.push('', '업데이트 테스트: 기존 버전을 먼저 설치합니다. 기기 상태에 따라 앱 데이터가 지워질 수 있습니다 (더 높은 버전·다른 서명이 깔려 있을 때).')
  lines.push('', '실행 중에는 기기를 직접 조작하지 마세요.')
  if (!confirm(lines.join('\n'))) return
  const r = await window.db.qaRun(o)
  if (!r.ok) { showToast(r.message, true); return }
  qaAuto.runId = r.runId
  qaAuto.total = r.count
  qaAuto.done = 0
  setQaRunningUI(true)
  setQaProgress('시작하는 중...')
}

async function stopQaRun() {
  if (!qaAuto.running) return
  if (!confirm('QA 실행을 중단할까요? 지금 단계가 끝나고 정리(teardown) 후 멈춥니다. 남은 항목은 To do 로 남습니다.')) return
  const r = await window.db.qaStop()
  if (!r.ok) showToast(r.message, true)
  else setQaProgress('중단하는 중 — 정리 단계를 마치고 멈춥니다')
}

function onQaProgress(e) {
  switch (e.type) {
    case 'run-start':
      qaAuto.runId = e.runId
      qaAuto.total = e.total
      qaAuto.done = 0
      setQaRunningUI(true)
      setQaProgress(e.update ? '업데이트 테스트 시작' : '시작')
      break
    case 'phase': {
      const label = { 'install-base': '기존 버전 설치 중...', before: '업데이트 전 항목 실행', 'install-update': '업데이트 설치 중...', after: '업데이트 후 항목 실행' }[e.phase]
      if (label) setQaProgress(label)
      break
    }
    case 'item-start':
      qaAuto.curItem = `${e.phase ? `[${QA_PHASE_LABEL[e.phase] || e.phase}] ` : ''}${e.itemId}${e.title ? ` ${e.title}` : ''}`
      setQaProgress(`${qaAuto.done + 1}/${qaAuto.total} ${qaAuto.curItem}`)
      break
    case 'step':
      setQaProgress(`${qaAuto.done + 1}/${qaAuto.total} ${qaAuto.curItem} — ${e.label}`)
      break
    case 'waiting':
      setQaProgress(`${qaAuto.curItem} — 사람 응답을 기다리는 중`)
      break
    case 'item-end':
      qaAuto.done++
      setQaProgress(`${qaAuto.done}/${qaAuto.total} ${e.itemId} → ${e.status}${e.reason ? ` (${e.reason.slice(0, 60)})` : ''}`)
      break
    case 'log':
      setQaProgress(e.message)
      break
    case 'run-end': {
      setQaRunningUI(false)
      closeQaAsk()
      const s = e.summary || {}
      const msg = `QA ${e.stopped ? '중단' : '완료'} — Pass ${s.Pass || 0} · Fail ${s.Fail || 0} · Blocked ${s.Blocked || 0}`
        + (s.regression ? ` · 회귀 ${s.regression}` : '') + (s.fixed ? ` · 수정 확인 ${s.fixed}` : '')
      showToast(e.error ? `${msg} — ${e.error}` : msg, !!(s.Fail || s.regression || e.error))
      refreshQaAutomation()
      openQaResults(e.runId)
      break
    }
  }
}

// ── 사람 판정 / 확인 창 ──
function openQaAsk(req) {
  qaAuto.ask = req
  const prompt = req.kind === 'prompt'
  setText('qaAskTitle', prompt ? '진행 전에 확인해 주세요' : '결과를 판정해 주세요')
  setText('qaAskItem', `${req.itemId}${req.title ? ` · ${req.title}` : ''}${req.dev ? ` · 역할 ${req.dev}` : ''}`)
  setText('qaAskMessage', req.message || '')
  const detail = document.getElementById('qaAskDetail')
  if (detail) {
    detail.replaceChildren()
    for (const [label, text] of [['사전 조건', req.detail?.pre], ['절차', req.detail?.steps], ['기대 결과', req.detail?.expected]]) {
      if (!text) continue
      const row = qaEl2('div', 'qa-ask-row')
      row.append(qaEl2('b', '', label), qaEl2('span', '', text))
      detail.append(row)
    }
  }
  const note = document.getElementById('qaAskNote')
  if (note) note.value = ''
  const box = document.getElementById('qaAskButtons')
  if (box) {
    const btn = (label, cls, answer) => {
      const b = qaEl2('button', `btn-sm ${cls}`, label)
      b.type = 'button'
      b.onclick = () => answerQaAsk(answer)
      return b
    }
    box.replaceChildren(...(prompt
      ? [btn('계속 진행', 'primary', { action: 'continue' }), btn('진행할 수 없음 (Blocked)', '', { action: 'block' }), btn('전체 중단', 'danger', { action: 'stop' })]
      : [btn('Pass', 'primary', { result: 'Pass' }), btn('Fail', 'danger', { result: 'Fail' }), btn('Blocked', '', { result: 'Blocked' }),
        btn('건너뛰기', '', { result: 'Skipped' }), btn('전체 중단', '', { action: 'stop' })]))
  }
  document.getElementById('qaAskOverlay')?.classList.add('open')
  note?.focus()
}

function closeQaAsk() {
  qaAuto.ask = null
  document.getElementById('qaAskOverlay')?.classList.remove('open')
}

async function answerQaAsk(answer) {
  const req = qaAuto.ask
  if (!req) return
  const note = (document.getElementById('qaAskNote')?.value || '').trim()
  if (answer.action === 'stop' && !confirm('QA 실행 전체를 중단할까요?')) return
  closeQaAsk()
  const r = await window.db.qaAnswer({ requestId: req.requestId, answer: { ...answer, note } })
  if (!r.ok) showToast(r.message, true)
}

// ── 결과 ──
async function openQaResults(runId) {
  const appId = qaCurAppId()
  const r = await window.db.qaRuns({ appId })
  qaAuto.runs = r.ok ? r.runs : []
  const sel = document.getElementById('qaRunSelect')
  if (sel) {
    sel.replaceChildren(...qaAuto.runs.map(run => {
      const s = run.summary || {}
      const when = new Date(run.startedAt).toLocaleString()
      const build = run.build ? ` · v${run.build.versionName} (${run.build.versionCode})` : ''
      return new Option(`${when} · ${run.app?.variantName || run.app?.variant}${build}${run.update ? ' · 업데이트 테스트' : ''} — P${s.Pass || 0}/F${s.Fail || 0}/B${s.Blocked || 0}${run.stopped ? ' (중단)' : ''}`, run.id)
    }))
  }
  document.getElementById('qaResultOverlay')?.classList.add('open')
  const id = runId && qaAuto.runs.some(x => x.id === runId) ? runId : qaAuto.runs[0]?.id
  if (!id) {
    qaAuto.run = null
    setText('qaResultHead', '아직 실행 기록이 없습니다')
    document.getElementById('qaResultTable')?.replaceChildren()
    return
  }
  if (sel) sel.value = id
  await loadQaRunDetail(id)
}

function closeQaResults() { document.getElementById('qaResultOverlay')?.classList.remove('open') }

async function loadQaRunDetail(runId) {
  const r = await window.db.qaRunDetail(runId)
  if (!r.ok) { showToast(r.message, true); return }
  qaAuto.run = r.run
  renderQaResults()
}

function qaChecklistItem(id) { return qaAuto.checklist?.items.find(i => i.id === id) || null }

function renderQaResults() {
  const run = qaAuto.run
  const table = document.getElementById('qaResultTable')
  if (!run || !table) return
  const s = run.summary || {}
  const build = run.build ? `v${run.build.versionName} (${run.build.versionCode})` : '버전 알 수 없음'
  const upd = run.update ? ` · 업데이트 테스트 ${run.update.base ? `v${run.update.base.versionName}` : '?'} → ${run.update.update ? `v${run.update.update.versionName}` : '?'}` : ''
  const scope = { default: '기본 범위', failed: '지난 Fail·Blocked', all: '전체', custom: '직접 선택' }[run.scope?.mode] || ''
  setText('qaResultHead', `${run.app?.name} ${run.app?.variantName} · ${build}${upd} · ${scope} · ${run.checklist || ''} — `
    + `Pass ${s.Pass || 0} · Fail ${s.Fail || 0} · Blocked ${s.Blocked || 0} · Skipped ${s.Skipped || 0} · To do ${s['To do'] || 0}`
    + ` · 회귀 ${s.regression || 0} · 수정 확인 ${s.fixed || 0} · 미해결 ${s.still || 0}${run.stopped ? ' · 중단됨' : ''}${run.error ? ` · ${run.error}` : ''}`)

  const show = document.getElementById('qaResultShow')?.value || ''
  const rows = run.items.filter(it => {
    if (show === 'bad') return it.status === 'Fail' || it.status === 'Blocked'
    if (show === 'regression' || show === 'fixed') return it.change === show
    if (show === 'before') return it.phase === 'before'
    return true
  })
  const head = qaEl2('tr')
  for (const h of ['ID', '항목', '결과', '변화', '사유', '증거', 'Jira']) head.append(qaEl2('th', '', h))
  const body = rows.map(it => {
    const tr = qaEl2('tr', it.change === 'regression' ? 'qa-row-regression' : '')
    const item = qaChecklistItem(it.id)
    tr.append(qaEl2('td', 'qa-mono', it.id + (it.phase ? `\n${QA_PHASE_LABEL[it.phase] || it.phase}` : '')))
    tr.append(qaEl2('td', '', it.title || item?.title || ''))
    const st = qaEl2('td')
    st.append(qaEl2('span', `qa-badge qa-st-${QA_STATUS_CLASS[it.status] || 'todo'}`, it.status))
    if (it.mode && it.mode !== 'auto') st.append(qaEl2('span', 'qa-mode', it.mode === 'manual' ? '사람' : '반자동'))
    tr.append(st)
    const ch = qaEl2('td')
    if (QA_CHANGE_LABEL[it.change]) ch.append(qaEl2('span', `qa-badge qa-ch-${it.change}`, QA_CHANGE_LABEL[it.change]))
    if (it.prev) ch.append(qaEl2('div', 'qa-prev', `지난: ${it.prev.status}${it.prev.jira ? ` · ${it.prev.jira}` : ''}`))
    tr.append(ch)
    const reason = qaEl2('td', 'qa-reason', it.reason || '')
    if (it.notes?.length) reason.title = it.notes.join('\n')
    tr.append(reason)
    const ev = qaEl2('td')
    for (const f of it.evidence || []) {
      const name = f.split('/').pop()
      const label = /screen\.png$/.test(name) ? '화면' : /\.xml$/.test(name) ? '구조' : /logcat/.test(name) ? '로그' : name
      const b = qaEl2('button', 'link-btn', `${name[0]} ${label}`)
      b.title = f
      b.onclick = () => window.db.qaEvidenceOpen({ runId: run.id, file: f })
      ev.append(b)
    }
    tr.append(ev)
    const jr = qaEl2('td')
    if (it.jira) {
      const b = qaEl2('button', 'link-btn', it.jira)
      b.onclick = () => jiraCfgCache.site && window.db.jiraOpen(`https://${String(jiraCfgCache.site).replace(/^https?:\/\//, '').replace(/\/+$/, '')}/browse/${it.jira}`)
      jr.append(b)
    } else if (it.status === 'Fail' || it.status === 'Blocked') {
      const b = qaEl2('button', 'btn-sm', '등록')
      b.onclick = () => openJiraForQa(run, it)
      jr.append(b)
    }
    tr.append(jr)
    return tr
  })
  table.replaceChildren(qaEl2('thead'), qaEl2('tbody'))
  table.tHead.append(head)
  table.tBodies[0].append(...body)
  if (!rows.length) {
    const tr = qaEl2('tr')
    const td = qaEl2('td', 'qa-empty', '해당하는 항목이 없습니다')
    td.colSpan = 7
    tr.append(td)
    table.tBodies[0].append(tr)
  }
}

async function exportQaRun() {
  if (!qaAuto.run) return
  const r = await window.db.qaExport(qaAuto.run.id)
  if (r.canceled) return
  showToast(r.ok ? `CSV 저장: ${r.filePath}` : r.message, !r.ok)
}

function openQaRunFolder() {
  if (qaAuto.run) window.db.qaEvidenceOpen({ runId: qaAuto.run.id })
}

// ── 체크리스트 항목 창 ──
function openQaChecklist() {
  if (!qaAuto.checklist) { showToast('체크리스트를 먼저 가져와 주세요', true); return }
  const c = qaAuto.checklist
  setText('qaChecklistHead', `${c.name || '체크리스트'} · ${c.items.length}개 항목 · 가져온 파일: ${c.file || ''}`)
  document.getElementById('qaChecklistOverlay')?.classList.add('open')
  renderQaChecklist()
}

function closeQaChecklist() { document.getElementById('qaChecklistOverlay')?.classList.remove('open') }

function qaVisibleChecklist() {
  const c = qaAuto.checklist
  if (!c) return []
  const q = (document.getElementById('qaChecklistFilter')?.value || '').trim().toLowerCase()
  const show = document.getElementById('qaChecklistShow')?.value || ''
  const scMap = new Map(qaAuto.scenarios.map(s => [s.id, s]))
  return c.items.filter(it => {
    if (q && !`${it.id} ${it.major} ${it.minor} ${it.title}`.toLowerCase().includes(q)) return false
    const sc = scMap.get(it.id)
    if (show === 'auto') return sc?.mode === 'auto'
    if (show === 'noscenario') return !sc
    if (show === 'failed') return ['Fail', 'Blocked'].includes(qaAuto.latest[it.id]?.status)
    return true
  })
}

function renderQaChecklist() {
  const table = document.getElementById('qaChecklistTable')
  if (!table) return
  const scMap = new Map(qaAuto.scenarios.map(s => [s.id, s]))
  const rows = qaVisibleChecklist()
  const head = qaEl2('tr')
  for (const h of ['', 'ID', '분류', '항목', '중요도', '시나리오', '최근 결과']) head.append(qaEl2('th', '', h))
  const body = rows.map(it => {
    const tr = qaEl2('tr')
    const cb = qaEl2('input')
    cb.type = 'checkbox'
    cb.checked = qaAuto.picked.has(it.id)
    cb.onchange = () => { if (cb.checked) qaAuto.picked.add(it.id); else qaAuto.picked.delete(it.id); renderQaPickedInfo() }
    const c0 = qaEl2('td'); c0.append(cb); tr.append(c0)
    tr.append(qaEl2('td', 'qa-mono', it.id))
    tr.append(qaEl2('td', '', [it.major, it.minor].filter(Boolean).join(' › ')))
    const t = qaEl2('td', '', it.title)
    t.title = [it.pre && `사전 조건: ${it.pre}`, it.steps && `절차: ${it.steps}`, it.expected && `기대 결과: ${it.expected}`].filter(Boolean).join('\n\n')
    tr.append(t)
    tr.append(qaEl2('td', '', it.priorityText || (it.priority ?? '')))
    const sc = scMap.get(it.id)
    tr.append(qaEl2('td', '', sc ? { auto: '자동', semi: '반자동', manual: '수동' }[sc.mode] + (sc.update ? ` · 업데이트 ${sc.update}` : '') : '없음'))
    const last = qaAuto.latest[it.id]
    const lt = qaEl2('td')
    if (last) lt.append(qaEl2('span', `qa-badge qa-st-${QA_STATUS_CLASS[last.status] || 'todo'}`, last.status))
    tr.append(lt)
    return tr
  })
  table.replaceChildren(qaEl2('thead'), qaEl2('tbody'))
  table.tHead.append(head)
  table.tBodies[0].append(...body)
  renderQaPickedInfo()
}

function renderQaPickedInfo() { setText('qaPickedInfo', `선택 ${qaAuto.picked.size}개`) }

function pickQaChecklist(on) {
  if (on) qaVisibleChecklist().forEach(it => qaAuto.picked.add(it.id))
  else qaAuto.picked.clear()
  renderQaChecklist()
}

function useQaPicked() {
  if (!qaAuto.picked.size) { showToast('실행할 항목을 골라 주세요', true); return }
  saveQaPicked(qaCurAppId(), [...qaAuto.picked])
  const scope = document.getElementById('qaRunScope')
  if (scope) scope.value = 'custom'
  closeQaChecklist()
  previewQaRun()
  showToast(`고른 ${qaAuto.picked.size}개 항목으로 실행합니다`)
}

// ── 테스트 계정 창 ──
async function openQaAccounts() {
  const r = await window.db.qaAccountsLoad()
  qaAuto.accounts = r.ok ? r.accounts : []
  renderQaAccountList()
  newQaAccount()
  document.getElementById('qaAccountOverlay')?.classList.add('open')
}

function closeQaAccounts() {
  document.getElementById('qaAccountOverlay')?.classList.remove('open')
  renderQaAccountSelects()
}

const QA_ACC_FIELDS = { qaAccLabel: 'label', qaAccId: 'id', qaAccCompany: 'company', qaAccPhone: 'phone', qaAccName: 'name', qaAccEmail: 'email' }

function renderQaAccountList() {
  const box = document.getElementById('qaAccountList')
  if (!box) return
  if (!qaAuto.accounts.length) { box.replaceChildren(qaEl2('div', 'qa-empty', '등록된 계정이 없습니다')); return }
  box.replaceChildren(...qaAuto.accounts.map(a => {
    const row = qaEl2('div', 'qa-account-row')
    row.append(qaEl2('span', '', `${a.label}${a.id ? ` · ${a.id}` : ''}${a.hasPassword ? ' · 비밀번호 저장됨' : ''}`))
    const edit = qaEl2('button', 'btn-sm', '수정')
    edit.onclick = () => editQaAccount(a)
    const del = qaEl2('button', 'btn-sm', '삭제')
    del.onclick = async () => {
      if (!confirm(`${a.label} 계정을 삭제할까요?`)) return
      const r = await window.db.qaAccountsDelete(a.key)
      if (!r.ok) { showToast(r.message, true); return }
      await openQaAccounts()
    }
    row.append(edit, del)
    return row
  }))
}

function newQaAccount() {
  const key = document.getElementById('qaAccKey')
  if (key) key.value = ''
  for (const id of Object.keys(QA_ACC_FIELDS)) { const el = document.getElementById(id); if (el) el.value = '' }
  const pw = document.getElementById('qaAccPassword')
  if (pw) { pw.value = ''; pw.placeholder = '비밀번호 ($account.password)' }
}

function editQaAccount(a) {
  const key = document.getElementById('qaAccKey')
  if (key) key.value = a.key
  for (const [id, f] of Object.entries(QA_ACC_FIELDS)) { const el = document.getElementById(id); if (el) el.value = a[f] || '' }
  const pw = document.getElementById('qaAccPassword')
  if (pw) { pw.value = ''; pw.placeholder = a.hasPassword ? '저장됨 — 바꿀 때만 입력' : '비밀번호 ($account.password)' }
}

async function saveQaAccount() {
  const acc = { key: document.getElementById('qaAccKey')?.value || '' }
  for (const [id, f] of Object.entries(QA_ACC_FIELDS)) acc[f] = (document.getElementById(id)?.value || '').trim()
  acc.password = document.getElementById('qaAccPassword')?.value || ''
  if (!acc.id && !acc.label) { showToast('아이디나 이름을 입력해 주세요', true); return }
  const r = await window.db.qaAccountsSave(acc)
  const pw = document.getElementById('qaAccPassword')
  if (pw) pw.value = ''                     // 입력칸에 비밀번호를 남겨 두지 않는다
  if (!r.ok) { showToast(r.message, true); return }
  if (!r.encrypted) mirrorLog('[QA] OS 암호화를 쓸 수 없어 테스트 계정 비밀번호가 평문으로 저장됩니다')
  showToast('테스트 계정을 저장했습니다')
  await openQaAccounts()
}

// ── 실패 항목 → Jira ──
// 기존 Jira 등록 창을 QA 내용으로 채워 연다. 자동 등록은 하지 않는다 (사람이 확인 후 등록).
let jiraQaContext = null

function buildQaJiraDescription(run, it, item) {
  const sec = (title, text) => (text ? `h3. ${title}\n${text}\n\n` : '')
  const build = run.build ? `v${run.build.versionName} (${run.build.versionCode})` : '알 수 없음'
  const devices = Object.entries(run.devices || {}).map(([k, d]) => `* 역할 ${k}: ${d.serial} (${d.variant})`).join('\n')
  return sec('사전 조건', item?.pre)
    + sec('절차', item?.steps)
    + sec('기대 결과', item?.expected)
    + sec('실제 결과', `${it.status} — ${it.reason || ''}`)
    + sec('환경', [`* 앱: ${run.app?.name} ${run.app?.variantName} ${build}`, devices,
      `* QA 실행: ${run.id}${it.phase ? ` (${QA_PHASE_LABEL[it.phase]})` : ''} · 체크리스트 ${run.checklist || ''}`].filter(Boolean).join('\n'))
    + (it.evidence?.length ? `_스크린샷·화면 구조·로그는 첨부 파일을 확인하세요._\n` : '')
}

async function openJiraForQa(run, it) {
  const item = qaChecklistItem(it.id)
  jiraQaContext = { runId: run.id, itemId: it.id, phase: it.phase || '', evidence: it.evidence || [] }
  await openJiraModal(false, true)
  if (!document.getElementById('jiraOverlay')?.classList.contains('open')) { jiraQaContext = null; return }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v }
  set('jiraMSummary', `[QA][${it.id}] ${it.title || item?.title || ''}`.trim())
  set('jiraMDesc', buildQaJiraDescription(run, it, item))
  // 증거 파일을 붙이므로 지금 화면 캡처·화면 LogCat 은 기본으로 끈다
  const shot = document.getElementById('jiraMShot'); if (shot) shot.checked = false
  const log = document.getElementById('jiraMLog'); if (log) log.checked = false
}

// QA 화면 초기 연결 — 실행 중에 렌더러가 새로 고쳐져도 실행 상태를 되찾는다
window.db.onQaProgress(onQaProgress)
window.db.onQaPrompt(openQaAsk)
window.db.qaStatus().then(s => { if (s?.running) { qaAuto.runId = s.runId; setQaRunningUI(true); setQaProgress('실행 중 (진행 정보를 다시 받는 중)') } }).catch(() => { })

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
  $('usbTab').style.display = tab === 'usb' ? 'block' : 'none'
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
      <div class="device-item-info">${escapeHtml(d.model)}<span>${escapeHtml(`${d.serial} · ${d.product}`)}</span></div>
      <i class="ti ti-chevron-right" style="color:var(--muted)"></i>`
    item.onclick = () => selectDevice(d)
    list.appendChild(item)
  })
}

async function selectDevice(d) {
  const device = activeDevice
  const existing = deviceSlots.find(other => other !== device && other.serial === d.serial)
  if (existing) {
    showToast(`이미 기기 ${existing.slot} 화면에서 사용 중입니다`, true)
    return
  }
  if (device.serial && device.serial !== d.serial) await withActiveDevice(device, disconnectDevice)
  device.serial = d.serial
  device.model = d.model
  closeModal()
  withActiveDevice(device, () => setConnected(d.model))
}

function setConnected(name) {
  const device = activeDevice
  device.viewBrightness = 100
  updateDevicePanels()
  const brightness = slotElement(device, 'screenBrightness')
  const brightnessInput = brightness?.querySelector('input[type="range"]')
  const brightnessValue = slotElement(device, 'screenBrightnessValue')
  if (brightnessInput) brightnessInput.value = '100'
  if (brightnessValue) brightnessValue.textContent = '100%'
  if (brightness) brightness.hidden = false
  const canvas = slotElement(device, 'phoneScreen')?.querySelector('canvas')
  if (canvas) canvas.style.filter = ''
  const modelEl = slotElement(device, 'slotModel')
  const statusEl = slotElement(device, 'slotStatus')
  if (modelEl) modelEl.textContent = name
  if (statusEl) { statusEl.textContent = '● 연결됨'; statusEl.classList.add('connected') }
  const recordStatus = slotElement(device, 'recordStatus')
  if (recordStatus) {
    recordStatus.dataset.state = 'idle'
    recordStatus.textContent = '녹화 대기 중'
    recordStatus.title = ''
  }
  setClass('connBadge', 'conn-badge connected')
  setText('connText', name)
  setText('statusText', '연결됨', 'var(--accent2)')
  setText('deviceText', name)
  setText('bitrateText', ($('defBitrate')?.value || '8') + ' Mbps')
  const icon = slotElement(device, 'phoneIcon')
  const message = slotElement(device, 'phoneMsg')
  if (icon) icon.style.display = 'none'
  if (message) message.style.display = 'none'
  showToast(name + ' 연결됨')
  updateMirrorToggle()
  refreshDeviceInfo()
  updateConnToggle()

  syncLogControls()
  startActivityPolling(device)
  // 연결되면 미러링과 LogCat 을 바로 시작한다 (시작 버튼을 없앤 대신)
  if (!state.logcatRunning) toggleLogcat()
  if (!state.mirroring) startMirror()
}

// ── 현재 화면(Activity) 조회 ───────────────────────────────────
function startActivityPolling(device = activeDevice) {
  stopActivityPolling(device)
  let requestPending = false
  device.activityInterval = setInterval(async () => {
    const serial = device.serial
    if (!serial || requestPending) return
    requestPending = true
    try {
      const r = await window.db.getCurrentActivity(serial)
      if (device.serial !== serial) return
      const name = r.ok ? r.activity : '—'
      device.currentActivityName = r.ok ? r.activity : null
      if (r.ok && r.activity.includes('/')) refreshAppInfo(r.activity.split('/')[0], device)
      const activityEl = slotElement(device, 'slotActivity')
      if (activityEl) activityEl.textContent = name
      // 두 표시를 독립적으로 갱신한다. 예전에는 activityText(연결 정보 카드) 존재 여부에
      // 묶여 있어서, 그 카드를 주석처리하자 Activity 표시가 통째로 멈췄다.
      const header = slotElement(device, 'slotActivity')
      if (header) header.title = name
    } catch (error) {
      if (device.serial === serial) {
        withActiveDevice(device, () => mirrorLog('현재 화면 조회 실패: ' + error.message))
      }
    } finally {
      requestPending = false
    }
  }, 2000)
}

function stopActivityPolling(device = activeDevice) {
  if (device.activityInterval) {
    clearInterval(device.activityInterval)
    device.activityInterval = null
  }
  device.currentActivityName = null
  const headerText = slotElement(device, 'slotActivity')
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
  const device = activeDevice
  const ip = $('ipInput').value.trim()
  const port = $('portInput').value || 5555
  if (!ip) { showToast('IP 주소를 입력하세요', true); return }
  const serial = `${ip}:${port}`
  if (deviceSlots.some(other => other !== device && other.serial === serial)) {
    showToast('같은 기기를 여러 화면에 동시에 연결할 수 없습니다', true)
    return
  }
  if (device.serial && device.serial !== serial) await withActiveDevice(device, disconnectDevice)
  setClass('connBadge', 'conn-badge searching')
  setText('connText', '연결 중...')
  const r = await window.db.connect(ip, parseInt(port))
  if (r.ok) {
    device.serial = serial
    device.model = ip
    closeModal()
    withActiveDevice(device, () => setConnected(ip))
  } else {
    setClass('connBadge', 'conn-badge disconnected')
    setText('connText', '연결되지 않음')
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
function getMirrorCanvas() {
  const screen = slotElement(activeDevice, 'phoneScreen')
  if (!screen) return null
  let c = screen.querySelector('canvas')
  if (!c) {
    screen.replaceChildren()
    c = document.createElement('canvas')
    c.dataset.role = 'mirrorCanvas'
    c.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:18px;background:#000;cursor:pointer'
    c.style.filter = `brightness(${activeDevice.viewBrightness}%)`

    // 숨겨진 키보드 입력용 textarea 생성
    const input = document.createElement('textarea')
    input.dataset.role = 'mirrorInput'
    input.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:0;height:0;opacity:0'
    // 마우스 제어 및 키보드 제어 이벤트 바인딩
    setupCanvasEvents(c, input)

    screen.appendChild(c)
    screen.appendChild(input)
  }
  return c
}

function setScreenBrightness(slot, value) {
  const device = deviceSlots.find(item => item.slot === slot)
  if (!device) return
  const brightness = Math.min(200, Math.max(25, Number(value) || 100))
  device.viewBrightness = brightness
  const canvas = slotElement(device, 'phoneScreen')?.querySelector('canvas')
  if (canvas) canvas.style.filter = `brightness(${brightness}%)`
  const output = slotElement(device, 'screenBrightnessValue')
  if (output) output.textContent = `${brightness}%`
}

function setupCanvasEvents(canvas, input) {
  const device = activeDevice
  let isDown = false

  // 캔버스를 포커스 가능하게 만든다. 편집 요소가 아니라서 Windows IME 가 붙지 않고,
  // 그래야 한/영 키가 key=Process/keyCode=229 로 뭉개지지 않는다.
  // (아래 마우스 핸들러들이 곧바로 참조하므로 반드시 그보다 먼저 선언해야 한다)
  canvas.setAttribute('tabindex', '0')
  canvas.style.outline = 'none'

  const focusKeyTarget = () => {
    if (keyboardMode === 'uhid') { canvas.focus(); return }
    input.value = ''
    sentText = ''
    input.focus()
  }

  const getDevicePosition = e => {
    const rect = canvas.getBoundingClientRect()
    const clientX = e.clientX - rect.left
    const clientY = e.clientY - rect.top

    const cw = rect.width
    const ch = rect.height
    const vw = canvas.width
    const vh = canvas.height

    if (cw === 0 || ch === 0 || vw === 0 || vh === 0) return null

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

    // 캔버스 좌표로 환산
    const cx = Math.round((clientX - dx) * scale)
    const cy = Math.round((clientY - dy) * scale)

    // 화면을 돌려 그리는 중이면 좌표도 같은 각도로 되돌려야 한다.
    // 기기 해상도(dw×dh)는 회전과 무관하게 원본 그대로 보낸다.
    const rot = state.viewRot || 0
    const swap = rot % 2 === 1      // 90°/270° 면 캔버스가 눕혀져 있다
    const dw = swap ? vh : vw
    const dh = swap ? vw : vh
    const [x, y] = unrotate(rot, cx, cy, dw, dh)
    const touchX = Math.min(dw - 1, Math.max(0, x))
    const touchY = Math.min(dh - 1, Math.max(0, y))
    const viewX = rot === 1 ? vh - 1 - touchY : rot === 2 ? vw - 1 - touchX
      : rot === 3 ? touchY : touchX
    const viewY = rot === 1 ? touchX : rot === 2 ? vh - 1 - touchY
      : rot === 3 ? vw - 1 - touchX : touchY

    return {
      x: touchX,
      y: touchY,
      screenWidth: dw,
      screenHeight: dh,
      canvasX: dx + viewX / scale,
      canvasY: dy + viewY / scale,
    }
  }

  let touchIndicatorTimer = null
  const showTouchIndicator = (e, held) => {
    const position = getDevicePosition(e)
    if (!position) return
    const screen = canvas.parentElement
    let indicator = screen.querySelector('.touch-indicator')
    if (!indicator) {
      indicator = document.createElement('span')
      indicator.className = 'touch-indicator'
      indicator.setAttribute('aria-hidden', 'true')
      screen.appendChild(indicator)
    }
    const canvasRect = canvas.getBoundingClientRect()
    const screenRect = screen.getBoundingClientRect()
    indicator.style.left = `${canvasRect.left - screenRect.left + position.canvasX}px`
    indicator.style.top = `${canvasRect.top - screenRect.top + position.canvasY}px`
    indicator.classList.remove('fading')
    indicator.classList.add('visible')
    if (touchIndicatorTimer) clearTimeout(touchIndicatorTimer)
    touchIndicatorTimer = null
    if (!held) {
      touchIndicatorTimer = setTimeout(() => {
        indicator.classList.add('fading')
        touchIndicatorTimer = setTimeout(() => {
          indicator.classList.remove('visible', 'fading')
          touchIndicatorTimer = null
        }, 180)
      }, 420)
    }
  }

  const sendTouchEvent = (action, e) => {
    if (!state.mirroring || !mirrorWs || mirrorWs.readyState !== 1) return
    const position = getDevicePosition(e)
    if (!position) return
    mirrorWs.send(JSON.stringify({ type: 'touch', action, ...position }))
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault())

  canvas.addEventListener('mousedown', e => {
    if (e.button === 2) {
      // 우클릭: 뒤로가기
      if (mirrorWs && mirrorWs.readyState === 1) {
        mirrorWs.send(JSON.stringify({ type: 'keycode', action: 0, keycode: 4 })) // DOWN
        mirrorWs.send(JSON.stringify({ type: 'keycode', action: 1, keycode: 4 })) // UP
      }
      return
    }
    if (e.button !== 0) return // 마우스 좌클릭만 처리
    isDown = true
    focusKeyTarget()
    showTouchIndicator(e, true)
    sendTouchEvent(0, e) // 0 = DOWN
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', onDragEnd)
  })

  // 드래그 중에는 창 전체에서 이벤트를 받는다. 캔버스에만 걸면 마우스가 디바이스 영역을
  // 벗어나는 순간 move 가 끊겨 스와이프가 중간에 멈춘다. 좌표는 가장자리로 붙는다.
  const onDragMove = e => {
    if (!isDown) return
    showTouchIndicator(e, true)
    sendTouchEvent(2, e)
  }   // 2 = MOVE
  const onDragEnd = e => {
    if (!isDown) return
    isDown = false
    showTouchIndicator(e, false)
    sendTouchEvent(1, e)                                          // 1 = UP
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragEnd)
  }

  canvas.addEventListener('wheel', e => {
    if (!state.mirroring || !mirrorWs || mirrorWs.readyState !== 1) return
    e.preventDefault()
    const position = getDevicePosition(e)
    if (!position) return
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 / 3
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 3
        : 1 / 100
    const hScroll = Math.max(-16, Math.min(16, -e.deltaX * unit))
    const vScroll = Math.max(-16, Math.min(16, -e.deltaY * unit))
    if (hScroll || vScroll) {
      mirrorWs.send(JSON.stringify({ type: 'scroll', ...position, hScroll, vScroll }))
    }
  }, { passive: false })

  canvas.addEventListener('click', focusKeyTarget)

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

  // ── UHID 모드 ──────────────────────────────────────────
  // 눌려 있는 물리 키를 그대로 단말에 중계한다. 문자 조합은 단말 IME 가 하므로
  // 여기서는 textarea 도, 디바운스도, 백스페이스 diff 도 필요 없다.
  // Windows 는 한/영·한자 같은 IME 토글 키에 keyup 을 주지 않는다. 눌림 집합에 남겨두면
  // 다음 press 때 리포트가 직전과 똑같아지고, HID 에서 동일 리포트는 "계속 눌림"이라
  // 새 입력으로 치지 않아 전환이 씹힌다(= 될 때만 되는 증상). 누른 즉시 뗀 것으로 처리한다.
  const TAP_ONLY = new Set(['Lang1', 'Lang2', 'HangulMode', 'HanjaMode', 'NonConvert', 'Convert'])

  // 한국어 키보드의 한/영·한자 키는 물리적으로 오른쪽 Alt 자리라 code 가 'AltRight' 로
  // 오고, 정체는 key 에만 담겨 온다(실측: code=AltRight key=HangulMode keyCode=21).
  // code 만 보면 Right Alt 모디파이어로 전송되어 간헐적으로만 전환되는 것처럼 보인다.
  // 한/영 키가 어떤 값으로 오는지는 포커스 대상에 따라 달라진다(실측).
  //   편집 불가 요소:  code=AltRight key=HangulMode keyCode=21   ← 깨끗하게 식별됨
  //   textarea:        code=AltRight key=Process    keyCode=229  ← Windows IME 가 삼킴
  // 그래서 UHID 모드에서는 아예 편집 요소에 포커스를 주지 않는다(focusKeyTarget).
  // 아래 Process/229 분기는 그래도 textarea 로 포커스가 흘러갔을 때의 안전망이다.
  // 한국어 키보드에는 별도의 오른쪽 Alt 가 없고 그 자리가 곧 한/영 키다.
  const codeOf = e => {
    if (e.key === 'HangulMode' || e.keyCode === 21) return 'Lang1'
    if (e.key === 'HanjaMode' || e.keyCode === 25) return 'Lang2'
    if (e.code === 'AltRight' && (e.key === 'Process' || e.keyCode === 229)) return 'Lang1'
    return e.code
  }

  // 평범한 문자·편집 키. 여기 안 걸리는 keydown 만 로그로 남겨 한/영 키가 어떤 code 로
  // 오는지 확인할 수 있게 한다 (기기·키보드 드라이버마다 다르다).
  const ORDINARY = /^(Key[A-Z]|Digit\d|Numpad|F\d|Space|Enter|Backspace|Tab|Escape|Arrow|Shift|Control|Alt|Meta|Home|End|Page|Delete|Insert|Caps)/

  const hidKeyLog = msg => {
    const el = document.getElementById('scrcpyLog')
    if (el) { el.textContent += '[key] ' + msg + '\n'; el.scrollTop = el.scrollHeight }
  }

  const pressed = new Set()
  const sendHid = () => {
    if (mirrorWs && mirrorWs.readyState === 1) {
      mirrorWs.send(JSON.stringify({ type: 'hid', codes: [...pressed] }))
    }
  }
  // 키를 누른 채 창을 벗어나면 단말에는 눌린 상태로 남는다 (특히 모디파이어).
  // 포커스를 잃으면 전부 뗀 것으로 처리한다.
  const releaseAll = () => {
    if (!pressed.size) return
    pressed.clear()
    sendHid()
  }
  input.addEventListener('blur', () => withActiveDevice(device, releaseAll))
  window.addEventListener('blur', () => withActiveDevice(device, releaseAll))

  let sentText = ''
  let inputTimeout = null

  const syncText = () => {
    const currText = input.value

    let commonLen = 0
    while (commonLen < currText.length && commonLen < sentText.length && currText[commonLen] === sentText[commonLen]) {
      commonLen++
    }

    const backspacesNeeded = sentText.length - commonLen
    for (let i = 0; i < backspacesNeeded; i++) {
      if (mirrorWs && mirrorWs.readyState === 1) {
        mirrorWs.send(JSON.stringify({ type: 'keycode', action: 0, keycode: 67 }))
        mirrorWs.send(JSON.stringify({ type: 'keycode', action: 1, keycode: 67 }))
      }
    }

    const insertText = currText.substring(commonLen)
    if (insertText.length > 0 && mirrorWs && mirrorWs.readyState === 1) {
      mirrorWs.send(JSON.stringify({ type: 'text', text: insertText }))
    }

    sentText = currText
  }

  input.addEventListener('input', e => withActiveDevice(device, () => {
    if (keyboardMode === 'uhid') { input.value = ''; return }
    clearTimeout(inputTimeout)
    // 60ms 디바운스: 빠른 한글 자모 입력 시 클립보드 레이스 컨디션 방지
    inputTimeout = setTimeout(() => withActiveDevice(device, syncText), 60)
  }))

  const onKeyDown = e => {
    if (keyboardMode === 'uhid') {
      e.preventDefault()          // textarea 에 글자가 쌓이지 않게

      // 토글 키는 repeat 검사보다 먼저 처리한다. keyup 이 오지 않으므로 브라우저는 이
      // 키가 계속 눌려 있다고 보고 다음 keydown 에 repeat=true 를 붙인다. repeat 을
      // 먼저 걸러내면 두 번째 press 부터 통째로 죽는다(다른 글자를 치면 브라우저 상태가
      // 리셋돼 한 번 더 먹히는 것이 바로 그 증상).
      const code = codeOf(e)

      if (TAP_ONLY.has(code)) {
        pressed.add(code)
        sendHid()
        // 눌림/뗌을 별도 리포트로 보내야 단말이 두 상태를 구분한다
        setTimeout(() => withActiveDevice(device, () => { pressed.delete(code); sendHid() }), 30)
        return
      }

      // 낯선 키는 원본 이벤트째로 남긴다. 한/영 키가 키보드·포커스 상태에 따라 전혀 다른
      // 값으로 오기 때문에(실측: code=AltRight key=HangulMode / key=Process) 다른 기기에서
      // 입력이 안 될 때 이 한 줄이 바로 단서가 된다.
      if (!ORDINARY.test(code)) hidKeyLog(`미매핑 code=${e.code} key=${e.key} keyCode=${e.keyCode}`)
      if (e.repeat) return        // 키 반복은 단말이 알아서 처리한다
      pressed.add(code)
      sendHid()
      return
    }

    const keycode = KEYCODE_MAP[e.key]

    if (e.key === 'Enter') {
      e.preventDefault()
      clearTimeout(inputTimeout)
      syncText()

      if (mirrorWs && mirrorWs.readyState === 1) {
        mirrorWs.send(JSON.stringify({ type: 'keycode', action: 0, keycode: 66 }))
        mirrorWs.send(JSON.stringify({ type: 'keycode', action: 1, keycode: 66 }))
      }
      
      input.value = ''
      sentText = ''
      return
    }

    if (e.key === 'Backspace') {
      if (input.value === '') {
        e.preventDefault()
        if (mirrorWs && mirrorWs.readyState === 1) {
          mirrorWs.send(JSON.stringify({ type: 'keycode', action: 0, keycode: 67 }))
          mirrorWs.send(JSON.stringify({ type: 'keycode', action: 1, keycode: 67 }))
        }
      }
      return
    }

    if (keycode !== undefined) {
      e.preventDefault()
      if (mirrorWs && mirrorWs.readyState === 1) {
        mirrorWs.send(JSON.stringify({ type: 'keycode', action: 0, keycode }))
      }
    }
  }

  const onKeyUp = e => {
    if (keyboardMode === 'uhid') {
      e.preventDefault()
      const code = codeOf(e)
      if (TAP_ONLY.has(code)) return   // keydown 에서 이미 떼었다
      pressed.delete(code)
      sendHid()
      return
    }

    const keycode = KEYCODE_MAP[e.key]
    if (keycode !== undefined && e.key !== 'Enter' && e.key !== 'Backspace') {
      e.preventDefault()
      if (mirrorWs && mirrorWs.readyState === 1) {
        mirrorWs.send(JSON.stringify({ type: 'keycode', action: 1, keycode }))
      }
    }
  }

  // UHID 모드는 캔버스에, 클립보드 모드는 textarea 에 포커스가 간다. 어느 쪽이 잡히든
  // 같은 핸들러가 돌도록 둘 다에 건다.
  for (const el of [input, canvas]) {
    el.addEventListener('keydown', e => withActiveDevice(device, () => onKeyDown(e)))
    el.addEventListener('keyup', e => withActiveDevice(device, () => onKeyUp(e)))
  }
}

function resetPhoneScreen() {
  updateMirrorToggle()   // 미러링이 끝나는 모든 경로가 이 함수를 지난다
  activeDevice.screenOff = false
  activeDevice.viewBrightness = 100
  updateDeviceScreenButton(activeDevice)
  const brightness = slotElement(activeDevice, 'screenBrightness')
  if (brightness) brightness.hidden = !activeDevice.serial
  const brightnessInput = brightness?.querySelector('input[type="range"]')
  const brightnessValue = slotElement(activeDevice, 'screenBrightnessValue')
  if (brightnessInput) brightnessInput.value = '100'
  if (brightnessValue) brightnessValue.textContent = '100%'
  const screen = slotElement(activeDevice, 'phoneScreen')
  if (!screen) return
  screen.innerHTML = `<i class="ti ti-device-mobile-off" data-role="phoneIcon"></i>
    <p data-role="phoneMsg">${state.serial ? '미러링 시작 버튼을 눌러주세요' : '기기를 연결해 주세요'}</p>`
}

function updateDeviceScreenButton(device) {
  const button = slotElement(device, 'screenPowerButton')
  if (!button) return
  button.classList.toggle('active', device.screenOff)
  button.setAttribute('aria-pressed', String(device.screenOff))
  button.title = device.screenOff ? '스마트폰 화면 켜기' : '스마트폰 화면 끄기'
  button.innerHTML = `<i class="ti ${device.screenOff ? 'ti-device-mobile-off' : 'ti-device-mobile'}"></i>`
}

function toggleDeviceScreen() {
  if (!state.mirroring || !mirrorWs || mirrorWs.readyState !== WebSocket.OPEN) {
    showToast('화면 전원 제어는 미러링 중에만 사용할 수 있습니다', true)
    return
  }
  const device = activeDevice
  const on = device.screenOff
  try {
    mirrorWs.send(JSON.stringify({ type: 'screenPower', on }))
    device.screenOff = !on
    updateDeviceScreenButton(device)
    showToast(on ? '스마트폰 화면을 켰습니다' : '스마트폰 화면을 끄고 PC에서 계속 조작할 수 있습니다')
  } catch (error) {
    showToast(`화면 전원 요청을 보내지 못했습니다: ${error.message}`, true)
  }
}

// ── 로그 유틸 ──────────────────────────────────────────────────
// ── 현재 앱 작업대 ─────────────────────────────────────────────
// 기본값은 '현재 앱만' 이다. PID 를 알기 전에는 걸 수 없어서, 앱 정보가 들어오는 시점에 켠다.
let logAppOnly = localStorage.getItem('db_log_app_only') !== '0'

// Activity 는 2초마다 오지만 패키지가 바뀔 때만 dumpsys 를 친다 (매번 치면 기기가 는다)
async function refreshAppInfo(pkg, device = activeDevice) {
  if (!pkg || pkg === device.currentPkg) return
  device.currentPkg = pkg
  device.currentPid = null
  const packageEl = slotElement(device, 'appPkg')
  const versionEl = slotElement(device, 'appVer')
  if (packageEl) packageEl.textContent = pkg
  if (versionEl) versionEl.textContent = '조회 중...'

  const r = await window.db.appInfo({ serial: device.serial, pkg })
  if (pkg !== device.currentPkg) return
  if (!r.ok) { if (versionEl) versionEl.textContent = r.message || '정보를 가져오지 못했습니다'; return }

  device.currentPid = r.pid
  if (versionEl) versionEl.textContent = [
    r.versionName ? 'v' + r.versionName : null,
    r.versionCode ? '(' + r.versionCode + ')' : null,
    r.pid ? 'PID ' + r.pid : null,
  ].filter(Boolean).join('  ')

  // 필터가 켜져 있으면 새 PID 를 따라간다. 기본값이 '현재 앱만' 이라 처음 PID 를 알게 된
  // 순간에도 여기서 걸린다.
  if (device === activeDevice && (logAppOnly || device.logcatPidFilter)) {
    device.logcatPidFilter = r.pid
    renderLogcat()
  }
  if (device === activeDevice) updateLogFilterBtn()
}

async function appAction(action) {
  if (!requireDevice()) return
  if (!state.currentPkg) { showToast('현재 앱을 알 수 없습니다', true); return }
  const device = activeDevice
  const serial = device.serial
  const pkg = device.currentPkg
  const label = { 'force-stop': '강제종료', 'clear': '데이터 삭제 후 재실행', 'restart': '재실행', 'settings': '앱 정보' }[action]
  const r = await window.db.appAction({ serial, pkg, action })
  if (r.ok) {
    showToast(`${label} 완료 — ${pkg}`)
    if (action === 'clear' || action === 'force-stop') device.currentPid = null
  } else {
    showToast(`${label} 실패: ${r.message || ''}`, true)
  }
}

function updateLogFilterBtn() {
  const btn = $('logFilterBtn')
  if (!btn) return
  const on = !!logcatPidFilter
  btn.innerHTML = on
    ? '<i class="ti ti-filter-off"></i>전체 로그 보기'
    : '<i class="ti ti-filter"></i>현재 실행중인 앱 로그보기'
  btn.classList.toggle('primary', on)
}

function toggleAppLogFilter() {
  if (logcatPidFilter) { logcatPidFilter = null; logAppOnly = false }
  else {
    if (!currentPid) { showToast('앱이 실행 중이 아닙니다 (PID 없음)', true); return }
    logcatPidFilter = currentPid
    logAppOnly = true
  }
  localStorage.setItem('db_log_app_only', logAppOnly ? '1' : '0')   // 다음 실행에도 유지
  updateLogFilterBtn()
  renderLogcat()
}

// ── 기기 정보 ──────────────────────────────────────────────────
async function refreshDeviceInfo() {
  if (!state.serial) return
  const device = activeDevice
  const r = await window.db.deviceInfo(device.serial)
  if (!r.ok) return
  device.deviceInfo = r
  withActiveDevice(device, () => {
    setText('devModel', [r.manufacturer, r.model].filter(Boolean).join(' ') || '—')
    setText('devOs', r.release ? `${r.release} (SDK ${r.sdk})` : '—')
    setText('devPhone', r.phone || 'NULL')
  })
}

function copyDeviceInfo() {
  if (!deviceInfo) { showToast('기기 정보가 없습니다', true); return }
  const d = deviceInfo
  const text = [
    `기기: ${[d.manufacturer, d.model].filter(Boolean).join(' ')}`,
    `Android: ${d.release} (SDK ${d.sdk})`,
    `빌드: ${d.buildId}`,
    `해상도: ${d.resolution} / ${d.density}dpi`,
    `시리얼: ${d.serial}`,
    currentPkg ? `앱: ${currentPkg}` : null,
  ].filter(Boolean).join('\n')
  navigator.clipboard.writeText(text)
    .then(() => showToast('기기 정보가 복사되었습니다'))
    .catch(() => showToast('복사 실패', true))
}

// ── 크래시 · ANR 감지 ──────────────────────────────────────────
// LogCat 이 이미 렌더러를 지나가므로 여기서 걸러내는 비용이 거의 없다.
// 'Force finishing activity' 는 넣지 않는다. 문제 상황이 아니라 액티비티가 정상 종료될
// 때도, 우리가 누른 강제종료 버튼 때문에도 찍힌다 — 오탐만 만든다. 크래시로 인한
// 종료는 어차피 FATAL EXCEPTION 이 먼저 잡는다.
const ISSUE_PATTERNS = [
  { re: /FATAL EXCEPTION/, label: '크래시' },
  { re: /\bANR in\b/, label: 'ANR' },
]
function checkIssue(lines) {
  for (const line of lines) {
    const hit = ISSUE_PATTERNS.find(p => p.re.test(line))
    if (!hit) continue
    // 발생 지점 앞뒤를 같이 들고 있어야 티켓에 붙일 때 쓸모가 있다
    const i = logcatLines.lastIndexOf(line)
    lastIssueLines = i >= 0 ? logcatLines.slice(Math.max(0, i - 5), i + 40) : [line]
    setText('issueTitle', `${hit.label} 감지`)
    setText('issueDetail', line.slice(0, 400))
    $('issueCard')?.classList.add('on')
    showToast(`${hit.label} 감지됨 — 미러링 탭 확인`, true)
    return
  }
}

function copyIssue() {
  if (!lastIssueLines.length) { showToast('복사할 로그가 없습니다', true); return }
  navigator.clipboard.writeText(lastIssueLines.join('\n'))
    .then(() => showToast(`관련 로그 ${lastIssueLines.length}줄이 복사되었습니다`))
    .catch(() => showToast('복사 실패', true))
}

function clearIssue() {
  lastIssueLines = []
  $('issueCard')?.classList.remove('on')
}

// ── LogCat ─────────────────────────────────────────────────────
// 예전 BRIDGE LOG 패널 자리를 대신한다. 브리지 로그는 userData/mirror.log 로만 간다.
// ponytail: 갱신 때마다 전체 텍스트를 다시 쓴다. 프레임당 1회로 묶어 두었으니 보통은
// 충분하지만, 로그가 폭주해 버벅이면 증분 append 방식으로 올릴 것.
const LOGCAT_MAX_LINES = 3000   // 넘으면 앞에서 버린다 — DOM 이 감당하지 못한다
const LOGCAT_DETAIL_MIN = 200   // 이보다 짧은 줄은 그냥 읽힌다 — 눌러서 펼칠 필요가 없다
let logDetailText = ''

// 긴 메시지는 기기 쪽에서 이미 여러 줄로 쪼개져 들어온다. logd 의 한 줄 페이로드 한계(약 4KB)
// 때문이기도 하고 앱이 직접 잘라 찍기도 한다 — 실측: OkHttp 응답 본문이 1043자짜리 6조각.
// 같은 PID·TID·레벨·태그로 이어지고 앞 조각이 충분히 길면 한 줄의 이어짐으로 보고 도로 붙인다.
// ponytail: 길이 임계값 휴리스틱이다. 같은 스레드·태그로 500자 넘는 줄을 연달아 찍는 앱이라면
// 서로 붙어 보일 수 있다. 그런 사례가 나오면 '원본 그대로' 토글을 두면 된다.
const LOGCAT_JOIN_MIN = 500

function pushLogcatLine(line) {
  const c = parseLogcatLine(line)
  const p = logcatLast
  // 이어짐 판정은 반드시 '직전 조각' 길이로 한다. 누적 길이로 재면 마지막 짧은 조각 뒤에
  // 오는 별개의 줄(예: OkHttp 의 '<-- END HTTP')까지 계속 빨려 들어간다.
  if (p && c && p.lastLen >= LOGCAT_JOIN_MIN &&
      p.pid === c.pid && p.tid === c.tid && p.level === c.level && p.tag === c.tag) {
    logcatLines[logcatLines.length - 1] += c.message
    const previousEntry = activeDevice.logcatEntryLast
    if (previousEntry) previousEntry.line += c.message
    p.lastLen = c.message.length
    return
  }
  logcatLines.push(line)
  const entry = { slot: activeDevice.slot, serial: activeDevice.serial, line }
  allLogEntries.push(entry)
  activeDevice.logcatEntryLast = entry
  while (allLogEntries.length > LOGCAT_MAX_LINES * deviceSlots.length) allLogEntries.shift()
  logcatLast = c && { pid: c.pid, tid: c.tid, level: c.level, tag: c.tag, lastLen: c.message.length }
}

function appendLogcat(chunk, serial) {
  const device = deviceSlots.find(slot => slot.serial === serial)
  if (!device) return
  withActiveDevice(device, () => appendLogcatForActive(chunk))
}

function appendLogcatForActive(chunk) {
  logcatPending += chunk
  const parts = logcatPending.split('\n')
  logcatPending = parts.pop()
  if (!parts.length) return
  // adb 가 Windows 에서 CRLF 로 내보낸다 — 이어 붙일 때 줄 중간에 \r 이 끼지 않게 떼어낸다
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1)
    pushLogcatLine(parts[i])
  }
  if (logcatLines.length > LOGCAT_MAX_LINES) logcatLines = logcatLines.slice(-LOGCAT_MAX_LINES)
  checkIssue(parts)
  const device = activeDevice
  if (device.logcatDirty) return
  device.logcatDirty = true
  requestAnimationFrame(() => {
    device.logcatDirty = false
    renderLogcat()
  })
}

// threadtime 형식: "MM-DD HH:MM:SS.mmm  PID  TID LEVEL Tag: msg"
const LOGCAT_LEVEL_RE = /^\d{2}-\d{2} [\d:.]+\s+\d+\s+\d+\s+([VDIWEFA])\s/
const LEVEL_RANK = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 5 }

function logLevelOf(line) {
  const m = line.match(LOGCAT_LEVEL_RE)
  return m ? m[1] : null
}

function setLogcatLevel(v) {
  logcatMinLevel = parseInt(v) || 0
  renderLogcat()
}

// threadtime 한 줄을 필드로 쪼갠다: "MM-DD HH:MM:SS.mmm PID TID LEVEL Tag: message"
const LOGCAT_PARSE_RE = /^\d{2}-\d{2} [\d:.]+\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?):\s?([\s\S]*)$/

function parseLogcatLine(line) {
  const m = line.match(LOGCAT_PARSE_RE)
  if (!m) return null
  return { pid: m[1], tid: m[2], level: m[3], tag: m[4].trim(), message: m[5] }
}

// 자주 쓰는 묶음 필터. 레벨·문자열 필터와 함께(AND) 걸린다.
// 태그 이름이 앱마다 달라 만능은 아니다 — 흔한 라이브러리와 형식을 기준으로 잡았다.
// 정규식을 배열로 두는 이유: 예외 쪽은 대소문자를 가려야 하고(\w+Exception 을 i 로 두면
// 평범한 'exception' 단어까지 걸린다) ANR 쪽은 안 가려야 해서, 한 덩어리로 못 합친다.
const LOG_PRESETS = {
  http: {
    label: 'HTTP 통신',
    // OkHttp 로깅 인터셉터의 '--> GET url' / '<-- 200 OK url' 형식과 주요 HTTP 라이브러리 태그
    res: [/okhttp|retrofit|volley|HttpURLConnection|Cronet|\bHTTP\/\d|-->\s+(GET|POST|PUT|DELETE|PATCH|HEAD)\b|<--\s+\d{3}\b|\bapplication\/json\b/i],
  },
  crash: {
    label: '예외 · 크래시 · ANR',
    res: [
      // 스택트레이스 프레임('at pkg.Class.method(')까지 포함해야 원인 줄이 같이 남는다
      /FATAL EXCEPTION|AndroidRuntime:|Caused by:|\b\w+Exception\b|\bat [a-zA-Z][\w.$]*\.[\w$<>]+\(/,
      /\bANR in\b|Input dispatching timed out|Reason:.*(ANR|not responding)/i,
    ],
  },
}

function setLogcatPreset(v) {
  logcatPreset = v || ''
  renderLogcat()
}

// Android Studio 스타일 질의: tag:Foo level:E message:"some text" pid:1234 -tag:Bar 자유문자열
// 항목은 모두 AND, 앞에 '-' 를 붙이면 제외. 값에 공백이 있으면 따옴표로 묶는다.
const QUERY_KEYS = { tag: 1, level: 1, message: 1, msg: 1, pid: 1, tid: 1 }
const LEVEL_WORDS = { VERBOSE: 'V', DEBUG: 'D', INFO: 'I', WARN: 'W', WARNING: 'W', ERROR: 'E', FATAL: 'F', ASSERT: 'A' }

function parseLogQuery(q) {
  const terms = []
  for (const raw of (q.match(/(?:[^\s"]+|"[^"]*")+/g) || [])) {
    let t = raw
    const negate = t.startsWith('-')
    if (negate) t = t.slice(1)
    const i = t.indexOf(':')
    const key = i > 0 ? t.slice(0, i).toLowerCase() : null
    if (key && QUERY_KEYS[key]) {
      const value = t.slice(i + 1).replace(/^"|"$/g, '').toLowerCase()
      if (value) terms.push({ key: key === 'msg' ? 'message' : key, value, negate })
    } else {
      const value = t.replace(/^"|"$/g, '').toLowerCase()
      if (value) terms.push({ key: null, value, negate })   // 자유 문자열 — 줄 전체에서 찾는다
    }
  }
  return terms
}

function matchesTerm(line, parsed, term) {
  let hit
  if (term.key === null) {
    hit = line.toLowerCase().includes(term.value)
  } else if (term.key === 'level') {
    // 레벨은 '이상'으로 본다 (Android Studio 와 같은 규칙)
    const want = LEVEL_WORDS[term.value.toUpperCase()] || term.value[0].toUpperCase()
    hit = !!parsed && LEVEL_RANK[parsed.level] >= LEVEL_RANK[want]
  } else {
    hit = !!parsed && String(parsed[term.key] || '').toLowerCase().includes(term.value)
  }
  return term.negate ? !hit : hit
}

// 지금 화면에 보이는 줄. 파일로 저장할 때도 같은 기준을 써야 '보이는 대로' 저장된다.
function visibleLogcatLines() {
  const q = ($('logcatFilter')?.value || '').trim()
  const terms = q ? parseLogQuery(q) : []
  const preset = LOG_PRESETS[logcatPreset]
  const entries = dualLogTab === 'all'
    ? allLogEntries.filter(entry => dualLogDevice === 'all' || entry.slot === dualLogDevice)
    : logcatLines.map(line => ({ slot: activeDevice.slot, serial: activeDevice.serial, line }))

  // 필드 질의가 없으면 줄을 쪼갤 필요가 없다 — 흔한 경우라 빠른 길을 따로 둔다
  const needsParse = terms.some(t => t.key !== null) || !!logcatMinLevel

  return entries.filter(entry => {
    const l = entry.line
    const sourceDevice = deviceSlots.find(device => device.slot === entry.slot)
    const pidFilter = dualLogTab === 'all' ? sourceDevice?.logcatPidFilter : logcatPidFilter
    if (preset && !preset.res.some(re => re.test(l))) return false
    if (pidFilter && l.trim().split(/\s+/)[2] !== pidFilter) return false
    const parsed = needsParse ? parseLogcatLine(l) : null
    if (logcatMinLevel) {
      // 레벨을 못 읽는 줄("--------- beginning of main" 등)은 레벨을 거를 때 함께 숨긴다
      if (!parsed || LEVEL_RANK[parsed.level] < logcatMinLevel) return false
    }
    for (const t of terms) if (!matchesTerm(l, parsed, t)) return false
    return true
  }).map(entry => dualLogTab === 'all' && dualLogDevice === 'all'
    ? `[기기 ${entry.slot}] ${entry.line}`
    : entry.line)
}

async function saveLogcat() {
  const lines = visibleLogcatLines()
  if (!lines.length) { showToast('저장할 로그가 없습니다', true); return }
  const r = await window.db.saveLogcat(lines.join('\n'))
  if (r.canceled) return
  if (r.ok) showToast(`${lines.length}줄 저장 완료 — ${r.path}`)
  else showToast(r.message || '저장 실패', true)
}

function renderLogcat() {
  const body = $('logcatBody')
  if (!body) return
  // 패널 안에서 드래그해 둔 선택이 있으면 다시 그리지 않는다. innerHTML 을 갈아끼우면
  // 선택이 통째로 날아가서, 로그가 흐르는 중에는 복사 자체가 불가능해진다.
  // 선택을 풀면 다음 로그가 들어올 때 알아서 최신 상태로 다시 그려진다.
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.anchorNode && body.contains(sel.anchorNode)) return
  const shown = visibleLogcatLines()
  // 사용자가 위로 올려 읽는 중이면 따라가지 않는다. innerHTML 을 통째로 갈아끼우면
  // 스크롤이 맨 위로 튀므로, 최하단이 아닐 때는 보던 위치를 그대로 복원한다.
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40
  const prevTop = body.scrollTop
  const prevHeight = body.scrollHeight

  // ponytail: 매 갱신마다 전체를 다시 그린다. 프레임당 1회로 묶여 있어 지금은 충분하지만,
  // 버퍼를 크게 키우면 줄 단위 증분 append 로 올릴 것.
  logcatShown = shown
  body.innerHTML = shown.map((l, i) => {
    const lv = logLevelOf(l.replace(/^\[기기 [A-C]\] /, ''))
    // 긴 줄만 눌러서 펼칠 수 있게 표시한다 — 짧은 줄까지 열리면 성가시다
    const long = l.length > LOGCAT_DETAIL_MIN ? ' long' : ''
    return `<span class="lv-${lv || 'none'}${long}" data-i="${i}">${escapeHtml(l)}</span>`
  }).join('\n')

  if (atBottom) {
    body.scrollTop = body.scrollHeight
  } else {
    // 버퍼가 꽉 차 앞줄이 잘려나갔으면 그만큼 위로 당겨야 보던 줄이 제자리에 남는다
    const dropped = Math.max(0, prevHeight - body.scrollHeight)
    body.scrollTop = Math.max(0, prevTop - dropped)
  }
  updateLogcatJump()
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

// 위로 올려 읽는 중일 때만 '최신 로그' 버튼을 띄운다
function updateLogcatJump() {
  const body = $('logcatBody')
  const btn = $('logcatJump')
  if (!body || !btn) return
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40
  btn.classList.toggle('on', !atBottom)
}

function scrollLogcatToBottom() {
  const body = $('logcatBody')
  if (!body) return
  body.scrollTop = body.scrollHeight
  updateLogcatJump()
}

$('logcatBody')?.addEventListener('scroll', updateLogcatJump)

// ── 로그 글자 크기 (Ctrl + 휠) ─────────────────────────────────
// 기본값은 CSS 의 11px. 8~24px 로 묶어두고 다음 실행에도 유지한다.
const LOGCAT_FONT_KEY = 'db_logcat_font'
function setLogcatFont(px) {
  logcatFont = Math.min(24, Math.max(8, px))
  const body = $('logcatBody')
  if (body) body.style.fontSize = logcatFont + 'px'
  localStorage.setItem(LOGCAT_FONT_KEY, logcatFont)
}

// passive:false 여야 preventDefault 가 먹는다 — 안 막으면 Chromium 이 창 전체를 확대한다
$('logcatBody')?.addEventListener('wheel', e => {
  if (!e.ctrlKey) return
  e.preventDefault()
  setLogcatFont(logcatFont + (e.deltaY < 0 ? 1 : -1))
}, { passive: false })

setLogcatFont(logcatFont)   // 저장해 둔 크기 복원

// 로그 패널에서 복사하면 머리말(시각·PID·TID·레벨·태그)을 떼고 메시지만 넣는다.
// 머리말째로 필요하면 줄을 눌러 상세 창에서 복사하면 된다 — 그쪽은 보이는 그대로 간다.
$('logcatBody')?.addEventListener('copy', e => {
  const sel = window.getSelection()?.toString()
  if (!sel) return
  // 줄 중간부터 잡힌 조각은 머리말이 안 붙으므로 그대로 둔다
  const stripped = sel.split('\n').map(l => {
    const m = l.match(LOGCAT_PARSE_RE)
    return m ? m[5] : l
  }).join('\n')
  if (stripped === sel) return
  e.clipboardData.setData('text/plain', stripped)
  e.preventDefault()
  showToast('메시지만 복사했습니다')
})

// ── 로그 한 줄 자세히 보기 ─────────────────────────────────────
// 긴 줄은 패널에서 접혀 읽히지 않으니, 눌러서 전체를 펼쳐 본다. JSON 이면 들여쓰기해서 보여준다.
$('logcatBody')?.addEventListener('click', e => {
  const el = e.target.closest?.('span.long')
  if (!el) return
  if (!window.getSelection().isCollapsed) return   // 드래그로 선택 중이면 방해하지 않는다
  openLogDetail(logcatShown[+el.dataset.i])
})

// 메시지 안에 JSON 이 들어 있으면 들여쓰기해서 돌려준다. 아니면 null.
function prettyLogJson(line) {
  const i = line.search(/[{[]/)
  if (i < 0) return null
  const j = Math.max(line.lastIndexOf('}'), line.lastIndexOf(']'))
  if (j <= i) return null
  let obj
  try { obj = JSON.parse(line.slice(i, j + 1)) } catch { return null }
  // JSON.stringify 는 문자열 값 안의 줄바꿈을 \r\n 으로 도로 escape 한다. 그대로 복사하면
  // 슬랙에 '\r\n' 글자가 그냥 찍히므로 실제 줄바꿈으로 풀어서 보여준다.
  const body = JSON.stringify(obj, null, 2)
    .replace(/\\r\\n|\\r|\\n/g, '\n')
    .replace(/\\t/g, '  ')
  const tail = line.slice(j + 1).trim()    // JSON 뒤에 붙은 꼬리말도 버리지 않는다
  return line.slice(0, i) + '\n' + body + (tail ? '\n' + tail : '')
}

function openLogDetail(line) {
  if (!line) return
  logDetailText = line
  setText('logDetailBody', prettyLogJson(line) || line)
  $('logDetailOverlay')?.classList.add('open')
}

function closeLogDetail() {
  $('logDetailOverlay')?.classList.remove('open')
}

function copyLogDetail() {
  // 보이는 그대로 복사한다 — 원본 줄을 복사하면 애써 푼 줄바꿈이 도로 '\r\n' 글자가 된다
  const text = $('logDetailBody')?.textContent || logDetailText
  navigator.clipboard.writeText(text)
    .then(() => showToast('로그가 클립보드에 복사되었습니다'))
    .catch(() => showToast('복사 실패', true))
}

function setLogcatRunning(on) {
  logcatRunning = on
  const btn = $('logcatToggle')
  if (btn) {
    // 아이콘만 두었으므로 상태는 툴팁으로 알린다
    btn.innerHTML = on
      ? '<i class="ti ti-player-stop"></i>'
      : '<i class="ti ti-player-play"></i>'
    btn.title = on ? '로그 중지' : '로그 시작'
  }
}

function showDualLogTab(tab) {
  dualLogTab = tab === 'all' ? 'all' : 'mirror'
  const mirrorLog = document.getElementById('scrcpyLog')
  const logcatBody = document.getElementById('logcatBody')
  const controls = document.getElementById('allLogControls')
  const mirrorButton = document.getElementById('mirrorLogTab')
  const allButton = document.getElementById('allLogTab')
  if (mirrorLog) mirrorLog.style.display = dualLogTab === 'mirror' ? 'block' : 'none'
  if (logcatBody) logcatBody.style.display = dualLogTab === 'all' ? 'block' : 'none'
  if (controls) controls.style.display = dualLogTab === 'all' ? 'flex' : 'none'
  mirrorButton?.classList.toggle('active', dualLogTab === 'mirror')
  allButton?.classList.toggle('active', dualLogTab === 'all')
  renderLogcat()
}

function setDualLogDevice(slot) {
  dualLogDevice = ['all', ...deviceSlots.map(device => device.slot)].includes(slot) ? slot : 'all'
  renderLogcat()
}

function setupDualLogResize() {
  const workspace = document.querySelector('.dual-workspace')
  const handle = document.getElementById('dualLogResize')
  if (!workspace || !handle) return
  const key = 'db_dual_log_height'
  const saved = parseInt(localStorage.getItem(key), 10)
  let height = Number.isFinite(saved) ? saved : 220
  const apply = () => {
    const max = Math.max(140, window.innerHeight - 260)
    height = Math.min(max, Math.max(140, height))
    workspace.style.setProperty('--dual-log-height', `${height}px`)
  }
  apply()
  let startY = 0
  let startHeight = 0
  handle.addEventListener('pointerdown', event => {
    startY = event.clientY
    startHeight = height
    handle.setPointerCapture(event.pointerId)
    event.preventDefault()
  })
  handle.addEventListener('pointermove', event => {
    if (!handle.hasPointerCapture(event.pointerId)) return
    height = startHeight - (event.clientY - startY)
    apply()
  })
  handle.addEventListener('pointerup', event => {
    if (!handle.hasPointerCapture(event.pointerId)) return
    handle.releasePointerCapture(event.pointerId)
    localStorage.setItem(key, String(height))
  })
  window.addEventListener('resize', apply)
}

setupDualLogResize()
showDualLogTab('mirror')

async function toggleLogcat() {
  const device = activeDevice
  if (logcatRunning) {
    await window.db.stopLogcat(device.serial)
    withActiveDevice(device, () => setLogcatRunning(false))
    return
  }
  if (!requireDevice()) return
  const r = await window.db.startLogcat(device.serial)
  if (!r.ok) { showToast('로그 시작 실패: ' + (r.message || ''), true); return }
  withActiveDevice(device, () => setLogcatRunning(true))
}

const PRESET_OPTIONS = [['', '필터 없음'], ['http', 'HTTP 통신'], ['crash', '예외 · 크래시 · ANR']]

function syncLogControls() {
  const presetSel = $('logcatPreset')
  if (presetSel) {
    presetSel.innerHTML = PRESET_OPTIONS
      .map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('')
    logcatPreset = ''
    presetSel.value = logcatPreset
    renderLogcat()
  }
}

function clearLogcat() {
  const targets = dualLogTab === 'all' && dualLogDevice === 'all'
    ? deviceSlots
    : dualLogTab === 'all'
      ? deviceSlots.filter(device => device.slot === dualLogDevice)
      : [activeDevice]
  targets.forEach(clearDeviceLogcat)
  renderLogcat()
}

function clearDeviceLogcat(device) {
  const serial = device.serial
  device.logcatLines = []
  device.logcatInputPending = ''
  device.logcatLast = null
  device.logcatEntryLast = null
  for (let i = allLogEntries.length - 1; i >= 0; i--) {
    if (allLogEntries[i].serial === serial) allLogEntries.splice(i, 1)
  }
}

function copyLogcat() {
  const text = logcatLines.join('\n')
  if (!text.trim()) { showToast('복사할 로그가 없습니다', true); return }
  navigator.clipboard.writeText(text)
    .then(() => showToast('LogCat 이 클립보드에 복사되었습니다'))
    .catch(() => showToast('복사 실패', true))
}

window.db.onLogcatData(appendLogcat)
window.db.onLogcatStopped(serial => {
  const device = deviceSlots.find(slot => slot.serial === serial)
  if (device) withActiveDevice(device, () => setLogcatRunning(false))
})
window.db.onRecordEnded((status, serial) => {
  const device = deviceSlots.find(slot => slot.serial === serial)
  if (device?.recording) withActiveDevice(device, () => finishRecording(status.message || '기기 녹화가 예기치 않게 종료되었습니다'))
})
let updateDialogState = 'idle'
let pendingUpdateVersion = ''

function showUpdateDialog() {
  document.getElementById('updateOverlay')?.classList.add('open')
}

function closeUpdateDialog() {
  document.getElementById('updateOverlay')?.classList.remove('open')
}

function renderUpdateDialog(status) {
  const title = document.getElementById('updateTitle')
  const description = document.getElementById('updateDescription')
  const progressWrap = document.getElementById('updateProgressWrap')
  const progressBar = document.getElementById('updateProgressBar')
  const progressLabel = document.getElementById('updateProgressLabel')
  const error = document.getElementById('updateError')
  const action = document.getElementById('updateActionBtn')
  const later = document.getElementById('updateLaterBtn')
  if (!title || !description || !action || !later) return

  if (status.version) pendingUpdateVersion = status.version
  updateDialogState = status.state
  error.hidden = true
  progressWrap.hidden = true
  later.hidden = false
  later.textContent = '나중에'
  action.disabled = false

  if (status.state === 'available') {
    title.textContent = '새 버전을 사용할 수 있습니다'
    description.textContent = `DroidBridge ${pendingUpdateVersion} 업데이트가 준비되어 있습니다. 다운로드 후 한 번만 재시작하면 적용됩니다.`
    action.textContent = '다운로드 및 설치'
    showUpdateDialog()
  } else if (status.state === 'downloading') {
    title.textContent = '업데이트 다운로드 중'
    description.textContent = `${pendingUpdateVersion ? `DroidBridge ${pendingUpdateVersion}을(를) ` : ''}다운로드하는 동안 평소처럼 앱을 사용할 수 있습니다.`
    progressWrap.hidden = false
    const percent = Math.max(0, Math.min(100, status.percent || 0))
    progressBar.style.width = `${percent}%`
    progressLabel.textContent = percent ? `${percent}% 다운로드됨` : '다운로드 준비 중...'
    action.textContent = '다운로드 중...'
    action.disabled = true
    later.textContent = '백그라운드에서 계속'
    showUpdateDialog()
  } else if (status.state === 'downloaded') {
    title.textContent = '업데이트 설치 준비 완료'
    description.textContent = `DroidBridge ${pendingUpdateVersion}을(를) 적용하려면 앱을 재시작하세요. 업데이트 설치와 앱 다시 열기는 자동으로 진행됩니다.`
    progressWrap.hidden = false
    progressBar.style.width = '100%'
    progressLabel.textContent = '다운로드 완료'
    action.textContent = '지금 다시 시작'
    later.textContent = '나중에 설치'
    showUpdateDialog()
  } else if (status.state === 'error' && status.source === 'download') {
    title.textContent = '업데이트를 다운로드하지 못했습니다'
    description.textContent = '인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
    error.textContent = status.message || '알 수 없는 오류가 발생했습니다.'
    error.hidden = false
    action.textContent = '다시 시도'
    showUpdateDialog()
  }
}

async function runUpdateAction() {
  const action = document.getElementById('updateActionBtn')
  if (action) action.disabled = true
  if (updateDialogState === 'downloaded') {
    const result = await window.db.installAppUpdate()
    if (!result.ok) {
      if (action) action.disabled = false
      showToast(result.message || '업데이트 설치를 시작하지 못했습니다', true)
    }
    return
  }
  updateDialogState = 'downloading'
  renderUpdateDialog({ state: 'downloading', percent: 0, version: pendingUpdateVersion })
  const result = await window.db.downloadAppUpdate()
  if (!result.ok && result.reason === 'unavailable') {
    showToast('배포 버전에서만 업데이트를 설치할 수 있습니다', true)
    closeUpdateDialog()
  }
}

window.db.onUpdateStatus(status => {
  const label = $('updateStatus')
  const button = $('updateCheckBtn')
  if (label) {
    if (status.state === 'checking') label.textContent = '업데이트 확인 중...'
    else if (status.state === 'current') label.textContent = `최신 버전 (${status.version})`
    else if (status.state === 'available') label.textContent = `새 버전 ${status.version} 다운로드 대기 중`
    else if (status.state === 'downloading') label.textContent = `업데이트 다운로드 중 ${status.percent}%`
    else if (status.state === 'downloaded') label.textContent = `버전 ${status.version} 설치 준비 완료`
    else if (status.state === 'error') label.textContent = '업데이트 확인 실패'
  }
  if (button) button.disabled = ['checking', 'downloading', 'downloaded'].includes(status.state)
  if (['available', 'downloading', 'downloaded'].includes(status.state) ||
      (status.state === 'error' && status.source === 'download')) renderUpdateDialog(status)
  if (status.state === 'current' && status.manual) showToast(`최신 버전입니다 (${status.version})`)
  if (status.state === 'error' && status.manual && status.source !== 'download') showToast('업데이트 확인 실패: ' + status.message, true)
})

async function checkForAppUpdates() {
  const button = $('updateCheckBtn')
  if (button) button.disabled = true
  const result = await window.db.checkForUpdates()
  if (!result.ok) {
    if (button) button.disabled = false
    if (result.reason === 'unavailable') showToast('배포 버전에서만 업데이트를 확인할 수 있습니다', true)
  }
}

// copyMirrorLog / clearMirrorLog 는 BRIDGE LOG 패널과 함께 제거했다.
// 브리지 로그는 이제 userData/mirror.log 파일에만 남는다.

function stopDecoder() {
  if (videoDecoder && videoDecoder.state !== 'closed') {
    try { videoDecoder.close() } catch { }
  }
  videoDecoder = null
  // WebSocket은 여기서 닫지 않음 — stopMirror()에서만 닫음
}

function closeMirrorWs() {
  if (mirrorWs) { mirrorWs.close(); mirrorWs = null }
}

function initDecoder(canvas, width, height) {
  const device = activeDevice
  // 기존 디코더만 정리 (WS는 유지)
  stopDecoder()
  canvas.width = width || 1080
  canvas.height = height || 1920
  const ctx = canvas.getContext('2d')

  const logPanel = document.getElementById('scrcpyLog')
  const logToPanel = msg => {
    if (logPanel) { logPanel.textContent += msg + '\n'; logPanel.scrollTop = logPanel.scrollHeight }
  }

  let outputCount = 0

  videoDecoder = new VideoDecoder({
    output(frame) {
      withActiveDevice(device, () => {
      outputCount++
      if (outputCount <= 3) logToPanel(`[decoder] 출력 프레임 #${outputCount}: ${frame.codedWidth}×${frame.codedHeight}`)
      // frame.codedWidth 는 H.264 매크로블록 정렬로 16 배수까지 올림된 값이다(606→608).
      // 캔버스 크기에 그걸 쓰면 터치 좌표계가 어긋나 scrcpy 가 이벤트를 통째로 버린다
      // ("Ignore positional event generated for size 608x1280"). meta 의 실제 크기를 쓴다.
      const vw = state.videoWidth || frame.codedWidth
      const vh = state.videoHeight || frame.codedHeight

      // 기기는 그대로 두고 우리 쪽에서만 돌려 그린다. 캔버스 해상도를 뒤집어 두면
      // CSS 의 object-fit:contain 이 알아서 레터박스를 잡아준다.
      const rot = state.viewRot || 0
      const cw = rot % 2 === 1 ? vh : vw
      const chh = rot % 2 === 1 ? vw : vh
      if (canvas.width !== cw || canvas.height !== chh) { canvas.width = cw; canvas.height = chh }
      const m = rotTransform(rot, vw, vh)
      if (m) {
        ctx.save()
        ctx.setTransform(...m)
        ctx.drawImage(frame, 0, 0, vw, vh, 0, 0, vw, vh)   // 정렬 패딩은 잘라낸다
        ctx.restore()
      } else {
        ctx.drawImage(frame, 0, 0, vw, vh, 0, 0, vw, vh)
      }
      frame.close()
      })
    },
    error(e) {
      withActiveDevice(device, () => {
        console.error('[mirror] VideoDecoder error:', e)
        logToPanel(`[decoder] ❌ 오류: ${e.message}`)
      })
    }
  })

  // SPS에서 읽은 실제 프로파일: 67 64 00 20 → High Profile Level 3.2
  videoDecoder.configure({
    codec: 'avc1.640020',
    codedWidth: canvas.width,
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
      type: isKey ? 'key' : 'delta',
      timestamp: performance.now() * 1000,
      data: feedData,
    }))
  } catch (e) {
    const logEl = document.getElementById('scrcpyLog')
    if (logEl) { logEl.textContent += `[decoder] decode 예외: ${e.message}\n`; logEl.scrollTop = logEl.scrollHeight }
  }
}


function connectMirrorWs(canvas, wsPort, session) {
  const device = activeDevice
  if (mirrorWs) { const previous = mirrorWs; mirrorWs = null; previous.close() }

  // bridge가 준비될 때까지 재시도 (최대 10회, 600ms 간격)
  let attempts = 0
  const MAX = 10

  const logMirror = msg => {
    const el = document.getElementById('scrcpyLog')
    if (el) { el.textContent += `[기기 ${device.slot}] [renderer] ${msg}\n`; el.scrollTop = el.scrollHeight }
  }
  let wsFrameCount = 0

  const tryWs = () => {
    if (session !== mirrorSession || !state.mirroring) return
    logMirror(`WS 연결 시도 ${attempts + 1}/${MAX}...`)
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => withActiveDevice(device, () => {
      if (session !== mirrorSession || !state.mirroring) { ws.close(); return }
      mirrorWs = ws
      wsFrameCount = 0
      logMirror('★ WS 연결 성공!')
    })

    ws.onmessage = e => withActiveDevice(device, () => {
      if (session !== mirrorSession || mirrorWs !== ws) return
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          logMirror('메타 수신: ' + e.data)
          if (msg.type === 'meta') {
            // scrcpy 가 알려주는 '실제' 화면 크기. frame.codedWidth 는 H.264 정렬로
            // 16 배수까지 올림된 값이라(606→608) 좌표계 기준으로 쓰면 안 된다.
            state.videoWidth = msg.width
            state.videoHeight = msg.height
            state.aspectRatio = msg.width / msg.height
            changeScreenSize()
            initDecoder(canvas, msg.width, msg.height)
            const resolution = slotElement(device, 'slotActivity')
            if (resolution) resolution.title = `${msg.width}×${msg.height}`
            showToast(`미러링 중 — ${msg.width}×${msg.height}`)
          } else if (msg.type === 'keyboardMode') {
            keyboardMode = msg.mode
            logMirror(`키보드 모드: ${msg.mode}`)
            const kbEl = slotElement(device, 'kbModeText')
            if (kbEl) {
              kbEl.textContent = msg.mode === 'uhid'
                ? '물리 키보드 (UHID)' : '클립보드 (UHID 사용 불가)'
            }
            if (msg.mode === 'uhid') {
              // 모드는 미러링 시작 뒤에 정해진다. 이미 textarea 에 포커스가 가 있으면
              // Windows IME 가 붙은 상태이므로 편집 불가한 캔버스로 옮긴다.
              slotElement(device, 'mirrorCanvas')?.focus()
              showToast('물리 키보드 모드 — 한/영 키로 전환하세요')
            }
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
    })

    ws.onerror = (ev) => withActiveDevice(device, () => {
      if (session !== mirrorSession) return
      logMirror(`WS onerror 발생 (시도 ${attempts + 1}/${MAX})`)
      if (mirrorWs === ws) mirrorWs = null
      ws.close()
      attempts++
      if (attempts < MAX) {
        setTimeout(() => withActiveDevice(device, tryWs), 600)
      } else {
        logMirror('WS 최대 재시도 초과 → 미러링 중단')
        showToast('미러링 연결 오류 — 로그를 확인해 주세요', true)
        state.mirroring = false
        device.mirrorSession++
        resetPhoneScreen()
        window.db.stopMirror(device.serial).catch(error =>
          withActiveDevice(device, () => mirrorLog('미러링 정리 실패: ' + (error.message || String(error)))))
      }
    })
    ws.onclose = (ev) => withActiveDevice(device, () => {
      if (session !== mirrorSession || mirrorWs !== ws) return
      logMirror(`WS onclose (code=${ev.code}, reason=${ev.reason || 'none'}, 수신프레임=${wsFrameCount})`)
      mirrorWs = null
      state.mirroring = false
      resetPhoneScreen()
      window.db.stopMirror(device.serial).catch(error =>
        withActiveDevice(device, () => mirrorLog('미러링 정리 실패: ' + (error.message || String(error)))))
    })
  }

  tryWs()
}

async function startMirror() {
  if (!requireDevice()) return
  if (state.mirroring) return
  const device = activeDevice

  const bitrate = parseInt(document.getElementById('defBitrate')?.value || 8)
  const fps = parseInt(document.getElementById('defFps')?.value || 60)

  // 로그 패널 초기화
  const logEl = document.getElementById('scrcpyLog')
  if (logEl) logEl.textContent = '미러링 준비 중...\n'

  // IPC 로그 핸들러 등록 (중복 방지: preload의 removeAllListeners로 처리됨)
  if (!mirrorLogListenerRegistered) {
    window.db.onMirrorLog((msg, serial) => {
      const target = deviceSlots.find(slot => slot.serial === serial) || activeDevice
      withActiveDevice(target, () => mirrorLog(msg))
    })
    mirrorLogListenerRegistered = true
  }

  const session = ++device.mirrorSession
  device.mirroring = true
  withActiveDevice(device, updateMirrorToggle)   // 시작은 오래 걸리므로 버튼부터 바로 뒤집는다
  const canvas = getMirrorCanvas()
  if (!canvas) { device.mirroring = false; return }

  // 동적 웹소켓 포트 요청 및 초기화
  let r
  try {
    const wsPort = await window.db.initMirror(device.serial)
    if (session !== device.mirrorSession) return

    // WS 연결 시도 (bridge보다 먼저 시작 — retry로 버팀)
    withActiveDevice(device, () => connectMirrorWs(canvas, wsPort, session))

    // bridge 시작 (jar 푸시 + 서버 실행 + 소켓 연결)
    r = await window.db.startMirror({
      serial: device.serial,
      videoBitrate: bitrate,
      maxSize: device.maxSize || 0,
      fps,
    })
  } catch (error) {
    r = { ok: false, message: error.message || String(error) }
  }
  if (session !== device.mirrorSession) return

  if (!r.ok) {
    device.mirroring = false
    withActiveDevice(device, () => { stopDecoder(); closeMirrorWs(); resetPhoneScreen() })
    window.db.stopMirror(device.serial).catch(error =>
      withActiveDevice(device, () => mirrorLog('미러링 정리 실패: ' + (error.message || String(error)))))
    if (logEl) logEl.textContent += '\n[ERROR] ' + (r.message || '알 수 없는 오류') + '\n'
    showToast('미러링 실패 — 로그 패널 확인', true)
    withActiveDevice(device, updateMirrorToggle)
    return
  }

  withActiveDevice(device, () => {
    setText('statusText', '미러링 중', 'var(--accent2)')
    updateMirrorToggle()
  })
}

async function stopMirror() {
  const device = activeDevice
  const serial = device.serial
  withActiveDevice(device, () => {
    device.mirrorSession++
    stopDecoder()
    closeMirrorWs()
    device.configNalBuffer = null
    device.keyboardMode = 'clipboard'
    device.mirroring = false
    resetPhoneScreen()
  })
  const result = await window.db.stopMirror(serial)
  withActiveDevice(device, () => {
    setText('statusText', '연결됨', 'var(--accent2)')
    showToast('미러링 중지됨')
    updateMirrorToggle()
  })
}

// ── 기기 연결 / 해제 ───────────────────────────────────────────
// 미러링 시작·중지 버튼은 없앴다. 연결되면 자동으로 미러링이 돌고, 해제하면 같이 멈춘다.
function toggleConnection() {
  if (currentPage === 'settings') { saveSettings(); return }
  if (state.serial) disconnectDevice()
  else openConnectModal()
}

async function disconnectDevice() {
  const device = activeDevice
  const name = device.model || device.serial
  if (device.recording) await withActiveDevice(device, () => finishRecording())
  if (device.mirroring) await withActiveDevice(device, () => stopMirror())
  if (device.logcatRunning) {
    await window.db.stopLogcat(device.serial)
    withActiveDevice(device, () => setLogcatRunning(false))
  }
  stopActivityPolling(device)

  // 실제로 끊을 수 있는 건 Wi-Fi(TCP) 뿐이다. USB 는 '선택 해제'가 전부다.
  if (device.serial && device.serial.includes(':')) await window.db.disconnect(device.serial)

  withActiveDevice(device, () => {
    clearDeviceLogcat(device)
    device.serial = null
    device.model = null
    device.currentPkg = null
    device.currentPid = null
    device.logcatPidFilter = null
    device.deviceInfo = null
    device.mirroring = false
    device.logcatRunning = false
    clearIssue()
    const modelEl = slotElement(device, 'slotModel')
    const statusEl = slotElement(device, 'slotStatus')
    if (modelEl) modelEl.textContent = '연결할 기기 선택'
    if (statusEl) { statusEl.textContent = '미연결'; statusEl.classList.remove('connected') }
    const recordStatus = slotElement(device, 'recordStatus')
    if (recordStatus) {
      recordStatus.dataset.state = 'idle'
      recordStatus.textContent = '기기를 연결하면 녹화할 수 있습니다'
      recordStatus.title = ''
    }
    const icon = slotElement(device, 'phoneIcon')
    const message = slotElement(device, 'phoneMsg')
    if (icon) icon.style.display = ''
    if (message) message.style.display = ''
    resetPhoneScreen()
    updateLogFilterBtn()
    updateConnToggle()
    showToast((name || '기기') + ' 연결 해제됨')
  })
  if (deviceSlots.some(other => other !== device && other.serial)) {
    activateSlot(deviceSlots.find(other => other !== device && other.serial).slot)
  }
  updateDevicePanels()
}

// 버튼 한 개가 여러 역할을 하므로 탭·연결 상태가 바뀔 때마다 모양을 맞춰준다.
function updateConnToggle() {
  const btn = $('connToggle')
  if (!btn) return
  if (currentPage === 'settings') {
    btn.classList.remove('on')
    btn.innerHTML = '<i class="ti ti-device-floppy"></i>설정 저장'
    return
  }
  const on = !!state.serial
  btn.classList.toggle('on', on)
  btn.innerHTML = on
    ? '<i class="ti ti-plug-off"></i>기기 해제'
    : '<i class="ti ti-plug"></i>기기 연결'
}

// 미러링 토글 버튼은 사라졌지만 여러 경로에서 불린다 — 지금은 연결 버튼만 갱신한다.
function updateMirrorToggle() { updateConnToggle() }


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
// 캡처는 바로 저장하지 않고 미리보기를 먼저 띄운다. 저장 위치는 저장을 누른 뒤 고른다.
let captureSerial = null
// dir: -1 = 좌로 90°, +1 = 우로 90°. 네 방향을 순환한다.
// 돌아간 화면이 곧 결과라 토스트는 띄우지 않는다 (누를 때마다 떠서 거슬린다).
function rotateView(dir) {
  state.viewRot = (((state.viewRot || 0) + dir) % 4 + 4) % 4
  spinCanvasNow(dir)
}

// 캔버스는 디코더가 프레임을 뱉을 때만 다시 그려진다. 그런데 scrcpy 는 화면이 멈춰 있으면
// 프레임을 거의 안 보낸다 — 실측으로 움직일 때 31ms/장, 정지 화면에서는 1.3초/장까지 벌어졌다.
// 그래서 회전 버튼이 다음 프레임이 올 때까지 먹통처럼 보인다. 지금 캔버스에 남아 있는 그림을
// 그 자리에서 한 번 돌려놓고, 다음 프레임이 이어받게 한다. (돌린 뒤 가로세로가 뒤집히므로
// 다음 프레임에서 크기를 다시 잡을 일도 없다)
function spinCanvasNow(dir) {
  const canvas = $('mirrorCanvas')
  if (!canvas || !canvas.width || !canvas.height) return
  const tmp = document.createElement('canvas')
  tmp.width = canvas.width
  tmp.height = canvas.height
  tmp.getContext('2d').drawImage(canvas, 0, 0)

  const ctx = canvas.getContext('2d')
  canvas.width = tmp.height
  canvas.height = tmp.width
  ctx.setTransform(...rotTransform(dir > 0 ? 1 : 3, tmp.width, tmp.height))
  ctx.drawImage(tmp, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

async function takeScreenshot() {
  if (!requireDevice()) return
  const serial = activeDevice.serial
  captureSerial = serial
  showToast('캡처 중...')
  const r = await window.db.screenshot(serial)
  if (!r.ok) { showToast(r.message || '캡처 실패', true); return }
  const img = $('capturePreview')
  if (img) img.src = r.dataUrl
  $('captureOverlay')?.classList.add('open')
}

async function saveCapture() {
  const r = await window.db.saveCapture(captureSerial)
  if (r.canceled) return                       // 저장 대화상자를 닫은 것 — 미리보기는 유지
  closeCaptureModal()
  captureSerial = null
  if (r.ok) showToast('저장 완료: ' + r.path)
  else showToast(r.message || '저장 실패', true)
}

// 복사 후에도 미리보기를 닫는다 — 붙여넣으러 바로 나가는 흐름이라 남겨둘 이유가 없다
async function copyCapture() {
  const r = await window.db.copyCapture(captureSerial)
  if (!r.ok) { showToast(r.message || '복사 실패', true); return }
  closeCaptureModal()
  window.db.discardCapture(captureSerial)
  captureSerial = null
  showToast('캡처가 클립보드에 복사되었습니다')
}

function cancelCapture() {
  closeCaptureModal()
  window.db.discardCapture(captureSerial)
  captureSerial = null
}

function closeCaptureModal() {
  $('captureOverlay')?.classList.remove('open')
  const img = $('capturePreview')
  if (img) img.src = ''                        // 수 MB 짜리 data URL 을 물고 있지 않게
}

// ── 화면 녹화 ──────────────────────────────────────────────────
function setRecordingStatus(status, text, filePath) {
  const strip = slotElement(activeDevice, 'recordStatus')
  if (strip) {
    strip.dataset.state = status
    strip.textContent = text + (filePath ? ` · ${filePath}` : '')
    strip.title = filePath || text
  }
  const el = $('recStatus')
  if (el) el.dataset.state = status
  setText('recStatusText', text)
  const pathRow = $('recPathRow')
  if (pathRow) pathRow.hidden = !filePath
  setText('recPathText', filePath || '')
}

function setRecordingUI(on, busy = false) {
  const sideButton = slotElement(activeDevice, 'recordButton')
  if (sideButton) {
    sideButton.classList.toggle('on', on)
    sideButton.disabled = busy
    sideButton.title = on ? '녹화 종료 및 저장' : '화면 녹화 시작'
  }
  const btn = $('recToggle')
  if (btn) {
    btn.classList.toggle('on', on)
    btn.disabled = busy
    btn.innerHTML = on
      ? '<i class="ti ti-square-filled"></i><span>STOP</span>'
      : '<i class="ti ti-circle-filled"></i><span>REC</span>'
    btn.title = on ? '녹화 종료 및 저장' : '화면 녹화 시작'
  }
  $('recTimer')?.classList.toggle('on', on)
}

async function toggleRecord() {
  if (!requireDevice()) return
  if (state.recordBusy) return
  const device = activeDevice

  if (!state.recording) {
    device.recordBusy = true
    withActiveDevice(device, () => {
      setRecordingUI(false, true)
      setRecordingStatus('starting', '녹화 시작 중...')
    })
    const bitrate = parseInt($('recBitrate')?.value || '4')
    const size = $('recSize')?.value || ''
    try {
      const r = await window.db.recordStart({ serial: device.serial, bitrate, size: size || null })
      if (!r.ok) {
        withActiveDevice(device, () => setRecordingStatus('error', r.message || '녹화를 시작하지 못했습니다'))
        showToast(r.message || '녹화 시작 실패', true)
        return
      }

      device.recording = true
      device.seconds = 0
      withActiveDevice(device, () => {
        setRecordingUI(true)
        setText('recTimer', '00:00')
        setRecordingStatus('recording', '녹화 중 · 00:00')
      })
      device.timerInterval = setInterval(() => withActiveDevice(device, () => {
        device.seconds++
        const m = Math.floor(device.seconds / 60)
        const s = device.seconds % 60
        const elapsed = [m, s].map(n => String(n).padStart(2, '0')).join(':')
        setText('recTimer', elapsed)
        setRecordingStatus('recording', `녹화 중 · ${elapsed}`)
        if (device.seconds >= 180) finishRecording()
      }), 1000)
      showToast('화면 녹화 중 — 종료하려면 STOP을 누르세요')
    } catch (error) {
      withActiveDevice(device, () => setRecordingStatus('error', `녹화 시작 실패: ${error.message}`))
      showToast(`녹화 시작 실패: ${error.message}`, true)
    } finally {
      device.recordBusy = false
      if (!device.recording) withActiveDevice(device, () => setRecordingUI(false))
    }
    return
  }

  await finishRecording()
}

async function finishRecording(reason) {
  if (!state.recording || state.recordBusy) return
  const device = activeDevice
  const serial = device.serial
  device.recordBusy = true
  clearInterval(device.timerInterval)
  device.timerInterval = null
  device.recording = false
  withActiveDevice(device, () => {
    setRecordingUI(false, true)
    setRecordingStatus('saving', reason
      ? `${reason} · 저장할 위치를 선택하세요...`
      : '녹화를 종료하고 저장할 위치를 선택하세요...')
  })
  showToast(reason || '녹화 파일 저장 중...', !!reason, !reason)
  try {
    const r = await window.db.recordStop(serial)
    if (r.ok) {
      withActiveDevice(device, () => setRecordingStatus('saved', '녹화 저장 완료', r.path))
      showToast('녹화 저장 완료: ' + r.path)
    } else if (r.canceled) {
      withActiveDevice(device, () => setRecordingStatus('canceled', '저장을 취소했습니다. 녹화본은 기기에 임시 보관되어 있습니다.'))
      showToast('녹화 저장을 취소했습니다', true)
    } else {
      withActiveDevice(device, () => setRecordingStatus('error', r.message || '녹화 저장 실패'))
      showToast(r.message || '녹화 저장 실패', true)
    }
  } catch (error) {
    withActiveDevice(device, () => setRecordingStatus('error', `녹화 저장 실패: ${error.message}`))
    showToast(`녹화 저장 실패: ${error.message}`, true)
  } finally {
    device.recordBusy = false
    withActiveDevice(device, () => setRecordingUI(false))
  }
}

function copyRecordingPath() {
  const filePath = $('recPathText')?.textContent
  if (!filePath) return
  navigator.clipboard.writeText(filePath)
    .then(() => showToast('저장 경로를 복사했습니다'))
    .catch(() => showToast('경로 복사 실패', true))
}

// ── APK 설치 ───────────────────────────────────────────────────
async function openApkPicker() {
  if (!requireDevice()) return
  const serial = state.serial
  const paths = await window.db.openApkDialog()
  paths.forEach(p => installApk(p, serial))
}

async function handleApkDrop(e) {
  e.preventDefault()
  $('dropZone').classList.remove('dragging')
  if (!requireDevice()) return
  const files = [...e.dataTransfer.files].filter(f => /\.(apk|xapk)$/i.test(f.name))
  if (files.some(f => !f.path)) {
    showToast('APK 파일 경로를 읽을 수 없습니다. 파일 선택 버튼으로 다시 선택해 주세요.', true)
    return
  }
  files.forEach(f => installApk(f.path))
}

// ── 미러링 화면에 APK 드래그드랍 ───────────────────────────────
// 설치 자체는 installApk() 가 이미 다 한다(진행 UI + 토스트 + adb install -r).
// 여기서는 확인만 받는다. 실수로 떨어뜨렸을 때 바로 설치되면 곤란하기 때문이다.
let pendingApks = []
let pendingApkSerial = null
let installsInFlight = 0   // 동시 설치 시 마지막 완료까지 진행 표시를 유지하기 위한 카운터
let installSeq = 0         // 설치 항목 element id 충돌 방지용 순번

// APK 면 설치를, 그 밖의 파일이면 Download 폴더로 전송을 묻는다.
// 파일 탭이 없어졌으므로 이 경로가 유일한 파일 전송 수단이다.
let pendingPush = []
let pendingPushSerial = null

function handleMirrorDrop(e) {
  e.preventDefault()
  $('phoneScreen')?.classList.remove('apk-drop')
  const files = [...e.dataTransfer.files]
  if (!files.length) return
  if (!requireDevice()) return
  const serial = state.serial

  const isApk = f => /\.(apk|xapk)$/i.test(f.name)
  const apks = files.filter(isApk)
  const others = files.filter(f => !isApk(f))

  if (apks.length) {
    if (others.length) {
      showToast('APK와 일반 파일은 나누어 드롭해 주세요', true)
      return
    }
    if (apks.some(f => !f.path)) {
      showToast('APK 파일 경로를 읽을 수 없습니다. 파일 선택 버튼으로 다시 선택해 주세요.', true)
      return
    }
    pendingApks = apks.map(f => f.path)
    pendingApkSerial = serial
    setText('apkConfirmText', apks.length === 1
      ? `${apks[0].name} 를 설치하시겠습니까?`
      : `${apks[0].name} 외 ${apks.length - 1}개를 설치하시겠습니까?`)
    $('apkConfirmOverlay')?.classList.add('open')
    return
  }

  pendingPush = others.map(f => ({ path: f.path, name: f.name }))
  pendingPushSerial = serial
  setText('pushConfirmText', others.length === 1
    ? `${others[0].name} 를 전송하시겠습니까?`
    : `${others[0].name} 외 ${others.length - 1}개를 전송하시겠습니까?`)
  $('pushConfirmOverlay')?.classList.add('open')
}

// Electron 은 dragover 를 취소한 영역에서만 파일 드롭을 허용한다.
// 기기 화면 밖에서도 APK 를 앱 창에 놓을 수 있도록 창 전체의 파일 드래그를 수락한다.
function isExternalFileDrag(dataTransfer) {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types || [], type => String(type).toLowerCase())
  if (types.includes('files') || types.includes('application/x-moz-file')) return true
  return Array.from(dataTransfer.items || []).some(item => item.kind === 'file')
}

function acceptDrop(e) {
  if (!e.dataTransfer) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}

window.addEventListener('dragenter', acceptDrop, true)
window.addEventListener('dragover', acceptDrop, true)

window.addEventListener('drop', e => {
  if (!e.dataTransfer) return
  const files = Array.from(e.dataTransfer.files || [])
  if (!files.length && !isExternalFileDrag(e.dataTransfer)) return
  // 전용 드롭 영역은 자체 처리기가 담당한다.
  if (e.target.closest?.('[ondrop]')) return

  e.preventDefault()
  e.stopPropagation()
  if (files.some(f => /\.(apk|xapk)$/i.test(f.name))) {
    handleMirrorDrop(e)
  }
}, true)

async function confirmPush() {
  $('pushConfirmOverlay')?.classList.remove('open')
  const list = pendingPush
  const serial = pendingPushSerial
  pendingPush = []
  pendingPushSerial = null
  if (!list.length) return
  if (!serial) { showToast('파일을 보낼 기기를 찾을 수 없습니다', true); return }

  for (const f of list) {
    showToast(`${f.name} 전송 중...`, false, true)
    try {
      const r = await window.db.pushFile({
        serial,
        localPath: f.path,
        remotePath: '/sdcard/Download/' + f.name,
      })
      if (r.ok) showToast(`${f.name} 전송 완료 — Download 폴더`)
      else showToast(`${f.name} 전송 실패: ${r.message || ''}`, true)
    } catch (error) {
      showToast(`${f.name} 전송 실패: ${error.message}`, true)
    }
  }
}

function cancelPush() {
  $('pushConfirmOverlay')?.classList.remove('open')
  pendingPush = []
  pendingPushSerial = null
}

function confirmApkInstall() {
  $('apkConfirmOverlay').classList.remove('open')
  const list = pendingApks
  const serial = pendingApkSerial
  pendingApks = []
  pendingApkSerial = null
  list.forEach(apkPath => installApk(apkPath, serial)) // 진행 상황은 APK 설치 탭 + 완료 토스트
}

function cancelApkInstall() {
  $('apkConfirmOverlay').classList.remove('open')
  pendingApks = []
  pendingApkSerial = null
}

// adb 는 실패 사유를 stderr 로만 흘린다(실측):
//   adb: failed to install ...: Failure [INSTALL_PARSE_FAILED_NOT_APK: ...]
//   adb: failed to stat ...: No such file or directory
// 코드만 그대로 보여주면 QA 중에 원인 파악이 안 되므로 자주 나오는 것은 풀어서 쓴다.
const INSTALL_ERRORS = {
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: '서명이 다릅니다 — 기기에서 기존 앱을 먼저 삭제하세요',
  INSTALL_FAILED_VERSION_DOWNGRADE: '기기에 더 높은 버전이 설치되어 있습니다',
  INSTALL_FAILED_INSUFFICIENT_STORAGE: '기기 저장공간이 부족합니다',
  INSTALL_FAILED_NO_MATCHING_ABIS: 'CPU 아키텍처가 맞지 않습니다',
  INSTALL_FAILED_ALREADY_EXISTS: '이미 설치되어 있습니다',
  INSTALL_PARSE_FAILED_NOT_APK: '올바른 APK 파일이 아닙니다',
  INSTALL_FAILED_TEST_ONLY: '테스트 전용 APK 입니다 (adb install -t 필요)',
  INSTALL_FAILED_USER_RESTRICTED: '기기에서 설치가 거부되었습니다 — 폰 화면의 확인 팝업을 봐주세요',
}

function installErrorReason(output) {
  const s = String(output || '')
  const code = s.match(/Failure \[([A-Z_]+)/)
  if (code) return INSTALL_ERRORS[code[1]] || code[1]

  const lines = s.split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return '알 수 없는 오류'
  // 오류로 보이는 마지막 줄을 쓰되, 못 찾으면 마지막 줄을 그대로 쓴다. 한국어도 같이
  // 훑어야 main.js 가 내는 'adb 실행 실패: ENOENT' 를 놓치지 않는다.
  const line = [...lines].reverse().find(l => /failed|error|실패|오류/i.test(l))
    || lines[lines.length - 1]
  return line.replace(/^adb(\.exe)?:\s*/, '').slice(0, 140)
}

async function installApk(apkPath, serial = state.serial) {
  if (typeof apkPath !== 'string' || !apkPath.trim()) {
    showToast('APK 파일 경로를 읽을 수 없습니다. 파일 선택 버튼으로 다시 선택해 주세요.', true)
    return
  }
  if (!serial) { showToast('APK를 설치할 기기를 찾을 수 없습니다', true); return }
  const name = apkPath.split(/[\\/]/).pop()
  // 진행 UI 는 'APK 설치' 탭에만 있어서 다른 탭(특히 미러링)에서는 완료될 때까지
  // 아무 반응이 없어 보인다. 어느 화면에 있든 보이도록 토스트를 띄워 둔다.
  installsInFlight++
  showToast(`${name} 설치 중...`, false, true)
  const queue = $('installQueue')
  // Date.now() 만 쓰면 같은 틱에 시작된 설치끼리 id 가 겹쳐 진행 표시가 엉뚱한 항목에
  // 찍힌다(다중 드롭이면 항상 같은 틱이다). 순번을 붙여 고유하게 만든다.
  const uid = `${Date.now()}_${++installSeq}`
  const fillId = 'fill_' + uid
  const pctId = 'pct_' + uid
  const msgId = 'msg_' + uid
  const item = document.createElement('div')
  item.className = 'install-item'
  item.innerHTML = `<i class="ti ti-package"></i>
    <div class="install-info"><p>${escapeHtml(name)}</p><span id="${msgId}">설치 중...</span>
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

  let r
  try {
    r = await window.db.install({ serial, apkPath })
  } catch (error) {
    r = { ok: false, output: error.message || String(error) }
  }
  clearInterval(iv)
  const fill = $(fillId); const pctEl = $(pctId)
  if (fill) fill.style.width = '100%'
  installsInFlight--
  // 아직 설치 중인 게 남아 있으면 토스트를 붙잡아 둔다. 안 그러면 첫 완료 토스트가
  // 2.4초 뒤 사라지면서 나머지가 진행 중인데도 다 끝난 것처럼 보인다.
  const rest = installsInFlight > 0 ? ` (${installsInFlight}개 설치 중)` : ''
  const busy = installsInFlight > 0
  const msgEl = $(msgId)
  if (r.ok) {
    if (pctEl) { pctEl.textContent = '설치 완료'; pctEl.className = 'install-status done' }
    if (msgEl) msgEl.textContent = '완료'
    showToast(name + ' 설치 완료' + rest, false, busy)
  } else {
    const reason = installErrorReason(r.output)
    if (pctEl) { pctEl.textContent = '설치 실패'; pctEl.style.color = 'var(--red)' }
    // 토스트는 사라지므로 사유는 목록에도 남긴다. 원문은 title 로 붙여 둔다.
    if (msgEl) {
      msgEl.textContent = reason
      msgEl.style.color = 'var(--red)'
      msgEl.title = String(r.output || '').trim()
    }
    showToast(`${name} 설치 실패 — ${reason}${rest}`, !busy, busy)
  }
}

// ── 파일 전송 ──────────────────────────────────────────────────
async function pushFileDialog() {
  if (!requireDevice()) return
  const serial = state.serial
  const paths = await window.db.openFileDialog()
  if (!paths || !paths.length) return
  for (const localPath of paths) {
    const name = localPath.split(/[\\/]/).pop()
    const remotePath = '/sdcard/Download/' + name
    const r = await window.db.pushFile({ serial, localPath, remotePath })
    addFileQueueItem(name, r.ok)
  }
}

async function pullFileDialog() {
  if (!requireDevice()) return
  const serial = state.serial
  const remotePath = prompt('Android 경로를 입력하세요 (예: /sdcard/DCIM/photo.jpg)')
  if (!remotePath) return
  const r = await window.db.pullFile({ serial, remotePath })
  if (r.ok) showToast('저장 완료: ' + r.path)
  else showToast('가져오기 실패', true)
}

async function handleFileDrop(e) {
  e.preventDefault()
  if (!requireDevice()) return
  const serial = state.serial
  const files = [...e.dataTransfer.files]
  for (const f of files) {
    const r = await window.db.pushFile({
      serial,
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
    <div class="install-info"><p>${escapeHtml(name)}</p><span>/sdcard/Download/</span>
      <div class="progress-bar"><div class="progress-fill" style="width:100%"></div></div>
    </div><span class="install-status ${ok ? 'done' : ''}" style="${ok ? '' : 'color:var(--red)'}">${ok ? '전송 완료' : '실패'}</span>`
  queue.prepend(item)
  showToast(ok ? name + ' 전송 완료' : '전송 실패', !ok)
}

function changeScreenSize() {
  const screen = $('phoneScreen')
  if (screen) {
    screen.style.removeProperty('height')
    screen.style.removeProperty('width')
  }
}

// ── 도구 패널 접기/펼치기 ──────────────────────────────────────
// 접으면 디바이스와 LogCat 만 남는다. 창을 더 좁게 줄일 수도 있다.
function isToolPanelCollapsed() {
  return !!document.querySelector('.tool-col.collapsed')
}

function toggleToolPanel() {
  const col = document.querySelector('.tool-col')
  if (col?.classList.contains('visible')) {
    closeToolDrawer()
    return
  }
  if (!col) return
  const collapsed = col.classList.toggle('collapsed')
  localStorage.setItem('db_tools_collapsed', collapsed ? '1' : '0')
  updateToolToggleIcon()
  changeScreenSize()   // 가용 너비가 달라졌으니 다시 잰다
}

let toolDrawerOrigin = null

function toggleToolDrawer() {
  const col = document.querySelector('.tool-col')
  if (!col) return
  if (col.classList.contains('visible')) {
    closeToolDrawer()
    return
  }
  toolDrawerOrigin = {
    parent: col.parentNode,
    nextSibling: col.nextSibling,
    collapsed: col.classList.contains('collapsed'),
  }
  col.classList.remove('collapsed')
  document.body.appendChild(col)
  col.classList.add('visible')
  switchPage('settings', document.querySelector('.tool-tab[onclick*="settings"]'))
}

function closeToolDrawer() {
  const col = document.querySelector('.tool-col.visible')
  if (!col) return
  col.classList.remove('visible')
  const origin = toolDrawerOrigin
  toolDrawerOrigin = null
  if (origin?.collapsed) col.classList.add('collapsed')
  if (origin?.parent?.isConnected) {
    const before = origin.nextSibling?.parentNode === origin.parent ? origin.nextSibling : null
    origin.parent.insertBefore(col, before)
  }
  updateToolToggleIcon()
}

function updateToolToggleIcon() {
  const btn = $('toolToggle')
  if (!btn) return
  const collapsed = isToolPanelCollapsed()
  btn.innerHTML = collapsed
    ? '<i class="ti ti-layout-sidebar-left-expand"></i>'
    : '<i class="ti ti-layout-sidebar-left-collapse"></i>'
  btn.title = collapsed ? '도구 패널 펼치기' : '도구 패널 접기'
}

// 창 크기가 바뀌면 같이 따라간다. 첫 호출은 레이아웃이 잡힌 뒤라야 clientHeight 가 맞다.
window.addEventListener('resize', changeScreenSize)
requestAnimationFrame(() => {
  if (localStorage.getItem('db_tools_collapsed') === '1') {
    document.querySelector('.tool-col')?.classList.add('collapsed')
  }
  updateToolToggleIcon()
  changeScreenSize()
})

// ── 설정 ───────────────────────────────────────────────────────
const APP_THEMES = ['forest', 'graphite', 'ocean']
const APP_THEME_NAMES = { forest: '포레스트', graphite: '그래파이트', ocean: '오션' }

function applyTheme(theme) {
  const selected = APP_THEMES.includes(theme) ? theme : 'forest'
  document.documentElement.dataset.theme = selected
  if ($('themeSelect')) $('themeSelect').value = selected
  return selected
}

function setTheme(theme) {
  const selected = applyTheme(theme)
  localStorage.setItem('db_theme', selected)
  showToast(`화면 테마가 ${APP_THEME_NAMES[selected]}로 변경되었습니다`)
}

function updateAlwaysOnTopButton(enabled) {
  const button = $('alwaysOnTopButton')
  if (!button) return
  button.classList.toggle('active', enabled)
  button.setAttribute('aria-pressed', String(enabled))
  button.title = enabled ? '항상 위 고정 해제' : '항상 위 고정'
  button.innerHTML = `<i class="ti ${enabled ? 'ti-pinned' : 'ti-pin'}"></i>항상 위`
}

async function toggleAlwaysOnTop() {
  const button = $('alwaysOnTopButton')
  const enabled = button?.getAttribute('aria-pressed') !== 'true'
  try {
    const result = await window.db.setAlwaysOnTop(enabled)
    if (!result.ok) {
      showToast(result.message || '항상 위 설정을 변경하지 못했습니다', true)
      return
    }
    updateAlwaysOnTopButton(result.enabled)
    showToast(result.enabled ? '창을 항상 위에 표시합니다' : '항상 위 고정을 해제했습니다')
  } catch (error) {
    showToast(`항상 위 설정을 변경하지 못했습니다: ${error.message}`, true)
  }
}

window.db.getAlwaysOnTop().then(updateAlwaysOnTopButton).catch(error => {
  console.warn('항상 위 설정을 불러오지 못했습니다:', error)
})

// 단말의 물리 키보드 레이아웃 설정 화면을 연다. UHID 최초 사용 시 1회 필요하다.
function openKeyboardSettings() {
  if (!mirrorWs || mirrorWs.readyState !== 1) {
    showToast('미러링 중에만 열 수 있습니다', true)
    return
  }
  mirrorWs.send(JSON.stringify({ type: 'openKeyboardSettings' }))
  showToast('폰 화면에서 키보드 레이아웃을 지정하세요')
}

// Jira 는 자기 팝업에서 저장한다 — 여기서 같이 저장하면 팝업에서 취소한 값까지 들어간다
function saveSettings() {
  localStorage.setItem('db_bitrate', $('defBitrate').value)
  localStorage.setItem('db_fps', $('defFps').value)
  showToast('설정이 저장되었습니다')
}

function loadSettings() {
  applyTheme(localStorage.getItem('db_theme') || 'forest')
  const b = localStorage.getItem('db_bitrate')
  const f = localStorage.getItem('db_fps')
  if (b && $('defBitrate')) $('defBitrate').value = b
  if (f && $('defFps')) $('defFps').value = f
  // db_screen_width 는 더 이상 쓰지 않는다 — 높이가 창의 60% 로 고정이라 저장할 값이 없다
  changeScreenSize()
  updateMirrorToggle()
}

loadSettings()

// ── Jira 백로그 등록 ───────────────────────────────────────────
// 티켓에서 매번 손으로 적던 환경 정보를 자동으로 채운 초안을 띄운다. 토큰은 메인 프로세스에만
// 있고 여기로 내려오지 않으므로, 이 파일은 설정 '여부'만 알 수 있다.
const JIRA_TEMPLATE_LOG_LINES = 60   // 설명에 넣을 최근 로그 줄 수. 나머지는 파일로 첨부한다
let jiraCfgCache = { project: '', issueType: '버그', hasToken: false }

async function loadJiraSettings() {
  const c = await window.db.jiraLoad()
  jiraCfgCache = c
  const set = (id, v) => { const el = $(id); if (el) el.value = v || '' }
  setText('jiraSiteText', c.site || '—')     // 사이트는 고정값이라 표시만 한다
  set('jiraEmail', c.email)
  const tok = $('jiraToken')
  if (tok) { tok.value = ''; tok.placeholder = c.hasToken ? '저장됨 — 바꿀 때만 입력' : 'API 토큰' }
  jiraFieldDefs = c.fieldDefs || []
  jiraFieldValues = { ...(c.fieldValues || {}) }
  try {
    const saved = JSON.parse(localStorage.getItem('db_jira_projects')) || []
    // 예전 버전은 키 배열만 저장했다 — 그 형식도 읽어준다
    jiraProjects = saved.map(p => (typeof p === 'string' ? { key: p, name: p } : p))
  } catch { jiraProjects = [] }
  fillJiraProjectList()
  updateJiraStatus()
  // 설정이 이미 끝난 상태로 다시 열면 선택지를 바로 보여준다
  showJiraPickRow(!!(c.hasToken && c.project))
  renderJiraSprintSettings(c)
}

// 설정 탭에는 상태 두 줄만 남기고 입력은 팝업에서 받는다 (사이드 패널이 너무 좁다)
function updateJiraStatus() {
  const c = jiraCfgCache
  const ready = !!(c.site && c.email && c.hasToken)
  setText('jiraStatus', ready ? '연결 정보 저장됨' : '미설정', ready ? 'var(--accent2)' : 'var(--muted)')
  setText('jiraSummary', c.project ? (c.projectName ? `${c.projectName} - ${c.project}` : c.project) : '—')
  setText('jiraEmailText', c.email || '—')
}

// ── 티켓에 같이 넣을 필드 ──────────────────────────────────────
// Jira 의 '내 고정된 필드'는 사용자별 화면 설정이라 API 로 못 읽는다. 대신 생성 화면에
// 실제로 뜨는 필드를 받아와 체크박스로 고르게 하고, 고른 것만 티켓에 싣는다.
let jiraFieldDefs = []     // [{ id, name, kind, options, required }]
let jiraFieldValues = {}   // { 필드id: 값 }

// 등록 팝업에서 이슈 타입을 고르면 그 타입의 생성 화면 필드를 받아 '필드명 : 값' 줄로 깔아준다.
// 값이 비어 있는 필드는 티켓에 보내지 않으므로, 안 쓰는 필드는 그냥 두면 된다.
async function refreshJiraFields() {
  const box = $('jiraMFields')
  if (!box) return
  const key = (jiraCfgCache.project || '').toUpperCase()
  const typeName = $('jiraMType')?.value || ''
  const typeId = (jiraTypeItems[key] || []).find(t => t.name === typeName)?.id
  if (!key || !typeId || !jiraCfgCache.hasToken) { box.innerHTML = ''; jiraFieldDefs = []; return }

  const r = await window.db.jiraFields({ projectKey: key, issueTypeId: typeId })
  if (!r.ok) { jiraAuthCheck(r, '필드 조회'); box.innerHTML = ''; jiraFieldDefs = []; return }
  if (!r.fields.length) { box.innerHTML = ''; jiraFieldDefs = []; return }
  jiraFieldDefs = r.fields
  renderJiraFieldRows()
}

// Jira 의 '내 고정된 필드'는 API 로 못 읽는다(실측 확인). 그래서 같은 걸 앱에서 만든다 —
// 핀을 꽂은 필드는 프로젝트별로 로컬에 저장해 맨 위에 순서대로 두고, 나머지는 접어둔다.
const JIRA_PIN_KEY = 'db_jira_pins'
let jiraShowAllFields = false     // 나머지 필드 펼침 여부. 기본은 접힌 상태다

function loadPins() {
  try { return (JSON.parse(localStorage.getItem(JIRA_PIN_KEY)) || {})[(jiraCfgCache.project || '').toUpperCase()] || [] } catch { return [] }
}

function savePins(ids) {
  try {
    const all = JSON.parse(localStorage.getItem(JIRA_PIN_KEY)) || {}
    all[(jiraCfgCache.project || '').toUpperCase()] = ids
    localStorage.setItem(JIRA_PIN_KEY, JSON.stringify(all))
  } catch { /* 저장 못 해도 기능엔 지장 없다 */ }
}

function togglePin(fieldId) {
  const pins = loadPins()
  savePins(pins.includes(fieldId) ? pins.filter(i => i !== fieldId) : [...pins, fieldId])
  jiraFieldValues = collectJiraFieldValues()   // 다시 그리기 전에 입력값을 살려둔다
  renderJiraFieldRows()
}

function toggleAllJiraFields() {
  jiraShowAllFields = !jiraShowAllFields
  jiraFieldValues = collectJiraFieldValues()
  renderJiraFieldRows()
}

// 한 필드의 한 줄. 핀 아이콘 → 이름 → 값 컨트롤 순.
function jiraFieldRowHtml(f, pinned) {
  const pid = 'jf_' + f.id
  const pin = `<button type="button" class="pin-btn${pinned ? ' on' : ''}" title="${pinned ? '고정 해제' : '위로 고정'}"
      onclick="togglePin('${escapeHtml(f.id)}')"><i class="ti ti-pin${pinned ? '-filled' : ''}"></i></button>`
  const control = f.options.length
    // 필드 선택지는 몇 개 안 되므로 검색칸을 두지 않는다
    ? `<div class="picker" id="${escapeHtml(pid)}">
         <button type="button" class="picker-btn" onclick="togglePicker('${escapeHtml(pid)}')">
           <span class="picker-label">선택 안 함</span><i class="ti ti-chevron-down"></i>
         </button>
         <div class="picker-panel"><div class="picker-list"></div></div>
       </div>`
    : `<input type="text" class="modal-input" id="${escapeHtml(pid)}"
         placeholder="${escapeHtml(f.kind === 'array:string' ? '쉼표로 구분' : '값')}">`
  return `<div class="jira-row">${pin}
    <span class="jira-row-label" title="${escapeHtml(f.id)}">${escapeHtml(f.name)}</span>${control}</div>`
}

function renderJiraFieldRows() {
  const box = $('jiraMFields')
  if (!box) return
  const pins = loadPins()
  // 고정한 순서대로 위에, 나머지는 원래 순서대로 아래에
  const pinned = pins.map(id => jiraFieldDefs.find(f => f.id === id)).filter(Boolean)
  const rest = jiraFieldDefs.filter(f => !pins.includes(f.id))

  const parts = pinned.map(f => jiraFieldRowHtml(f, true))
  if (rest.length) {
    parts.push(`<div class="jira-row"><span style="width:26px"></span>
      <button class="btn-sm" onclick="toggleAllJiraFields()" style="flex:1; justify-content:center">
        <i class="ti ti-chevron-${jiraShowAllFields ? 'up' : 'down'}"></i>${jiraShowAllFields ? '나머지 필드 접기' : `나머지 필드 ${rest.length}개`}
      </button></div>`)
    if (jiraShowAllFields) parts.push(...rest.map(f => jiraFieldRowHtml(f, false)))
  }
  box.innerHTML = parts.join('')

  // 선택지가 있는 필드는 picker 로, 배열 타입이면 복수 선택으로 초기화한다
  for (const f of [...pinned, ...(jiraShowAllFields ? rest : [])]) {
    if (!f.options.length) continue
    setPickerItems('jf_' + f.id, f.options.map(o => ({ value: o.id, label: o.label })),
      jiraFieldValues[f.id], null, f.kind.startsWith('array:'))
    continue
  }
  // 값이 있는 텍스트 필드도 복원한다
  for (const f of jiraFieldDefs) {
    if (f.options.length) continue
    const el = $('jf_' + f.id)
    if (el && jiraFieldValues[f.id] != null) el.value = jiraFieldValues[f.id]
  }
}

// ── 담당자 ─────────────────────────────────────────────────────
// 선택지가 고정돼 있지 않아 검색으로 찾는다. 타자마다 치면 과하니 250ms 묶어서 보낸다.
let assigneeTimer = null

function searchAssignee(q) {
  clearTimeout(assigneeTimer)
  assigneeTimer = setTimeout(() => loadAssignees(q), 250)
}

async function loadAssignees(q = '') {
  const key = (jiraCfgCache.project || '').toUpperCase()
  if (!key) return
  const r = await window.db.jiraAssignable({ projectKey: key, query: q })
  if (!r.ok) { jiraAuthCheck(r, '담당자 조회'); return }
  // 빈 목록으로 덮어쓰면 복원해 둔 이름표까지 지워진다 (검색어 없이 부르면 빈 결과가 오기도 한다)
  if (!r.users.length) return
  setPickerItems('jiraMAssignee',
    r.users.map(u => ({ value: u.accountId, label: u.name, icon: u.avatar })),
    pickerValue('jiraMAssignee'), null, false, true)
}

// 지금 화면에 입력된 값만 모은다 (빈 값은 buildExtraFields 가 걸러낸다).
// 접혀 있어 화면에 없는 필드는 이전 값을 그대로 유지한다 — 접었다고 값이 날아가면 안 된다.
function collectJiraFieldValues() {
  const out = { ...jiraFieldValues }
  for (const f of jiraFieldDefs) {
    const el = $('jf_' + f.id)
    if (!el) continue
    out[f.id] = f.options.length ? pickerValue('jf_' + f.id) : el.value
  }
  return out
}

async function openJiraConfig() {
  await loadJiraSettings()          // 취소하면 그대로 버려지도록 열 때마다 저장값으로 되돌린다
  $('jiraCfgOverlay')?.classList.add('open')
  $('jiraEmail')?.focus()
}

function closeJiraConfig() { $('jiraCfgOverlay')?.classList.remove('open') }

async function saveJiraConfig() {
  if (!(await saveJiraSettings())) return
  closeJiraConfig()
  showToast('Jira 연결 정보가 저장되었습니다')
}

async function saveJiraSettings() {
  const v = id => ($(id)?.value || '').trim()
  // 아직 연결 테스트 전이라 프로젝트를 못 고른 상태면 빈 값을 보내 기존 설정을 지우지 않는다
  const project = pickerValue('jiraProject').toUpperCase()
  // 스프린트 선택지는 연결이 확인된 뒤에만 보인다. 안 보일 때는 보내지 않아 기존 설정을 그대로 둔다.
  const sprint = $('jiraSprintRow')?.style.display === 'none' ? { ok: true, values: {} } : collectJiraSprintSettings()
  if (!sprint.ok) { showToast(sprint.message, true); return false }
  const r = await window.db.jiraSave({
    ...sprint.values,
    email: v('jiraEmail'),                      // site 는 보내지 않는다 — 메인의 고정값을 쓴다
    project, projectName: project ? projectNameOf(project) : '',
    // issueType 은 등록 팝업에서 고르므로 여기서 보내지 않는다 (메인이 기존 값을 유지)
    token: v('jiraToken'),                      // 비워두면 기존 토큰 유지
    // 체크한 필드의 정의만 함께 저장한다 — 생성할 때 타입별 직렬화에 필요하다
    fieldDefs: jiraFieldDefs.filter(f => f.id in jiraFieldValues),
    fieldValues: jiraFieldValues,
  })
  if (!r.ok) { showToast(r.message || 'Jira 설정 저장 실패', true); return false }
  const tok = $('jiraToken')
  if (tok) tok.value = ''                       // 입력칸에 토큰을 남겨두지 않는다
  if (!r.encrypted) mirrorLog('[Jira] OS 암호화를 쓸 수 없어 토큰이 평문으로 저장됩니다')
  await loadJiraSettings()
  return true
}

// 조회가 실패했을 때 사용자에게 알린다. 토큰 만료(401)는 조용히 지나가면 "필드가 안 보인다"
// 로만 보여서 원인을 알 수 없으므로 따로 짚어 준다. 같은 안내가 연달아 뜨지 않게 한 번만.
let lastJiraAuthWarn = 0
function jiraAuthCheck(r, what) {
  mirrorLog(`[Jira] ${what} 실패 — ${r.message}`)
  if (r.status !== 401) return
  if (Date.now() - lastJiraAuthWarn < 30000) return
  lastJiraAuthWarn = Date.now()
  showToast('Jira 인증이 만료되었습니다 — 설정 → 연결 정보 입력에서 API 토큰을 새로 발급해 주세요', true)
}

// 토큰 발급 페이지를 기본 브라우저로 연다 (앱 안에서 로그인시킬 일이 아니다)
function openTokenPage() {
  window.db.jiraOpen('https://id.atlassian.com/manage-profile/security/api-tokens')
}

async function testJira() {
  await saveJiraSettings()
  showToast('Jira 연결 확인 중...')
  const r = await window.db.jiraTest()
  if (!r.ok) { showToast(r.message || 'Jira 연결 실패', true); mirrorLog('[Jira] 연결 실패 — ' + r.message); return }

  // 연결이 확인되면 그때 프로젝트·이슈 타입 선택지를 꺼내 준다.
  // 재실행 후에도 연결 테스트를 다시 누르지 않게 저장해 둔다 (민감 정보가 아니다)
  jiraProjects = r.projects || []
  localStorage.setItem('db_jira_projects', JSON.stringify(jiraProjects))
  showJiraPickRow(true)
  fillJiraProjectList()
  setText('jiraProjectHint', `이슈를 만들 수 있는 프로젝트 ${jiraProjects.length}개`)
  showToast(`Jira 연결됨${r.name ? ' — ' + r.name : ''} (프로젝트 ${jiraProjects.length}개)`)
  mirrorLog(`[Jira] 연결 확인 ${r.name ? '— ' + r.name + ' ' : ''}| 프로젝트 ${jiraProjects.length}개`)

}

let jiraProjects = []   // [{ key, name }] — 연결 테스트로 받아와 저장해 둔다

// 이슈 타입은 사이트가 아니라 프로젝트마다 다르다 (PROJ 은 에픽/스토리/작업/버그,
// ANR 은 버그/ANR). 그래서 고정 목록 대신 프로젝트에서 받아와 드롭다운을 채운다.
const JIRA_FALLBACK_TYPES = ['버그', '작업', '스토리', '에픽']
const jiraTypeCache = {}   // 프로젝트 키 → 타입 이름 목록
const jiraTypeItems = {}   // 프로젝트 키 → [{ id, name }] (필드 조회에 id 가 필요하다)

function fillTypeSelect(id, types, selected) {
  const sel = $(id)
  if (!sel) return
  // 저장된 값이 목록에 없더라도 지워버리지 않는다 — 사용자가 일부러 넣었을 수 있다
  const list = !selected || types.includes(selected) ? types : [selected, ...types]
  sel.innerHTML = list.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')
  if (selected) sel.value = selected
}

// 이슈 타입은 등록 팝업에서만 고른다 (연결 설정에서는 받지 않는다).
// 프로젝트도 연결 설정에서 고정한 것을 쓴다.
async function refreshIssueTypes(preferred = '') {
  const typeId = 'jiraMType'
  const key = (jiraCfgCache.project || '').trim().toUpperCase()
  const keep = preferred || $(typeId)?.value || jiraCfgCache.issueType || '버그'

  if (jiraTypeCache[key]) { fillTypeSelect(typeId, jiraTypeCache[key], keep); return }
  if (!key || !jiraCfgCache.hasToken) { fillTypeSelect(typeId, JIRA_FALLBACK_TYPES, keep); return }

  const r = await window.db.jiraIssueTypes(key)
  if (!r.ok) { jiraAuthCheck(r, '이슈 타입 조회'); fillTypeSelect(typeId, JIRA_FALLBACK_TYPES, keep); return }
  if (!r.types.length) { fillTypeSelect(typeId, JIRA_FALLBACK_TYPES, keep); return }
  jiraTypeCache[key] = r.types
  jiraTypeItems[key] = r.items || []
  fillTypeSelect(typeId, r.types, keep)
}

// ── 직접 만든 드롭다운 ─────────────────────────────────────────
// 네이티브 select 는 항목이 많으면 브라우저가 위로 펼쳐버리고 그 방향을 지정할 수 없다.
// 패널 위치를 우리가 잡으면 항상 아래로 열리고, 24개쯤 되니 검색도 붙일 수 있다.
const pickerItems = {}     // id → [{ value, label }]
const pickerOnPick = {}    // id → 선택 시 호출할 함수
const pickerMulti = {}     // id → 복수 선택 여부
const pickerSel = {}       // id → 선택된 값 배열 (복수든 단일이든 배열로 들고 있는다)
const pickerClose = {}     // id → 고르면 바로 닫을지 (담당자처럼 하나만 고르는 곳)

function setPickerItems(id, items, selected, onPick, multi = false, closeOnPick = false) {
  pickerItems[id] = items
  pickerMulti[id] = multi
  pickerClose[id] = closeOnPick
  if (onPick) pickerOnPick[id] = onPick
  pickerSel[id] = (Array.isArray(selected) ? selected : selected ? [selected] : []).map(String)
  updatePickerLabel(id)
  renderPickerList(id, '')
}

// 아이콘(프로필 사진)이 있는 항목은 이미지도 같이 보여준다. src 는 우리가 만든 data URL 뿐이다.
function pickerItemHtml(item) {
  const img = item.icon ? `<img class="picker-avatar" src="${item.icon}" alt="">` : ''
  return img + escapeHtml(item.label)
}

function updatePickerLabel(id) {
  const el = $(id)
  if (!el) return
  const sel = pickerSel[id] || []
  const items = pickerItems[id] || []
  const hits = sel.map(v => items.find(i => i.value === v) || { value: v, label: v })
  const label = el.querySelector('.picker-label')
  if (!hits.length) {
    label.textContent = items.length ? '선택 안 함' : '연결 테스트 먼저'
    return
  }
  label.innerHTML = hits.map(pickerItemHtml).join(', ')
}

function renderPickerList(id, q) {
  const el = $(id)
  const list = el?.querySelector('.picker-list')
  if (!list) return
  const sel = pickerSel[id] || []
  const items = (pickerItems[id] || []).filter(i => !q || i.label.toLowerCase().includes(q.toLowerCase()))
  list.innerHTML = items.length
    ? items.map(i => `<div class="picker-item${sel.includes(i.value) ? ' on' : ''}" data-v="${escapeHtml(i.value)}">${pickerItemHtml(i)}</div>`).join('')
    : '<div class="picker-empty">검색 결과가 없습니다</div>'
  // 항목을 골라도 닫지 않는다 — 여러 개를 연달아 고를 수 있어야 한다.
  // 닫히는 건 버튼을 다시 누르거나, 바깥을 클릭하거나, Esc 일 때뿐이다.
  //
  // stopPropagation 이 꼭 필요하다: 아래에서 목록을 다시 그리면 방금 누른 노드가 DOM 에서
  // 떨어져 나가고, 그 상태로 document 까지 올라간 클릭은 closest('.picker') 가 null 이 되어
  // '바깥 클릭'으로 오인된다 — 그래서 목록이 닫혀 버렸다.
  list.querySelectorAll('.picker-item').forEach(node => {
    node.onclick = e => {
      e.stopPropagation()
      pickValue(id, node.dataset.v)
      if (pickerClose[id]) closePickers()        // 담당자처럼 하나만 고르는 곳은 바로 닫는다
      else renderPickerList(id, q)
    }
  })
}

function pickValue(id, value) {
  const cur = pickerSel[id] || []
  if (pickerMulti[id]) {
    pickerSel[id] = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value]
  } else {
    pickerSel[id] = [value]
  }
  updatePickerLabel(id)
  pickerOnPick[id]?.(pickerMulti[id] ? pickerSel[id] : value)
}

// 단일은 문자열, 복수는 배열로 돌려준다
function pickerValue(id) {
  const sel = pickerSel[id] || []
  return pickerMulti[id] ? sel : (sel[0] || '')
}

function closePickers() {
  document.querySelectorAll('.picker.open').forEach(p => p.classList.remove('open'))
}

function togglePicker(id) {
  const el = $(id)
  const willOpen = el && !el.classList.contains('open')
  closePickers()
  if (!willOpen) return
  el.classList.add('open')
  openPickerPanel(el)
  const s = el.querySelector('.picker-search')
  if (s) { s.value = ''; renderPickerList(id, ''); s.focus() }
}

// 패널이 fixed 라 좌표를 직접 잡아준다. 기본은 버튼 바로 아래고, 화면 밖으로 나갈 때만
// 위로 밀어 넣는다 (아래로 여는 동작을 유지하려는 것이다).
function openPickerPanel(el) {
  const panel = el.querySelector('.picker-panel')
  const btn = el.querySelector('.picker-btn')
  if (!panel || !btn) return
  const r = btn.getBoundingClientRect()
  panel.style.left = r.left + 'px'
  panel.style.width = r.width + 'px'
  panel.style.top = r.bottom + 4 + 'px'
  const h = panel.offsetHeight
  if (r.bottom + 4 + h > window.innerHeight - 8) {
    panel.style.top = Math.max(8, window.innerHeight - 8 - h) + 'px'
  }
}

function filterPicker(id, q) { renderPickerList(id, q) }

// 바깥을 누르면 닫는다 (패널·버튼 안쪽 클릭은 제외)
document.addEventListener('click', e => { if (!e.target.closest?.('.picker')) closePickers() })
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePickers() })
// 본문이 스크롤되면 버튼만 움직이고 패널은 fixed 라 제자리에 남는다 — 그냥 닫는다
$('jiraModalBody')?.addEventListener('scroll', closePickers)

// 키만 보면 무슨 프로젝트인지 모르므로 '이름 - 키' 로 보여준다. 값은 키 그대로다.
// 목록을 아직 못 받았으면 저장된 키만 남겨 최소한 지금 설정으로는 계속 쓸 수 있게 한다.
function fillJiraProjectList(selected) {
  const keep = selected || jiraCfgCache.project || ''
  const list = jiraProjects.slice()
  if (keep && !list.some(p => p.key === keep)) list.unshift({ key: keep, name: jiraCfgCache.projectName || keep })
  const items = list.map(p => ({ value: p.key, label: `${p.name} - ${p.key}` }))
  setPickerItems('jiraProject', items, keep, onJiraProjectPicked)
}

function projectNameOf(key) {
  return (jiraProjects.find(p => p.key === key) || {}).name || ''
}

// 연결이 확인되기 전에는 고를 게 없다. 이미 설정이 끝난 상태로 다시 열면 바로 보여준다.
function showJiraPickRow(on) {
  const row = $('jiraPickRow')
  if (row) row.style.display = on ? 'flex' : 'none'
  const sprintRow = $('jiraSprintRow')
  if (sprintRow) sprintRow.style.display = on ? 'block' : 'none'
}

// ── 스프린트 설정 ──────────────────────────────────────────────
// 발행한 티켓을 넣을 스프린트. 실제로 넣는 일은 메인의 jira:create 가 이슈를 만든 뒤에 한다.
//   off    : 넣지 않는다 (백로그)
//   active : 발행할 때마다 그 보드의 진행 중인 스프린트를 찾아 넣는다 — 스프린트가 바뀌어도 다시 고를 필요 없다
//   fixed  : 고른 스프린트에 넣는다 (다음 스프린트 등)
let jiraBoards = []        // 지금 프로젝트의 보드 [{ id, name, type }]
let jiraBoardsFor = ''     // jiraBoards 를 받아 온 프로젝트 키
let jiraSprints = []       // 지금 보드의 진행 중·예정 스프린트
let jiraSprintToken = 0    // 늦게 도착한 응답을 버리는 용도

function jiraSprintModeValue() { return $('jiraSprintMode')?.value || 'off' }
function jiraSelectedProject() { return (pickerValue('jiraProject') || jiraCfgCache.project || '').toUpperCase() }

function fillJiraSelect(id, items, selected) {
  const sel = $(id)
  if (!sel) return
  sel.replaceChildren(...items.map(it => {
    const o = new Option(it.label, String(it.value))
    o.disabled = !!it.disabled
    return o
  }))
  if (selected !== '' && selected != null) sel.value = String(selected)
}

function updateJiraSprintFields() {
  const mode = jiraSprintModeValue()
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none' }
  show('jiraBoardField', mode !== 'off')
  show('jiraSprintField', mode === 'fixed')
}

// 메인과 같은 규칙으로 진행 중인 스프린트를 고른다 (src/jira.js 의 pickActiveSprint) — 안내 문구용
function jiraPickActive(sprints, boardId) {
  const active = sprints.filter(s => s.state === 'active')
  const own = active.filter(s => s.originBoardId === Number(boardId))
  return (own.length ? own : active).slice()
    .sort((a, b) => String(a.endDate || '9').localeCompare(String(b.endDate || '9')))[0] || null
}

function renderJiraSprintSettings(c) {
  const mode = $('jiraSprintMode')
  if (mode) mode.value = c.sprintMode || 'off'
  // 목록을 받기 전에도 저장된 보드·스프린트가 보이게 한 줄씩 넣어 둔다
  fillJiraSelect('jiraBoard', c.boardId ? [{ value: c.boardId, label: c.boardName || `보드 ${c.boardId}` }] : [], c.boardId)
  fillJiraSelect('jiraSprint', c.sprintId ? [{ value: c.sprintId, label: c.sprintName || `스프린트 ${c.sprintId}` }] : [], c.sprintId)
  jiraBoards = []
  jiraBoardsFor = ''
  jiraSprints = []
  updateJiraSprintFields()
  setText('jiraSprintHint', c.sprintMode === 'off' || !c.sprintMode ? '발행한 티켓은 백로그에 남습니다' : '')
  if (c.hasToken && c.project && (c.sprintMode === 'active' || c.sprintMode === 'fixed')) refreshJiraBoards()
}

async function onJiraSprintModeChange() {
  updateJiraSprintFields()
  if (jiraSprintModeValue() === 'off') { jiraSprintToken++; setText('jiraSprintHint', '발행한 티켓은 백로그에 남습니다'); return }
  if (jiraBoardsFor !== jiraSelectedProject()) await refreshJiraBoards()
  else await refreshJiraSprints()
}

// 보드는 프로젝트마다 다르다 — 프로젝트를 바꾸면 고른 보드·스프린트를 비우고 다시 받는다
function onJiraProjectPicked() {
  jiraBoards = []
  jiraBoardsFor = ''
  jiraSprints = []
  fillJiraSelect('jiraBoard', [], '')
  fillJiraSelect('jiraSprint', [], '')
  if (jiraSprintModeValue() !== 'off') refreshJiraBoards()
}

async function refreshJiraBoards() {
  const project = jiraSelectedProject()
  if (!project) { setText('jiraSprintHint', '프로젝트를 먼저 고르세요'); return }
  const token = ++jiraSprintToken
  setText('jiraSprintHint', '보드를 불러오는 중...')
  const r = await window.db.jiraBoards(project)
  if (token !== jiraSprintToken) return
  if (!r.ok) { jiraAuthCheck(r, '보드 조회'); setText('jiraSprintHint', r.message); return }
  jiraBoards = r.boards || []
  jiraBoardsFor = project
  const scrum = jiraBoards.filter(b => b.type !== 'kanban')
  const keep = $('jiraBoard')?.value || jiraCfgCache.boardId
  const selected = scrum.some(b => String(b.id) === String(keep)) ? keep : (scrum[0]?.id ?? '')
  fillJiraSelect('jiraBoard', jiraBoards.map(b => ({
    value: b.id,
    label: b.type === 'kanban' ? `${b.name} (칸반 — 스프린트 없음)` : b.name,
    disabled: b.type === 'kanban',
  })), selected)
  if (!scrum.length) {
    setText('jiraSprintHint', `${project} 프로젝트에는 스크럼 보드가 없어 스프린트를 쓸 수 없습니다`)
    return
  }
  await refreshJiraSprints()
}

async function onJiraBoardChange() {
  jiraSprints = []
  await refreshJiraSprints()
}

async function refreshJiraSprints() {
  const boardId = $('jiraBoard')?.value
  if (!boardId) return
  const token = ++jiraSprintToken
  setText('jiraSprintHint', '스프린트를 불러오는 중...')
  const r = await window.db.jiraSprints(boardId)
  if (token !== jiraSprintToken) return
  if (!r.ok) { jiraAuthCheck(r, '스프린트 조회'); setText('jiraSprintHint', r.message); return }
  jiraSprints = r.sprints || []
  const keep = $('jiraSprint')?.value || jiraCfgCache.sprintId
  const label = s => `${s.name} (${s.state === 'active' ? '진행 중' : '예정'}${s.endDate ? ` · ~${s.endDate.slice(5, 10)}` : ''})`
  const selected = jiraSprints.some(s => String(s.id) === String(keep)) ? keep : (jiraSprints[0]?.id ?? '')
  fillJiraSelect('jiraSprint', jiraSprints.map(s => ({ value: s.id, label: label(s) })), selected)
  if (jiraSprintModeValue() === 'active') {
    const now = jiraPickActive(jiraSprints, boardId)
    setText('jiraSprintHint', now
      ? `지금 발행하면 '${now.name}' 에 들어갑니다. 스프린트가 바뀌면 자동으로 그때의 진행 중인 스프린트에 들어갑니다.`
      : '지금은 진행 중인 스프린트가 없습니다 — 그동안 발행한 티켓은 백로그에 남습니다')
  } else {
    setText('jiraSprintHint', jiraSprints.length
      ? '진행 중·예정 스프린트만 나옵니다. 지정한 스프린트가 완료되면 다시 골라야 합니다.'
      : '진행 중이거나 예정된 스프린트가 없습니다')
  }
}

// 저장할 스프린트 설정. 고를 것이 비었으면 저장하지 않고 이유를 돌려준다.
function collectJiraSprintSettings() {
  const mode = jiraSprintModeValue()
  if (mode === 'off') return { ok: true, values: { sprintMode: 'off' } }
  const boardSel = $('jiraBoard')
  const boardId = Number(boardSel?.value)
  if (!boardId) return { ok: false, message: '스프린트를 쓰려면 보드를 골라 주세요' }
  const boardName = jiraBoards.find(b => b.id === boardId)?.name || boardSel.selectedOptions[0]?.textContent || ''
  if (mode === 'active') return { ok: true, values: { sprintMode: mode, boardId, boardName } }
  const sprintId = Number($('jiraSprint')?.value)
  if (!sprintId) return { ok: false, message: '지정할 스프린트를 골라 주세요' }
  const sprintName = jiraSprints.find(s => s.id === sprintId)?.name
    || (String(jiraCfgCache.sprintId) === String(sprintId) ? jiraCfgCache.sprintName : '') || ''
  return { ok: true, values: { sprintMode: mode, boardId, boardName, sprintId, sprintName } }
}

// 등록 팝업 머리말에 붙이는 "어디로 들어가는지" 설명
function jiraSprintTargetText() {
  const c = jiraCfgCache
  if (c.sprintMode === 'active') return ` · 스프린트: ${c.boardName || '보드'} 의 진행 중인 스프린트`
  if (c.sprintMode === 'fixed') return ` · 스프린트: ${c.sprintName || c.sprintId}`
  return ''
}

// 티켓 본문 초안. 손으로 채울 자리는 비워두고 환경만 확실히 박아 넣는다.
// 로그는 본문에 넣지 않는다 — 파일로만 첨부한다 (본문이 길어지면 읽히지도 않는다).
function buildJiraDescription(withIssue) {
  const d = deviceInfo || {}
  const ver = ($('appVer')?.textContent || '').trim()
  const issue = withIssue ? ($('issueDetail')?.textContent || '').trim() : ''

  return [
    'h3. 환경',
    `* 기기: ${[d.manufacturer, d.model].filter(Boolean).join(' ') || '—'}`,
    `* Android: ${d.release ? `${d.release} (SDK ${d.sdk})` : '—'}`,
    `* 앱: ${currentPkg || '—'} ${ver}`,
    `* 화면: ${state.currentActivityName || '—'}`,
    ...(issue ? [`* 감지된 문제: ${issue}`] : []),
    '',
    'h3. 재현 절차',
    '# ',
    '# ',
    '',
    'h3. 수정 방향',
    '',
  ].join('\n')
}

// fromQa: QA 결과의 실패 항목에서 연 경우 — 미러링 중인 기기가 없어도 되고(증거 파일을 붙인다),
// 쓰다 만 일반 초안을 불러오지도 덮어쓰지도 않는다.
async function openJiraModal(fromIssue = false, fromQa = false) {
  if (!state.serial && !fromQa) { showToast('기기를 먼저 연결해 주세요', true); return }
  await loadJiraSettings()
  if (!jiraCfgCache.hasToken) {
    showToast('Jira 연결 정보를 먼저 입력해 주세요', true)
    openJiraConfig()          // 탭을 옮기는 대신 바로 입력 팝업을 띄운다
    return
  }
  const set = (id, v) => { const el = $(id); if (el) el.value = v }

  // 토큰이 아직 살아 있는지 먼저 확인한다. 만료된 채로 열면 필드가 텅 빈 팝업이 떠서
  // 원인을 알 수 없다. 인증 문제면 팝업 대신 연결 정보 입력을 띄운다.
  const ping = await window.db.jiraPing()
  if (!ping.ok) {
    jiraAuthCheck(ping, 'Jira 연결 확인')
    if (ping.status === 401 || ping.status === 403) { openJiraConfig(); return }
    showToast('Jira 에 연결할 수 없습니다 — ' + ping.message, true)
    return
  }

  // 로그를 첨부할 것이므로 그동안 로그가 더 쌓이지 않게 멈춘다 (닫으면 다시 돌린다)
  jiraPausedDevice = activeDevice
  jiraPausedLogcat = jiraPausedDevice.logcatRunning
  if (jiraPausedLogcat) {
    await window.db.stopLogcat(jiraPausedDevice.serial)
    withActiveDevice(jiraPausedDevice, () => setLogcatRunning(false))
  }

  setText('jiraMTarget', `${jiraCfgCache.projectName ? jiraCfgCache.projectName + ' - ' : ''}${jiraCfgCache.project} 에 등록합니다${jiraSprintTargetText()}`)
  clearJiraVideo()

  // 지난번에 쓰다 만 내용이 있으면 그걸 살리고, 없으면 새 초안을 만든다
  const draft = fromQa ? null : loadJiraDraft()
  jiraFieldValues = draft?.values || {}
  jiraShowAllFields = false
  await refreshIssueTypes(draft?.type || jiraCfgCache.issueType || '버그')   // select 는 채운 뒤에야 값이 잡힌다
  set('jiraMSummary', draft?.summary ?? (fromIssue
    ? `[${currentPkg || '앱'}] ${($('issueTitle')?.textContent || '문제 감지')}`
    : `[${currentPkg || '앱'}] `))
  set('jiraMDesc', draft?.desc ?? buildJiraDescription(fromIssue))
  // 저장해 둔 담당자를 이름표까지 살려 둔다. 전체 목록은 뒤따라 채워진다.
  const seed = draft?.assignee
    ? [{ value: draft.assignee, label: draft.assigneeName || draft.assignee, icon: draft.assigneeIcon || '' }] : []
  setPickerItems('jiraMAssignee', seed, draft?.assignee || '', null, false, true)
  loadAssignees()
  if (draft) {
    if (draft.video) { jiraVideoPath = draft.video; setText('jiraMVideo', draft.video.split(/[\\/]/).pop()); const b = $('jiraMVideoClear'); if (b) b.style.display = '' }
    const shot = $('jiraMShot'); if (shot) shot.checked = draft.shot !== false
    const log = $('jiraMLog'); if (log) log.checked = draft.log !== false
    showToast('이전에 쓰던 내용을 불러왔습니다')
  }
  $('jiraOverlay')?.classList.add('open')
  $('jiraMSummary')?.focus()
  refreshJiraFields()   // 필드 조회는 기다리지 않는다 — 팝업부터 띄운다
}

// 실수로 닫아도 적던 내용이 날아가지 않게 저장해 둔다. 등록에 성공하면 지운다.
const JIRA_DRAFT_KEY = 'db_jira_draft'

function saveJiraDraft() {
  try {
    localStorage.setItem(JIRA_DRAFT_KEY, JSON.stringify({
      type: $('jiraMType')?.value || '',
      summary: $('jiraMSummary')?.value || '',
      desc: $('jiraMDesc')?.value || '',
      values: collectJiraFieldValues(),
      assignee: pickerValue('jiraMAssignee'),
      // 이름·사진까지 저장한다 — accountId 만 들고 있으면 복원했을 때 이름표가 원시 id 로 보인다
      assigneeName: $('jiraMAssignee')?.querySelector('.picker-label')?.textContent || '',
      assigneeIcon: (pickerItems.jiraMAssignee || []).find(i => i.value === pickerValue('jiraMAssignee'))?.icon || '',
      video: jiraVideoPath,
      shot: !!$('jiraMShot')?.checked,
      log: !!$('jiraMLog')?.checked,
    }))
  } catch { /* 저장 못 해도 등록에는 지장 없다 */ }
}

function loadJiraDraft() {
  try { return JSON.parse(localStorage.getItem(JIRA_DRAFT_KEY)) } catch { return null }
}

function clearJiraDraft() { localStorage.removeItem(JIRA_DRAFT_KEY) }

// save=false 는 등록을 마친 뒤에 쓴다. 기본값으로 두면 지운 임시 저장분을 닫으면서
// 화면에 남은 값으로 도로 써버린다 (실제로 그렇게 초기화가 안 됐다).
function closeJiraModal(save = true) {
  // QA 결과에서 연 창은 일반 초안으로 저장하지 않는다 (다음 일반 등록에 QA 내용이 끼지 않게)
  if (save && !jiraQaContext) saveJiraDraft()
  jiraQaContext = null
  $('jiraOverlay')?.classList.remove('open')
  closePickers()
  if (jiraPausedLogcat && jiraPausedDevice?.serial) {
    window.db.startLogcat(jiraPausedDevice.serial)
      .then(result => {
        if (result.ok) withActiveDevice(jiraPausedDevice, () => setLogcatRunning(true))
        else showToast('LogCat 재시작 실패: ' + (result.message || ''), true)
      })
  }
  jiraPausedLogcat = false
}

let jiraPausedLogcat = false
let jiraPausedDevice = null
let jiraVideoPath = ''

async function pickJiraVideo() {
  const p = await window.db.openVideoDialog()
  if (!p) return
  jiraVideoPath = p
  setText('jiraMVideo', p.split(/[\\/]/).pop())
  const btn = $('jiraMVideoClear')
  if (btn) btn.style.display = ''
}

function clearJiraVideo() {
  jiraVideoPath = ''
  setText('jiraMVideo', '선택 안 함')
  const btn = $('jiraMVideoClear')
  if (btn) btn.style.display = 'none'
}

async function submitJira() {
  const btn = $('jiraSubmitBtn')
  const v = id => ($(id)?.value || '').trim()
  if (!v('jiraMSummary')) { showToast('제목을 입력해 주세요', true); return }
  if (!pickerValue('jiraMAssignee')) { showToast('담당자를 선택해 주세요', true); togglePicker('jiraMAssignee'); return }

  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i>등록 중...' }
  const qaCtx = jiraQaContext
  const r = await window.db.jiraCreate({
    // QA 실패 항목이면 실행 기록의 증거 파일을 메인이 붙인다 (경로는 메인이 실행 기록 폴더 안인지 확인한다)
    ...(qaCtx ? { qaRunId: qaCtx.runId, qaItemId: qaCtx.itemId, qaEvidence: qaCtx.evidence } : {}),
    project: jiraCfgCache.project,            // 연결 설정에서 고정한 프로젝트로 보낸다
    issueType: v('jiraMType') || '버그',
    summary: v('jiraMSummary'), description: $('jiraMDesc')?.value || '',
    assigneeId: pickerValue('jiraMAssignee'),
    fieldDefs: jiraFieldDefs, fieldValues: collectJiraFieldValues(),
    attachShot: !!$('jiraMShot')?.checked,
    attachLog: !!$('jiraMLog')?.checked,
    logText: $('jiraMLog')?.checked ? visibleLogcatLines().join('\n') : '',
    videoPath: jiraVideoPath,
    serial: state.serial,
  })
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i>등록' }

  if (!r.ok) { showToast(r.message || 'Jira 등록 실패', true); mirrorLog('[Jira] 등록 실패 — ' + r.message); return }
  closeJiraModal(false)     // 등록했으니 임시 저장 없이 닫고
  if (!qaCtx) clearJiraDraft()   // 저장분도 버린다 (QA 에서 연 창은 일반 초안을 건드리지 않았다)
  jiraFieldValues = {}
  if (qaCtx) {
    // 실행 기록에 티켓 키를 남겨 다음 회차에서 "수정 확인 / 미해결" 과 함께 보이게 한다
    const l = await window.db.qaLinkJira({ runId: qaCtx.runId, itemId: qaCtx.itemId, phase: qaCtx.phase, key: r.key })
    if (!l.ok) mirrorLog(`[QA] Jira 키를 실행 기록에 남기지 못했습니다: ${l.message}`)
    if (qaAuto.run?.id === qaCtx.runId) loadQaRunDetail(qaCtx.runId)
  }
  showToast(`${r.key} 등록 완료${r.sprint ? ` · 스프린트 '${r.sprint}'` : ''}`)
  mirrorLog(`[Jira] ${r.key} 등록 — ${r.url}` + (r.sprint ? ` · 스프린트 ${r.sprint}` : '') + (r.warn ? ` (${r.warn})` : ''))
  if (r.warn) showToast(r.warn, true)
  window.db.jiraOpen(r.url)
}

loadJiraSettings()

// ── 세팅 자동 점검 ──────────────────────────────────────────────
// 예전엔 미러링 탭 위에 배너로 띄웠는데, 자리만 차지해서 미러링 로그 패널로 옮겼다.
let lastSetupSig = null   // 5초마다 도는 점검이라 내용이 바뀔 때만 남긴다 (같은 줄 도배 방지)

async function runSetupCheck() {
  if (setupCheckInFlight) return
  setupCheckInFlight = true
  try {
    const r = await window.db.setupCheck()
    const starter = r.platform === 'win32' ? 'Windows에서_시작.bat' : 'Mac_Linux에서_시작.command'
    const issues = []

    if (!r.adb.found) issues.push(`adb를 찾을 수 없습니다 — 폴더 내의 ${starter} 을 실행하면 자동으로 설치됩니다`)
    if (!r.scrcpy.found) issues.push(`scrcpy를 찾을 수 없습니다 — 폴더 내의 ${starter} 을 실행하면 자동으로 설치됩니다`)
    if (r.adb.found && r.deviceCount === 0) {
      issues.push('연결된 기기가 없습니다 — USB 연결 후 폰에서 "USB 디버깅 허용"을 눌러주세요 (Wi-Fi 연결도 가능)')
    }

    const sig = issues.join('|')
    if (sig === lastSetupSig) return
    lastSetupSig = sig
    if (issues.length) issues.forEach(i => mirrorLog('[세팅] ' + i))
    else mirrorLog(`[세팅] 준비 완료 — adb ${r.adb.version || ''} / scrcpy ${r.scrcpy.version || ''}`.trimEnd())
  } catch (error) {
    const sig = 'error:' + (error.message || String(error))
    if (sig !== lastSetupSig) {
      lastSetupSig = sig
      withActiveDevice(deviceSlots[0], () => mirrorLog('[세팅] 자동 점검 실패: ' + (error.message || String(error))))
    }
  } finally {
    setupCheckInFlight = false
  }
}

let setupCheckInFlight = false
runSetupCheck()
setInterval(runSetupCheck, 5000) // 기기 연결/해제 자동 반영

// ── 패킷 분석 ──────────────────────────────────────────────────
const capturedPackets = []
let proxyRunning = false
let selectedPacket = null

// PC IP 조회 (페이지 로드시)
;(async () => {
  try {
    const ip = await window.db.proxyGetPcIp()
    const el = $('pcIpText')
    if (el) el.textContent = ip
  } catch {}
})()

async function startProxy() {
  if (proxyRunning) return
  const port = parseInt($('proxyPort')?.value || 8888)

  // 패킷 수신 핸들러 등록
  window.db.onProxyPacket(packet => {
    capturedPackets.push(packet)
    addPacketRow(packet)
    $('packetCount').textContent = capturedPackets.length + '건'
  })

  const r = await window.db.proxyStart(port)
  if (r.ok) {
    proxyRunning = true
    $('proxyStatusText').textContent = '캡처 중'
    $('proxyStatusText').style.color = 'var(--accent2)'
    $('proxyStartBtn').style.display = 'none'
    $('proxyStopBtn').style.display = 'flex'
    showToast('프록시 캡처 시작됨 (포트: ' + port + ')')
  } else {
    showToast('프록시 시작 실패: ' + r.message, true)
  }
}

async function stopProxy() {
  await window.db.proxyStop()
  proxyRunning = false
  $('proxyStatusText').textContent = '중지됨'
  $('proxyStatusText').style.color = 'var(--red)'
  $('proxyStartBtn').style.display = 'flex'
  $('proxyStopBtn').style.display = 'none'
  showToast('프록시 캡처 중지됨')
}

async function setupDeviceProxy() {
  if (!requireDevice()) return
  if (!proxyRunning) { showToast('먼저 캡처를 시작하세요', true); return }
  const port = parseInt($('proxyPort')?.value || 8888)
  const r = await window.db.proxySetupDevice({ serial: state.serial, proxyPort: port })
  if (r.ok) {
    showToast(`기기 프록시 설정 완료 → ${r.pcIp}:${r.proxyPort}`)
  } else {
    showToast('기기 프록시 설정 실패: ' + r.message, true)
  }
}

async function clearDeviceProxy() {
  if (!requireDevice()) return
  const r = await window.db.proxyClearDevice(state.serial)
  if (r.ok) showToast('기기 프록시 해제됨')
  else showToast('프록시 해제 실패', true)
}

async function installCACert() {
  if (!requireDevice()) return
  const r = await window.db.proxyInstallCert(state.serial)
  if (r.ok) {
    showToast('CA 인증서가 기기에 전송되었습니다. 보안 설정에서 설치해 주세요.')
  } else {
    showToast('인증서 전송 실패: ' + r.message, true)
  }
}

function clearPackets() {
  capturedPackets.length = 0
  $('packetBody').innerHTML = ''
  $('packetCount').textContent = '0건'
  closePacketDetail()
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function addPacketRow(pkt) {
  const tbody = $('packetBody')

  // 필터 확인
  const kw = ($('packetFilter')?.value || '').toLowerCase()
  const mf = $('methodFilter')?.value || ''
  if (mf && pkt.method !== mf) return
  if (kw && !(pkt.host + pkt.path + pkt.url).toLowerCase().includes(kw)) return

  const tr = document.createElement('tr')
  tr.dataset.packetId = pkt.id

  const method = String(pkt.method || '').toUpperCase()
  const safeMethod = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method) ? method : 'OTHER'
  const methodClass = 'method-' + safeMethod.toLowerCase()
  let statusClass = ''
  if (pkt.statusCode >= 200 && pkt.statusCode < 300) statusClass = 'status-2xx'
  else if (pkt.statusCode >= 300 && pkt.statusCode < 400) statusClass = 'status-3xx'
  else if (pkt.statusCode >= 400 && pkt.statusCode < 500) statusClass = 'status-4xx'
  else if (pkt.statusCode >= 500) statusClass = 'status-5xx'

  const protocol = pkt.protocol === 'HTTPS' ? 'HTTPS' : 'HTTP'
  const protoClass = protocol === 'HTTPS' ? 'proto-https' : 'proto-http'
  const totalSize = (pkt.requestSize || 0) + (pkt.responseSize || 0)
  const time = new Date(pkt.timestamp)
  const timeStr = Number.isNaN(time.getTime()) ? '—' : time.toTimeString().split(' ')[0]

  tr.innerHTML = `
    <td>${escapeHtml(pkt.id)}</td>
    <td class="${protoClass}">${protocol}</td>
    <td class="${methodClass}">${safeMethod}</td>
    <td title="${escapeHtml(pkt.url)}">${escapeHtml(pkt.host)}${escapeHtml(pkt.path)}</td>
    <td class="${statusClass}">${escapeHtml(pkt.statusCode)}</td>
    <td>${formatSize(totalSize)}</td>
    <td>${timeStr}</td>
  `
  tr.onclick = () => showPacketDetail(pkt, tr)
  tbody.appendChild(tr)

  // 자동 스크롤
  const wrap = tbody.closest('.packet-table-wrap')
  if (wrap) wrap.scrollTop = wrap.scrollHeight
}

function filterPackets() {
  const tbody = $('packetBody')
  tbody.innerHTML = ''
  capturedPackets.forEach(pkt => addPacketRow(pkt))
  const visibleCount = tbody.querySelectorAll('tr').length
  $('packetCount').textContent = visibleCount + '건'
}

function showPacketDetail(pkt, trEl) {
  selectedPacket = pkt

  // 행 선택 표시
  document.querySelectorAll('.packet-table tbody tr').forEach(r => r.classList.remove('selected'))
  if (trEl) trEl.classList.add('selected')

  $('packetDetail').style.display = 'block'
  $('detailTitle').textContent = `${pkt.method} ${pkt.url}`

  // 기본적으로 Request Headers 표시
  showDetailTab(document.querySelector('.detail-tab.active') || document.querySelector('.detail-tab'), 'reqHeaders')
}

function showDetailTab(el, tabId) {
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'))
  el.classList.add('active')

  const content = $('detailContent')
  if (!selectedPacket) return

  switch (tabId) {
    case 'reqHeaders':
      content.textContent = formatHeaders(selectedPacket.requestHeaders)
      break
    case 'resHeaders':
      content.textContent = formatHeaders(selectedPacket.responseHeaders)
      break
    case 'reqBody':
      content.textContent = formatBody(selectedPacket.requestBody)
      break
    case 'resBody':
      content.textContent = formatBody(selectedPacket.responseBody)
      break
  }
}

function formatHeaders(headers) {
  if (!headers) return '(없음)'
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')
}

function formatBody(body) {
  if (!body) return '(비어 있음)'
  // JSON 포맷팅 시도
  try {
    const parsed = JSON.parse(body)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return body
  }
}

function closePacketDetail() {
  $('packetDetail').style.display = 'none'
  selectedPacket = null
  document.querySelectorAll('.packet-table tbody tr').forEach(r => r.classList.remove('selected'))
}

// 원본 APK 선택 및 자동 패치
async function patchAndInstallApk() {
  if (!requireDevice()) return
  
  const btn = $('patchApkBtn')
  const originalHtml = btn.innerHTML
  
  try {
    btn.innerHTML = '<i class="ti ti-loader" style="animation: spin 1s linear infinite;"></i>APK 패치 중... (1~3분 소요)'
    btn.style.opacity = '0.7'
    btn.disabled = true
    
    showToast('파일 다이얼로그를 열고 있습니다...')
    const res = await window.db.patchAndInstallApk(state.serial)
    
    if (res.isCancel) {
      showToast('취소되었습니다.')
    } else if (res.ok) {
      showToast(res.message)
    } else {
      showToast('패치 오류: ' + res.message, true)
    }
  } catch (err) {
    showToast('예기치 않은 오류: ' + err.message, true)
  } finally {
    btn.innerHTML = originalHtml
    btn.style.opacity = '1'
    btn.disabled = false
  }
}
