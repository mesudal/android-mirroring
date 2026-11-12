// QA 대상 앱 목록. 앱 하나에 타입(변형) 여러 개, 타입마다 패키지 하나다.
// 새 앱을 QA 대상으로 넣으려면 QA_APPS 에 항목을 추가하면 된다 — 좌측 메뉴의 앱 선택 창과
// QA 탭이 이 목록을 그대로 그린다. 시나리오는 앱 id + 타입 id 로 대상을 가리킨다.
// 순수 데이터·로직이라 단독 실행된다 (`node src/qa-apps.js` = 자가진단).

const QA_APPS = [
  {
    id: 'zerotalk',
    name: '제로톡',
    variants: [
      { id: 'free', name: '무료용', pkg: 'net.zerotalk.free' },
      { id: 'user', name: '단체용 사용자', pkg: 'net.zerotalk.user' },
      { id: 'admin', name: '단체용 관리자', pkg: 'net.zerotalk.admin' },
    ],
  },
]

const ID_RE = /^[a-z][a-z0-9-]*$/
const PKG_RE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/

// 목록이 올바른지. 문제가 없으면 [], 있으면 사유 문자열 배열.
function validateApps(apps) {
  const errors = []
  const appIds = new Set()
  const pkgs = new Set()
  if (!Array.isArray(apps) || !apps.length) return ['앱 목록이 비어 있습니다']
  for (const app of apps) {
    const where = `앱 ${app?.id || '?'}`
    if (!app || !ID_RE.test(app.id || '')) { errors.push(`${where}: id 형식 오류`); continue }
    if (appIds.has(app.id)) errors.push(`${where}: id 중복`)
    appIds.add(app.id)
    if (!app.name) errors.push(`${where}: 이름 없음`)
    if (!Array.isArray(app.variants) || !app.variants.length) { errors.push(`${where}: 타입 없음`); continue }
    const variantIds = new Set()
    for (const v of app.variants) {
      const vw = `${where}/${v?.id || '?'}`
      if (!v || !ID_RE.test(v.id || '')) { errors.push(`${vw}: id 형식 오류`); continue }
      if (variantIds.has(v.id)) errors.push(`${vw}: id 중복`)
      variantIds.add(v.id)
      if (!v.name) errors.push(`${vw}: 이름 없음`)
      if (!PKG_RE.test(v.pkg || '')) errors.push(`${vw}: 패키지명 형식 오류`)
      else if (pkgs.has(v.pkg)) errors.push(`${vw}: 패키지 ${v.pkg} 가 다른 타입과 겹침`)
      pkgs.add(v.pkg)
    }
  }
  return errors
}

function findApp(appId, apps = QA_APPS) {
  return apps.find(app => app.id === appId) || null
}

function findVariant(appId, variantId, apps = QA_APPS) {
  return findApp(appId, apps)?.variants.find(v => v.id === variantId) || null
}

// 패키지명 → { app, variant }. 목록에 없으면 null.
function variantOfPackage(pkg, apps = QA_APPS) {
  for (const app of apps) {
    const variant = app.variants.find(v => v.pkg === pkg)
    if (variant) return { app, variant }
  }
  return null
}

