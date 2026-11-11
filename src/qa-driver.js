// QA 자동화 — 기기 1대 제어 드라이버 (ADB 기반).
// 화면 구조를 떠서 요소를 찾고, 탭·입력·대기·기기 상태 변경을 한다.
//
// 규약: 모든 메서드는 예외를 던지지 않고 `{ ok, message, ... }` 를 돌려준다.
// 같은 기기로 가는 adb 명령은 큐로 순서를 보장한다(드라이버 인스턴스 = 기기 1대).
// 서로 다른 기기는 드라이버가 따로라 병렬로 돈다.
//
// Electron 의존이 없다. adb 경로는 호출하는 쪽이 `resolveBin()` 으로 구해 넘긴다.

const { execFile } = require('child_process')
const qx = require('./qa-xml')

const KEY = {
  back: 4, home: 3, recent: 187, screenOff: 223, screenOn: 224,
  volumeUp: 24, volumeDown: 25, enter: 66, del: 67, menu: 82, power: 26,
}

const PKG_RE = /^[A-Za-z][\w.]*$/
const PERM_RE = /^[A-Za-z][\w.]*$/
const sleep = ms => new Promise(r => setTimeout(r, ms))

// `input text` 에 넘길 인자를 만든다. ASCII 만 되고(한글은 주입되지 않는다),
// 공백은 %s 로 바꿔야 하며, 기기 셸이 해석하지 않게 작은따옴표로 감싼다.
function inputTextArg(value) {
  const s = String(value)
  if (!/^[\x20-\x7e]*$/.test(s)) return null
  return "'" + s.replace(/'/g, `'\\''`).replace(/ /g, '%s') + "'"
}

// `dumpsys audio` 출력에서 지정 PID 들이 재생 중(state:started)인 플레이어가 있는지.
// 줄 예: "AudioPlaybackConfiguration piid:95 ... u/pid:10041/2378 state:started attr:..."
function hasStartedPlayer(dump, pids) {
  const set = new Set(pids.map(String))
  return String(dump).split('\n').some(line => {
    if (!/state:started/.test(line)) return false
    const m = /u\/pid:\d+\/(\d+)/.exec(line)
    return !!m && set.has(m[1])
  })
}

// "topResumedActivity=ActivityRecord{c130e3a u0 com.app/.Main t7}" → { pkg, activity }
function parseResumed(out) {
  const m = /\bu\d+\s+([\w.]+)\/([\w.$]+)/.exec(String(out))
  if (!m) return null
  const activity = m[2].startsWith('.') ? m[1] + m[2] : m[2]
  return { pkg: m[1], activity }
}

// opts: { adb: () => 경로 | 경로 문자열, serial, log?: (msg) => void }
function createDriver(opts) {
  const serial = opts.serial
  const adbOf = () => (typeof opts.adb === 'function' ? opts.adb() : opts.adb)
  const log = opts.log || (() => {})
  let tail = Promise.resolve()
  let sdkCache = null
  let netBefore = null   // network('off') 직전 상태 — 되돌릴 때 원래 켜져 있던 것만 켠다

  // 기기별 직렬 큐. 앞 작업이 실패해도 뒤 작업은 돈다.
  function enqueue(fn) {
    const run = tail.then(fn, fn)
    tail = run.then(() => {}, () => {})
    return run
  }

  // adb 한 번 실행. binary=true 면 out 이 Buffer.
  function exec(args, { timeout = 15000, binary = false } = {}) {
    return enqueue(() => new Promise(resolve => {
      const adb = adbOf()
      // 경로가 비면 execFile 이 동기 예외를 던진다 — 규약대로 결과 객체로 바꾼다
      if (!adb) { resolve({ ok: false, message: 'adb 를 찾지 못했습니다', out: binary ? Buffer.alloc(0) : '' }); return }
      if (!serial) { resolve({ ok: false, message: '기기가 지정되지 않았습니다', out: binary ? Buffer.alloc(0) : '' }); return }
      execFile(adb, ['-s', serial, ...args],
        { timeout, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const errText = (stderr ? stderr.toString('utf8') : '').trim()
          if (err) {
            const why = err.killed ? `시간 초과(${timeout}ms)` : (errText || err.message)
            resolve({ ok: false, message: why, out: binary ? stdout : (stdout || '').toString('utf8') })
            return
          }
          resolve({ ok: true, message: errText, out: binary ? stdout : stdout.toString('utf8') })
        })
    }))
  }

  const shell = (cmd, o) => exec(['shell', cmd], o)

  async function sdk() {
    if (sdkCache) return sdkCache
    const r = await shell('getprop ro.build.version.sdk')
    const n = parseInt(r.out, 10)
    if (r.ok && n > 0) sdkCache = n
    return n || 0
  }

  // ── 화면 구조 ────────────────────────────────────────────────
  // 1) exec-out 으로 표준 출력에 바로 받는다  2) 안 되면 파일로 떠서 읽는다.
  // "could not get idle state" 는 화면이 움직이는 중이라는 뜻이라 잠깐 쉬고 다시 뜬다.
  async function dump() {
    let last = ''
    for (let i = 0; i < 3; i++) {
      const r = await exec(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 20000 })
      const xml = qx.stripDumpTail(r.out)
      if (xml) return dumpResult(xml)
      last = (String(r.out).trim() || r.message || '').split('\n')[0]
      if (!/idle state/i.test(last)) break
      await sleep(500)
    }
    const f = await shell('uiautomator dump /sdcard/window_dump.xml', { timeout: 20000 })
    if (f.ok && /dumped to/i.test(f.out)) {
      const c = await exec(['exec-out', 'cat', '/sdcard/window_dump.xml'])
      const xml = qx.stripDumpTail(c.out)
      if (xml) return dumpResult(xml)
    }
    return { ok: false, message: `화면 구조를 얻지 못했습니다: ${last || f.message || '출력 없음'}` }
  }

  function dumpResult(xml) {
    const nodes = qx.parseXml(xml)
    return { ok: true, xml, nodes, screen: qx.screenOf(nodes) }
  }

  // 물리 해상도. 덤프의 최상위 bounds 는 시스템 바를 뺀 크기일 수 있어 xy 셀렉터에는 이쪽을 쓴다.
  async function screenSize() {
    const r = await shell('wm size')
    const m = /Override size:\s*(\d+)x(\d+)/.exec(r.out) || /Physical size:\s*(\d+)x(\d+)/.exec(r.out)
    if (!m) return { ok: false, message: `해상도를 읽지 못했습니다: ${r.message || r.out}` }
    return { ok: true, width: +m[1], height: +m[2] }
  }

  // ── 요소 찾기 ────────────────────────────────────────────────
  async function find(sel) {
    const bad = qx.selectorError(sel)
    if (bad) return { ok: false, message: bad }
    const d = await dump()
    if (!d.ok) return d
    const node = qx.find(d.nodes, sel)
    if (!node) return { ok: false, message: `요소 없음: ${qx.describeSelector(sel)}`, nodes: d.nodes, xml: d.xml }
    return { ok: true, node, nodes: d.nodes, xml: d.xml }
  }

  // 나타날 때까지 덤프를 반복한다. 덤프 한 번이 1~2초라 interval 은 덤프 사이 쉬는 시간이다.
  async function waitFor(sel, { timeout = 10000, interval = 500 } = {}) {
    const bad = qx.selectorError(sel)
    if (bad) return { ok: false, message: bad }
    const until = Date.now() + timeout
    let last
    for (;;) {
      last = await find(sel)
      if (last.ok) return last
      if (Date.now() + interval >= until) break
      await sleep(interval)
    }
    return { ...last, ok: false, message: `${timeout}ms 안에 나타나지 않음: ${qx.describeSelector(sel)}` }
  }

  // 지정 시간 동안 한 번도 보이지 않으면 통과. 덤프 자체가 실패하면 판정 불가로 실패 처리한다.
  async function waitGone(sel, { timeout = 3000, interval = 500 } = {}) {
    const bad = qx.selectorError(sel)
    if (bad) return { ok: false, message: bad }
    const until = Date.now() + timeout
    for (;;) {
      const d = await dump()
      if (!d.ok) return d
      if (qx.find(d.nodes, sel)) {
        return { ok: false, message: `보이면 안 되는 요소가 있음: ${qx.describeSelector(sel)}`, nodes: d.nodes, xml: d.xml }
      }
      if (Date.now() + interval >= until) return { ok: true, message: '' }
      await sleep(interval)
    }
  }

  // 셀렉터 → 좌표. xy 는 덤프 없이 해상도만으로 계산한다(타이밍 항목용).
  async function locate(sel, waitOpts) {
    const bad = qx.selectorError(sel)
    if (bad) return { ok: false, message: bad }
    if (sel.xy) {
      const sz = await screenSize()
      if (!sz.ok) return sz
      return { ok: true, ...qx.resolvePoint([], sel, sz) }
    }
    const r = await waitFor(sel, waitOpts)
    if (!r.ok) return r
    return { ok: true, x: r.node.cx, y: r.node.cy, node: r.node }
  }

  // 화면 끝까지 쓸어 내리며(또는 올리며) 찾는다. 쓸어도 화면이 그대로면 끝에 닿은 것이다.
  async function scrollFind(sel, { maxSwipes = 8, direction = 'down' } = {}) {
    const bad = qx.selectorError(sel)
    if (bad) return { ok: false, message: bad }
    let prev = null
    for (let i = 0; i <= maxSwipes; i++) {
      const d = await dump()
      if (!d.ok) return d
      const node = qx.find(d.nodes, sel)
      if (node) return { ok: true, node, nodes: d.nodes, xml: d.xml }
      if (d.xml === prev || !d.screen) break
      prev = d.xml
      const { width: w, height: h } = d.screen
      const [from, to] = direction === 'up' ? [0.3, 0.7] : [0.7, 0.3]
      await swipe(w / 2, h * from, w / 2, h * to, 300)
      await sleep(400)
    }
    return { ok: false, message: `스크롤해도 찾지 못함: ${qx.describeSelector(sel)}` }
  }

  // ── 동작 ─────────────────────────────────────────────────────
  const px = v => Math.round(Number(v))
  const done = (r, message) => (r.ok ? { ok: true, message } : { ok: false, message: r.message || r.out })

  async function tapAt(x, y) {
    return done(await shell(`input tap ${px(x)} ${px(y)}`), `탭 (${px(x)}, ${px(y)})`)
  }

  async function swipe(x1, y1, x2, y2, ms = 300) {
    return done(await shell(`input swipe ${px(x1)} ${px(y1)} ${px(x2)} ${px(y2)} ${px(ms)}`,
      { timeout: px(ms) + 15000 }), '스와이프')
  }

  async function tap(sel, waitOpts) {
    const p = await locate(sel, waitOpts)
    if (!p.ok) return p
    const r = await tapAt(p.x, p.y)
    return r.ok ? { ...r, x: p.x, y: p.y, node: p.node } : r
  }

  // 길게 누르기 / 누르고 말하기. 제자리 스와이프로 누른 채 유지한다.
  async function longPressAt(x, y, ms = 1000) {
    return done(await shell(`input swipe ${px(x)} ${px(y)} ${px(x)} ${px(y)} ${px(ms)}`,
      { timeout: px(ms) + 15000 }), `길게 누름 ${px(ms)}ms (${px(x)}, ${px(y)})`)
  }

  async function longPress(sel, ms = 1000, waitOpts) {
    const p = await locate(sel, waitOpts)
    if (!p.ok) return p
    const r = await longPressAt(p.x, p.y, ms)
    return r.ok ? { ...r, x: p.x, y: p.y, node: p.node } : r
  }

  // 텍스트 입력. 값은 메시지에 싣지 않는다(비밀번호가 로그·리포트에 남지 않게).
  async function type(value) {
    const arg = inputTextArg(value)
    if (arg === null) return { ok: false, message: 'input text 는 ASCII 만 입력할 수 있습니다 (한글 불가)' }
    return done(await shell(`input text ${arg}`), `텍스트 입력 (${String(value).length}자)`)
  }

  async function key(code) {
    const n = typeof code === 'string' && KEY[code] !== undefined ? KEY[code] : parseInt(code, 10)
    if (!Number.isInteger(n) || n < 0) return { ok: false, message: `모르는 키: ${code}` }
    return done(await shell(`input keyevent ${n}`), `키 ${n}`)
  }

  async function screenshot() {
    const r = await exec(['exec-out', 'screencap', '-p'], { timeout: 20000, binary: true })
    const buf = r.out
    if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.subarray(1, 4).toString() !== 'PNG') {
      return { ok: false, message: r.message || '캡처 결과가 PNG 가 아닙니다' }
    }
    return { ok: true, buf }
  }

  // ── 앱 ───────────────────────────────────────────────────────
  const badPkg = pkg => (PKG_RE.test(String(pkg || '')) ? null : { ok: false, message: `패키지명이 올바르지 않습니다: ${pkg}` })

  async function launch(pkg) {
    const bad = badPkg(pkg); if (bad) return bad
    const r = await shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`)
    if (!r.ok || /No activities found|monkey aborted/i.test(r.out)) {
      return { ok: false, message: `앱을 실행하지 못했습니다: ${pkg}` }
    }
    return { ok: true, message: `${pkg} 실행` }
  }

  async function stop(pkg) {
    const bad = badPkg(pkg); if (bad) return bad
    return done(await shell(`am force-stop ${pkg}`), `${pkg} 종료`)
  }

  async function clearData(pkg) {
    const bad = badPkg(pkg); if (bad) return bad
    const r = await shell(`pm clear ${pkg}`)
    return r.ok && /Success/.test(r.out)
      ? { ok: true, message: `${pkg} 데이터 삭제` }
      : { ok: false, message: `데이터 삭제 실패: ${(r.out || r.message).trim()}` }
  }

  // 프로세스 생존 확인. pidof 는 없으면 종료코드 1 을 내므로 실패를 "없음"으로 읽는다.
  async function pids(pkg) {
    const bad = badPkg(pkg); if (bad) return []
    const r = await shell(`pidof ${pkg}`)
    return String(r.out).trim().split(/\s+/).filter(s => /^\d+$/.test(s))
  }

  async function appRunning(pkg) {
    const bad = badPkg(pkg); if (bad) return bad
    const list = await pids(pkg)
    return { ok: true, running: list.length > 0, pids: list }
  }

  async function currentActivity() {
    const r = await shell("dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'")
    const a = parseResumed(r.out)
    return a ? { ok: true, ...a } : { ok: false, message: '현재 화면을 읽지 못했습니다' }
  }

  // "소리가 들린다"의 간접 판정 — 앱 프로세스가 재생 중인 플레이어를 갖고 있는가.
  async function audioPlaying(pkg) {
    const bad = badPkg(pkg); if (bad) return bad
    const list = await pids(pkg)
    if (!list.length) return { ok: true, playing: false }
    const r = await shell('dumpsys audio', { timeout: 20000 })
    if (!r.ok) return { ok: false, message: `오디오 상태를 읽지 못했습니다: ${r.message}` }
    return { ok: true, playing: hasStartedPlayer(r.out, list) }
  }

  // ── 기기 상태 ────────────────────────────────────────────────
  // 네트워크 끊기 = 와이파이 + 모바일 데이터 차단. 비행기 모드 명령은 Android 11 이상만
  // 되므로(대상에 Android 10 이 있다) 버전과 무관한 이 방식을 쓴다.
  // 무선 디버깅(ip:port)으로 붙은 기기는 와이파이를 끄면 adb 가 끊겨 되돌릴 수 없으므로 거부한다.
  async function network(on) {
    if (!on && /^[\d.]+:\d+$|^\[.*\]:\d+$|_adb-tls-connect/.test(serial)) {
      return { ok: false, message: '무선(ADB over Wi-Fi) 연결 기기는 네트워크를 끊을 수 없습니다. USB 로 연결해 주세요' }
    }
    if (!on) {
      const w = await shell('settings get global wifi_on')
      const m = await shell('settings get global mobile_data')
      netBefore = { wifi: String(w.out).trim() !== '0', data: String(m.out).trim() !== '0' }
      const a = await shell('svc wifi disable')
      const b = await shell('svc data disable')
      return a.ok && b.ok ? { ok: true, message: '네트워크 차단' } : { ok: false, message: a.message || b.message }
    }
    const before = netBefore || { wifi: true, data: true }
    const a = before.wifi ? await shell('svc wifi enable') : { ok: true }
    const b = before.data ? await shell('svc data enable') : { ok: true }
    if (a.ok && b.ok) netBefore = null
    return a.ok && b.ok ? { ok: true, message: '네트워크 복구' } : { ok: false, message: a.message || b.message }
  }

  async function permission(pkg, perm, grant) {
    const bad = badPkg(pkg); if (bad) return bad
    if (!PERM_RE.test(String(perm || ''))) return { ok: false, message: `권한 이름이 올바르지 않습니다: ${perm}` }
    const full = perm.includes('.') ? perm : `android.permission.${perm}`
    const r = await shell(`pm ${grant ? 'grant' : 'revoke'} ${pkg} ${full}`)
    // pm 은 실패해도 종료코드 0 일 수 있어 출력으로 판정한다
    const out = (r.out + ' ' + r.message).trim()
    return r.ok && !/Exception|Error|not a changeable/i.test(out)
      ? { ok: true, message: `${full} ${grant ? '허용' : '거부'}` }
      : { ok: false, message: out.split('\n')[0] }
  }

  // 다른 앱 위에 표시
  async function overlay(pkg, allow) {
    const bad = badPkg(pkg); if (bad) return bad
    return done(await shell(`appops set ${pkg} SYSTEM_ALERT_WINDOW ${allow ? 'allow' : 'deny'}`),
      `다른 앱 위에 표시 ${allow ? '허용' : '거부'}`)
  }

  // 배터리 최적화 제외
  async function batteryWhitelist(pkg, add) {
    const bad = badPkg(pkg); if (bad) return bad
    return done(await shell(`dumpsys deviceidle whitelist ${add ? '+' : '-'}${pkg}`),
      `배터리 최적화 ${add ? '제외' : '적용'}`)
  }

  // 위치 서비스. Android 11(SDK 30) 이상은 cmd location, 그 이하는 secure 설정.
  async function location(on) {
    const cmd = (await sdk()) >= 30
      ? `cmd location set-location-enabled ${on ? 'true' : 'false'}`
      : `settings put secure location_mode ${on ? 3 : 0}`
    return done(await shell(cmd), `위치 서비스 ${on ? '켜기' : '끄기'}`)
  }

  async function notifications(open) {
    return done(await shell(`cmd statusbar ${open ? 'expand-notifications' : 'collapse'}`),
      `알림창 ${open ? '열기' : '닫기'}`)
  }

  return {
    serial, exec, shell, sdk,
    dump, screenSize, find, waitFor, waitGone, locate, scrollFind,
    tap, tapAt, longPress, longPressAt, swipe, type, key, screenshot,
    launch, stop, clearData, appRunning, currentActivity, audioPlaying,
    network, permission, overlay, batteryWhitelist, location, notifications,
    log,
  }
}

