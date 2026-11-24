// Windows: 앱이 관리자 권한(높은 무결성 수준)으로 실행됐는지 알아내고, 그렇다면 일반 권한으로 다시 띄운다.
//
// 왜: 관리자 권한 창에는 Windows 가 일반 권한 탐색기에서 끌어온 파일 드롭을 막는다(UIPI).
//     창 전체에 금지 커서가 뜨고 drop 이벤트가 아예 오지 않아 앱 코드로는 고칠 수 없다.
// 언제 생기나: "모든 사용자용"(Program Files)으로 설치하면 업데이트 설치가 관리자 권한으로 돌고,
//     설치가 끝나며 다시 띄운 앱(runAfterFinish / quitAndInstall 의 강제 실행)이 그 권한을 물려받는다.
//     그래서 "잘 되다가 업데이트 뒤부터 안 된다" 로 보인다 (2026-11-12 사내 PC 에서 확인: HKLM 설치).
// 어떻게: 탐색기(explorer.exe)를 통해 자기 실행 파일을 열면 탐색기의 일반 권한으로 뜬다.
//     UAC 를 끈 PC 처럼 탐색기도 관리자면 다시 띄워도 관리자라 끝없이 반복될 수 있어,
//     직전에 다시 띄운 기록(1분 이내)이 있으면 더 하지 않고 안내만 한다.
//
// 순수 로직(판별·반복 방지)은 단독 실행 자가진단이 있다 (`node src/win-elevation.js`).

// 높은(12288)·시스템(16384) 무결성 수준이면 관리자 권한이다.
// `whoami /groups` 출력에는 언어와 무관하게 SID 가 그대로 찍힌다.
function parseElevated(whoamiGroupsOutput) {
  return /S-1-16-(12288|16384)\b/.test(String(whoamiGroupsOutput || ''))
}

const RELAUNCH_WINDOW_MS = 60 * 1000

// 직전 다시 띄운 시각(ms, 없으면 null)을 보고 이번에 다시 띄워도 되는지
function shouldRelaunch(lastRelaunchAt, now = Date.now()) {
  if (!Number.isFinite(lastRelaunchAt)) return true
  return now - lastRelaunchAt > RELAUNCH_WINDOW_MS
}

// Electron 쪽 — 의존을 인자로 받아 자가진단에서 Electron 없이 불러올 수 있게 한다.
//   deps: { execFileSync, spawn, fs, path, markerFile, execPath, log }
// 반환: 'not-elevated' | 'relaunched' | 'elevated-stay' (다시 띄우지 못해 그대로 관리자 권한)
function ensureUnelevated(deps) {
  const { execFileSync, spawn, fs, path, markerFile, execPath, log = () => {} } = deps
  let out = ''
  try {
    // 전체 경로로 부른다 — PATH 에 Git 의 GNU whoami 가 먼저 있으면 /groups 를 모른다 (실제로 겪었다)
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe')
    out = execFileSync(whoami, ['/groups'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  } catch (e) {
    log(`[권한] 관리자 권한 여부를 확인하지 못했습니다: ${e.message}`)
    return 'not-elevated'
  }
  if (!parseElevated(out)) return 'not-elevated'

  let last = null
  try { last = JSON.parse(fs.readFileSync(markerFile, 'utf8')).at } catch { }
  if (!shouldRelaunch(last)) {
    log('[권한] 관리자 권한으로 실행 중입니다 — 일반 권한으로 다시 띄워도 관리자 권한이라 그대로 둡니다. 탐색기에서 끌어 놓는 APK 설치가 막힐 수 있습니다')
    return 'elevated-stay'
  }
  try { fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() })) } catch { }
  try {
    const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
    const child = spawn(explorer, [execPath], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', e => log(`[권한] 일반 권한으로 다시 띄우지 못했습니다: ${e.message}`))
    child.unref()
  } catch (e) {
    log(`[권한] 일반 권한으로 다시 띄우지 못했습니다: ${e.message}`)
    return 'elevated-stay'
  }
  log('[권한] 관리자 권한으로 실행돼 일반 권한으로 다시 띄웁니다 (끌어 놓기 설치가 막히지 않게)')
  return 'relaunched'
}

module.exports = { parseElevated, shouldRelaunch, ensureUnelevated, RELAUNCH_WINDOW_MS }

// ── 자가진단 ────────────────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert')

  // whoami /groups 실제 출력 형태 (한글 Windows)
  const MEDIUM = `그룹 이름                                  형식             SID          특성
=========================================== ================ ============ ===============
Everyone                                    잘 알려진 그룹   S-1-1-0      필수 그룹
Mandatory Label\\Medium Mandatory Level     레이블           S-1-16-8192`
  const HIGH = MEDIUM.replace('Medium Mandatory Level', 'High Mandatory Level').replace('S-1-16-8192', 'S-1-16-12288')
  const SYSTEM = MEDIUM.replace('S-1-16-8192', 'S-1-16-16384')
  assert.strictEqual(parseElevated(MEDIUM), false)
  assert.strictEqual(parseElevated(HIGH), true)
  assert.strictEqual(parseElevated(SYSTEM), true)
  assert.strictEqual(parseElevated(''), false)
  assert.strictEqual(parseElevated('S-1-16-122880'), false, '다른 숫자의 앞부분이 맞는 경우는 아니다')

  // 반복 방지
  const now = 1_000_000_000
  assert.strictEqual(shouldRelaunch(null, now), true)
  assert.strictEqual(shouldRelaunch(now - 10_000, now), false, '1분 안에 또 다시 띄우지 않는다')
  assert.strictEqual(shouldRelaunch(now - RELAUNCH_WINDOW_MS - 1, now), true)

  // ensureUnelevated: 가짜 의존으로 흐름 확인
  const files = {}
  const spawned = []
  const deps = groups => ({
    execFileSync: () => groups,
    spawn: (cmd, args) => { spawned.push([cmd, args]); return { on() {}, unref() {} } },
    fs: { readFileSync: f => { if (!(f in files)) throw new Error('없음'); return files[f] }, writeFileSync: (f, d) => { files[f] = d } },
    path: require('path'),
    markerFile: 'm.json',
    execPath: 'C:\\Program Files\\DroidBridge\\DroidBridge.exe',
  })
  assert.strictEqual(ensureUnelevated(deps(MEDIUM)), 'not-elevated')
  assert.strictEqual(spawned.length, 0)
  assert.strictEqual(ensureUnelevated(deps(HIGH)), 'relaunched')
  assert.ok(spawned[0][0].toLowerCase().endsWith('explorer.exe') && spawned[0][1][0].endsWith('DroidBridge.exe'), '탐색기로 자기 자신을 연다')
  assert.strictEqual(ensureUnelevated(deps(HIGH)), 'elevated-stay', '바로 또 관리자로 뜨면 반복하지 않는다')
  assert.strictEqual(spawned.length, 1)
  assert.strictEqual(ensureUnelevated({ ...deps(''), execFileSync: () => { throw new Error('whoami 없음') } }), 'not-elevated', '확인 실패는 그냥 진행')

  console.log('win-elevation 자가진단 통과 — 권한 판별·반복 방지·다시 띄우기')
}