// `dumpsys package <pkg>` 출력에서 그 패키지의 버전. 설치돼 있지 않으면 null.
// 출력에는 다른 패키지 정보(공유 라이브러리 등)도 섞이므로 `Package [<pkg>]` 블록 안에서만 읽는다.
// 주의: `dumpsys package --user 0 <pkg>` 는 패키지 인자를 무시하고 전체를 쏟아낸다 (SM-G986N 실측).
function parsePackageVersion(dump, pkg) {
  const all = String(dump || '')
  const head = all.indexOf(`Package [${pkg}]`)
  if (head < 0) return null
  const rest = all.slice(head + 1)
  const next = rest.search(/\n\s*Package \[/)
  const s = next < 0 ? rest : rest.slice(0, next)
  const code = /versionCode=(\d+)/.exec(s)
  if (!code) return null
  const name = /versionName=(\S+)/.exec(s)
  const updated = /lastUpdateTime=([^\r\n]+)/.exec(s)
  return { versionCode: Number(code[1]), versionName: name ? name[1] : '', lastUpdate: updated ? updated[1].trim() : '' }
}

module.exports = { QA_APPS, validateApps, findApp, findVariant, variantOfPackage, parsePackageVersion }

// ── 자가진단 ────────────────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert')

  // 실제 목록은 언제나 올바라야 한다 — 새 앱을 추가하다 실수하면 여기서 걸린다
  assert.deepStrictEqual(validateApps(QA_APPS), [])

  // 제로톡 3타입
  const zt = findApp('zerotalk')
  assert.strictEqual(zt.name, '제로톡')
  assert.deepStrictEqual(zt.variants.map(v => v.id), ['free', 'user', 'admin'])
  assert.strictEqual(findVariant('zerotalk', 'admin').pkg, 'net.zerotalk.admin')
  assert.strictEqual(findVariant('zerotalk', 'nope'), null)
  assert.strictEqual(findVariant('nope', 'free'), null)

  // 패키지 → 앱·타입
  assert.strictEqual(variantOfPackage('net.zerotalk.user').variant.name, '단체용 사용자')
  assert.strictEqual(variantOfPackage('net.zerotalk.remiadmin'), null, '목록에 없는 패키지')

  // 검증: 흔한 실수들
  assert.ok(validateApps([]).length)
  assert.ok(validateApps([{ id: 'Bad', name: 'x', variants: [{ id: 'a', name: 'a', pkg: 'a.b' }] }]).length, '대문자 id')
  assert.ok(validateApps([{ id: 'x', name: 'x', variants: [] }]).length, '타입 없음')
  assert.ok(validateApps([{ id: 'x', name: 'x', variants: [{ id: 'a', name: 'a', pkg: 'nodot' }] }]).length, '패키지 형식')
  assert.ok(validateApps([
    { id: 'x', name: 'x', variants: [{ id: 'a', name: 'a', pkg: 'a.b' }] },
    { id: 'y', name: 'y', variants: [{ id: 'a', name: 'a', pkg: 'a.b' }] },
  ]).some(e => /겹침/.test(e)), '앱 사이 패키지 중복')
  assert.ok(validateApps([
    { id: 'x', name: 'x', variants: [{ id: 'a', name: 'a', pkg: 'a.b' }] },
    { id: 'x', name: 'x2', variants: [{ id: 'b', name: 'b', pkg: 'a.c' }] },
  ]).some(e => /id 중복/.test(e)), '앱 id 중복')
  // 다른 앱을 추가해도 되는 모양
  assert.deepStrictEqual(validateApps([...QA_APPS,
    { id: 'other-app', name: '다른 앱', variants: [{ id: 'main', name: '기본', pkg: 'com.example.other' }] }]), [])

  // 버전 파싱 (SM-G986N 실측 출력 형태)
  const DUMP = [
    'Packages:',
    '  Package [net.zerotalk.free] (a1b2c3):',
    '    versionCode=55 minSdk=26 targetSdk=36',
    '    versionName=1.0.9',
    '    lastUpdateTime=2026-11-10 14:45:15',
  ].join('\n')
  assert.deepStrictEqual(parsePackageVersion(DUMP, 'net.zerotalk.free'),
    { versionCode: 55, versionName: '1.0.9', lastUpdate: '2026-11-10 14:45:15' })
  assert.strictEqual(parsePackageVersion(DUMP, 'net.zerotalk.user'), null, '다른 패키지 블록을 읽으면 안 된다')
  assert.strictEqual(parsePackageVersion('', 'a.b'), null, '설치 안 됨')
  assert.strictEqual(parsePackageVersion('Unable to find package: no.such.pkg', 'no.such.pkg'), null)
  // 앞에 다른 패키지 블록이 있어도 대상 블록만 읽는다
  const MIXED = [
    'Libraries:', '  Package [com.other] (1):', '    versionCode=999', '    versionName=9.9',
    '  Package [net.zerotalk.user] (2):', '    versionCode=51 minSdk=26', '    versionName=1.2.12',
    '    lastUpdateTime=2026-11-11 11:30:36', '  Package [com.after] (3):', '    versionCode=1',
  ].join('\n')
  assert.deepStrictEqual(parsePackageVersion(MIXED, 'net.zerotalk.user'),
    { versionCode: 51, versionName: '1.2.12', lastUpdate: '2026-11-11 11:30:36' })

  console.log(`qa-apps 자가진단 통과 — 앱 ${QA_APPS.length}개, 타입 ${QA_APPS.reduce((n, a) => n + a.variants.length, 0)}개`)
}