module.exports = { createDriver, KEY, inputTextArg, hasStartedPlayer, parseResumed }

// ── 자가진단 (순수 함수만. 기기가 필요한 부분은 여기서 다루지 않는다) ─────────
if (require.main === module) {
  const assert = require('assert')

  // input text 인자: 공백 → %s, 작은따옴표 이스케이프, 한글 거부
  assert.strictEqual(inputTextArg('abc'), "'abc'")
  assert.strictEqual(inputTextArg('a b c'), "'a%sb%sc'")
  assert.strictEqual(inputTextArg("it's"), `'it'\\''s'`)
  assert.strictEqual(inputTextArg('p@ss$1;rm -rf'), "'p@ss$1;rm%s-rf'", '셸 메타문자는 따옴표 안에 갇힌다')
  assert.strictEqual(inputTextArg(''), "''")
  assert.strictEqual(inputTextArg(1234), "'1234'")
  assert.strictEqual(inputTextArg('한글'), null)
  assert.strictEqual(inputTextArg('a\nb'), null, '제어문자 거부')

  // 재생 중 판정: 해당 PID 의 state:started 줄만 센다
  const AUDIO = [
    '  AudioPlaybackConfiguration piid:95 deviceId:2 type:android.media.SoundPool u/pid:10041/2378 state:idle attr:x',
    '  AudioPlaybackConfiguration piid:103 deviceId:2 type:android.media.AudioTrack u/pid:10300/29072 state:started attr:x',
    '  AudioPlaybackConfiguration piid:111 deviceId:2 type:android.media.MediaPlayer u/pid:10301/555 state:paused attr:x',
  ].join('\n')
  assert.strictEqual(hasStartedPlayer(AUDIO, ['29072']), true)
  assert.strictEqual(hasStartedPlayer(AUDIO, ['2378']), false)
  assert.strictEqual(hasStartedPlayer(AUDIO, ['555', '2378']), false)
  assert.strictEqual(hasStartedPlayer(AUDIO, [2378, 29072]), true)
  assert.strictEqual(hasStartedPlayer('', ['1']), false)
  assert.strictEqual(hasStartedPlayer(AUDIO, []), false)

  // 현재 Activity 파싱
  assert.deepStrictEqual(
    parseResumed('    topResumedActivity=ActivityRecord{bc8781 u0 net.zerotalk.free/.flutter_truckuser.MainActivity} t19}'),
    { pkg: 'net.zerotalk.free', activity: 'net.zerotalk.free.flutter_truckuser.MainActivity' })
  assert.deepStrictEqual(
    parseResumed('mResumedActivity: ActivityRecord{1 u0 net.zerotalk.admin/net.zerotalk.truckadmin.ui.splash.SplashActivity t7}'),
    { pkg: 'net.zerotalk.admin', activity: 'net.zerotalk.truckadmin.ui.splash.SplashActivity' })
  assert.strictEqual(parseResumed(''), null)

  // 큐: 같은 드라이버의 명령은 넣은 순서대로 끝난다. 없는 adb 로도 예외 없이 { ok:false }.
  const d = createDriver({ adb: 'adb-가-없는-경로', serial: 'x' })
  const order = []
  Promise.all([
    d.shell('a').then(r => { order.push(1); return r }),
    d.shell('b').then(r => { order.push(2); return r }),
    d.type('한글').then(r => { order.push('type'); return r }),
    d.tap({ 오타: 1 }),
    d.launch('bad pkg; rm'),
    d.key('nope'),
  ]).then(([a, b, t, sel, pkg, k]) => {
    assert.strictEqual(a.ok, false)
    assert.strictEqual(b.ok, false)
    assert.deepStrictEqual(order.filter(n => typeof n === 'number'), [1, 2])
    assert.strictEqual(t.ok, false)
    assert.ok(/ASCII/.test(t.message))
    assert.ok(/모르는 셀렉터 키/.test(sel.message))
    assert.ok(/패키지명/.test(pkg.message), '패키지명 검증으로 셸 주입을 막는다')
    assert.ok(/모르는 키/.test(k.message))
    assert.strictEqual(KEY.back, 4)
    assert.strictEqual(KEY.recent, 187)
    console.log('qa-driver 자가진단 통과')
  }).catch(e => { console.error(e); process.exit(1) })
}
