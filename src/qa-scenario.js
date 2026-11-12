// QA 시나리오 형식 — 검증·공통 절차 펼치기·변수 치환. 순수 로직 (`node src/qa-scenario.js` = 자가진단).
//
// 시나리오 하나 = 체크리스트 항목 하나 (id 가 체크리스트 ID 와 같다).
// {
//   "id": "ZRT_CAA_008",              체크리스트 ID
//   "title": "수신 표시",              (선택) 비우면 체크리스트 제목을 쓴다
//   "mode": "auto" | "semi" | "manual",
//   "roles": ["A", "B"],              필요한 기기 역할. A 가 시험 대상(DUT)
//   "variants": ["free"],             (선택) 이 앱 타입에만 해당. 없으면 모든 타입
//   "update": "before"|"after"|"both",(선택) 업데이트 테스트에서 언제 돌릴지. 없으면 after(=일반 실행)
//   "pre": [단계...],                 사전 조건 — 실패하면 Blocked
//   "steps": [단계...],               본 절차 — 실패하면 Fail
//   "teardown": [단계...]             항상 실행 (바꾼 네트워크·권한 되돌리기)
// }
//
// 단계 모양
//   동작 { "dev": "A", "do": "tap", "sel": {...} }
//   판정 { "dev": "A", "expect": "visible", "sel": {...}, "timeout": 5000 }
//   흐름 { "parallel": [단계 또는 [단계...]] } / { "do": "prompt"|"ask", "message": "..." } / { "use": "공통절차", "dev": "A" }
//   "optional": true 를 붙인 단계는 실패해도 건너뛰고 계속한다 (기기·OS 버전에 따라 안 나오는 권한 창 등)
//
// 변수: "$account.id" (그 단계 기기의 테스트 계정), "$accounts.B.id" (다른 역할 계정), "$pkg" (그 기기의 앱 패키지),
//       "$var.이름" (실행 중 저장한 값). 비밀번호 같은 값은 로그·리포트에 찍지 않는다 (드라이버가 가린다).

const qx = require('./qa-xml')

const MODES = ['auto', 'semi', 'manual']
const UPDATE_PHASES = ['before', 'after', 'both']
const ROLES = ['A', 'B', 'C']

// 동작: 필수 필드 검사기. 값이 문자열이면 오류 메시지.
const ACTIONS = {
  tap: s => needSel(s),
  longPress: s => needSel(s) || optNum(s, 'ms'),
  tapAt: s => (Array.isArray(s.xy) ? qx.selectorError({ xy: s.xy }) : (isNum(s.x) && isNum(s.y) ? null : 'xy:[0~1,0~1] 또는 x·y 픽셀이 필요합니다')),
  swipe: s => (ratioPair(s.from) && ratioPair(s.to) ? optNum(s, 'ms') : 'from·to 는 [0~1, 0~1] 비율 좌표여야 합니다'),
  scrollTo: s => needSel(s),
  type: s => (s.value === undefined ? 'value 가 필요합니다' : (s.sel ? qx.selectorError(s.sel) : null)),
  key: s => (s.key === undefined ? 'key 가 필요합니다' : null),
  launch: () => null,
  stop: () => null,
  clearData: () => null,
  sleep: s => (isNum(s.ms) && s.ms >= 0 ? null : 'ms 가 필요합니다'),
  adb: s => (typeof s.cmd === 'string' && s.cmd.trim() ? null : 'cmd 가 필요합니다'),
  network: s => (typeof s.on === 'boolean' ? null : 'on: true/false 가 필요합니다'),
  screenOff: () => null,
  screenOn: () => null,
  openNotifications: () => null,
  closeNotifications: () => null,
  permission: s => (typeof s.perm === 'string' && typeof s.grant === 'boolean' ? null : 'perm 과 grant: true/false 가 필요합니다'),
  overlay: s => (typeof s.allow === 'boolean' ? null : 'allow: true/false 가 필요합니다'),
  location: s => (typeof s.on === 'boolean' ? null : 'on: true/false 가 필요합니다'),
  snapshot: s => (typeof s.name === 'string' && s.name ? null : 'name 이 필요합니다'),
  prompt: s => (typeof s.message === 'string' && s.message ? null : 'message 가 필요합니다'),
  ask: s => (typeof s.message === 'string' && s.message ? null : 'message 가 필요합니다'),
}

// 판정
const EXPECTS = {
  visible: s => needSel(s) || optNum(s, 'timeout'),
  gone: s => needSel(s) || optNum(s, 'timeout'),
  activity: s => (typeof s.contains === 'string' && s.contains ? optNum(s, 'timeout') : 'contains 가 필요합니다'),
  appRunning: s => optNum(s, 'timeout'),
  appNotRunning: s => optNum(s, 'timeout'),
  audioPlaying: s => optNum(s, 'timeout'),
  audioSilent: s => optNum(s, 'timeout'),
  count: s => needSel(s) || (['==', '!=', '>=', '<=', '>', '<'].includes(s.op || '==') && isNum(s.value) ? null : 'op(==,>=,…) 와 숫자 value 가 필요합니다'),
  sameAsSnapshot: s => (typeof s.name === 'string' && s.name ? (s.ignore === undefined || Array.isArray(s.ignore) ? null : 'ignore 는 정규식 문자열 배열입니다') : 'name 이 필요합니다'),
}

// 기기를 쓰지 않는 단계 (dev 가 없어도 된다)
const NO_DEVICE = new Set(['sleep', 'prompt', 'ask'])

function isNum(v) { return typeof v === 'number' && Number.isFinite(v) }
function ratioPair(v) { return Array.isArray(v) && v.length === 2 && v.every(n => isNum(n) && n >= 0 && n <= 1) }
function needSel(s) { return s.sel ? qx.selectorError(s.sel) : 'sel 이 필요합니다' }
function optNum(s, k) { return s[k] === undefined || isNum(s[k]) ? null : `${k} 는 숫자여야 합니다` }

// 단계 하나 검증. roles 는 이 시나리오가 선언한 역할 (공통 절차 검증 때는 null).
function stepErrors(step, path, roles, procedures) {
  const errs = []
  const add = m => errs.push(`${path}: ${m}`)
  if (!step || typeof step !== 'object' || Array.isArray(step)) { add('단계가 객체가 아닙니다'); return errs }
  if (step.parallel !== undefined) {
    if (!Array.isArray(step.parallel) || step.parallel.length < 2) add('parallel 은 2개 이상의 단계(또는 단계 배열) 목록이어야 합니다')
    else step.parallel.forEach((branch, i) => {
      const list = Array.isArray(branch) ? branch : [branch]
      list.forEach((s, j) => errs.push(...stepErrors(s, `${path}.parallel[${i}]${Array.isArray(branch) ? `[${j}]` : ''}`, roles, procedures)))
    })
    return errs
  }
  if (step.use !== undefined) {
    if (typeof step.use !== 'string' || !step.use) add('use 는 공통 절차 이름입니다')
    else if (procedures && !procedures[step.use]) add(`공통 절차 "${step.use}" 가 없습니다`)
    for (const d of [step.dev, ...(Array.isArray(step.devs) ? step.devs : [])].filter(Boolean)) {
      if (roles && !roles.includes(d) && !String(d).startsWith('$')) add(`역할 ${d} 가 roles 에 없습니다`)
    }
    return errs
  }
  if (step.optional !== undefined && typeof step.optional !== 'boolean') add('optional 은 true/false 입니다')
  const kind = step.do !== undefined ? 'do' : step.expect !== undefined ? 'expect' : null
  if (!kind) { add('do / expect / parallel / use 중 하나가 필요합니다'); return errs }
  const table = kind === 'do' ? ACTIONS : EXPECTS
  const name = step[kind]
  const check = table[name]
  if (!check) { add(`모르는 ${kind === 'do' ? '동작' : '판정'}: ${name}`); return errs }
  const e = check(step)
  if (e) add(`${name} — ${e}`)
  if (!NO_DEVICE.has(name)) {
    if (!step.dev) add(`${name} — dev(역할)가 필요합니다`)
    else if (roles && !roles.includes(step.dev) && !String(step.dev).startsWith('$')) add(`${name} — 역할 ${step.dev} 가 roles 에 없습니다`)
  }
  return errs
}

// 시나리오 검증 → 오류 문자열 배열 (없으면 [])
function validateScenario(sc, procedures = {}) {
  const errs = []
  if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return ['시나리오가 객체가 아닙니다']
  if (typeof sc.id !== 'string' || !sc.id) errs.push('id 가 필요합니다')
  const where = sc.id || '?'
  if (!MODES.includes(sc.mode || 'auto')) errs.push(`${where}: mode 는 auto / semi / manual 입니다`)
  if (sc.update !== undefined && !UPDATE_PHASES.includes(sc.update)) errs.push(`${where}: update 는 before / after / both 입니다`)
  const roles = sc.roles === undefined ? ['A'] : sc.roles
  if (!Array.isArray(roles) || !roles.length || !roles.every(r => ROLES.includes(r))) errs.push(`${where}: roles 는 ["A"], ["A","B"], ["A","B","C"] 형태입니다`)
  else if (!roles.includes('A')) errs.push(`${where}: 역할 A(시험 대상)가 있어야 합니다`)
  if (sc.variants !== undefined && !(Array.isArray(sc.variants) && sc.variants.every(v => typeof v === 'string'))) errs.push(`${where}: variants 는 타입 id 배열입니다`)
  for (const part of ['pre', 'steps', 'teardown']) {
    const list = sc[part]
    if (list === undefined) continue
    if (!Array.isArray(list)) { errs.push(`${where}: ${part} 는 배열입니다`); continue }
    list.forEach((s, i) => errs.push(...stepErrors(s, `${where}.${part}[${i}]`, Array.isArray(roles) ? roles : null, procedures)))
  }
  if (!Array.isArray(sc.steps) || !sc.steps.length) {
    if ((sc.mode || 'auto') === 'auto') errs.push(`${where}: steps 가 비어 있습니다`)
  }
  return errs
}

// 공통 절차 파일 { "procedures": { "이름": [단계...] } } 검증
function validateProcedures(procs) {
  const errs = []
  if (!procs || typeof procs !== 'object' || Array.isArray(procs)) return ['procedures 는 객체입니다']
  for (const [name, steps] of Object.entries(procs)) {
    if (!Array.isArray(steps)) { errs.push(`공통 절차 ${name}: 단계 배열이어야 합니다`); continue }
    steps.forEach((s, i) => errs.push(...stepErrors(s, `공통 절차 ${name}[${i}]`, null, procs)))
  }
  return errs
}

// use 를 펼친다. 공통 절차 안의 "dev": "$dev" 는 호출한 쪽의 dev 로 바뀐다.
// devs 를 주면 기기마다 한 번씩 차례로 펼친다 (예: 같은 채널 입장을 A·B 둘 다).
function expandSteps(steps, procedures, depth = 0) {
  if (depth > 8) throw new Error('공통 절차가 너무 깊게(또는 서로) 불립니다')
  const out = []
  for (const step of steps || []) {
    if (step && step.use) {
      const body = procedures[step.use]
      if (!body) throw new Error(`공통 절차 "${step.use}" 가 없습니다`)
      const devs = Array.isArray(step.devs) && step.devs.length ? step.devs : [step.dev || 'A']
      for (const dev of devs) {
        const bound = JSON.parse(JSON.stringify(body), (k, v) => (v === '$dev' ? dev : v))
        out.push(...expandSteps(bound, procedures, depth + 1).map(s => ({ ...s, _from: step.use })))
      }
    } else if (step && Array.isArray(step.parallel)) {
      out.push({ ...step, parallel: step.parallel.map(b => (Array.isArray(b) ? expandSteps(b, procedures, depth + 1) : expandSteps([b], procedures, depth + 1))) })
    } else out.push(step)
  }
  return out
}

// 문자열 안의 $변수 를 바꾼다. 값이 없으면 오류 (빈 값으로 조용히 진행하지 않게).
//   ctx = { dev, accounts: { A: {...} }, pkgs: { A: 'net…' }, vars: {} }
function substitute(value, ctx) {
  if (typeof value !== 'string' || !value.includes('$')) return value
  // accounts.X 를 account 보다 먼저 맞춰야 한다 ("$accounts.B.id" 가 "$account" 로 먼저 잡히지 않게)
  return value.replace(/\$(accounts\.([ABC])|account|pkg|var)(?:\.([A-Za-z0-9_]+))?/g, (m, kind, role, field) => {
    let v
    if (kind === 'pkg') v = ctx.pkgs?.[ctx.dev]
    else if (kind === 'var') v = ctx.vars?.[field]
    else {
      const acc = ctx.accounts?.[kind === 'account' ? ctx.dev : role]
      if (!acc) throw new Error(`역할 ${kind === 'account' ? ctx.dev : role} 에 테스트 계정이 배정되지 않았습니다`)
      v = acc[field]
    }
    if (v === undefined || v === null || v === '') throw new Error(`변수 ${m} 의 값이 없습니다`)
    return String(v)
  })
}

// 단계 객체 전체에 치환을 적용한 사본 (원본은 그대로)
function bindStep(step, ctx) {
  const c = { ...ctx, dev: step.dev || ctx.dev }
  return JSON.parse(JSON.stringify(step), (k, v) => (typeof v === 'string' && k !== 'dev' ? substitute(v, c) : v))
}

// 시나리오 묶음 정리: 파일 여러 개(배열·단일·공통 절차)를 받아 { scenarios: Map, procedures, errors }
function collectScenarios(files) {
  const procedures = {}
  const scenarios = new Map()
  const errors = []
  const raw = []
  for (const { name, data } of files) {
    if (data && data.procedures) {
      const e = validateProcedures(data.procedures)
      if (e.length) errors.push(...e.map(x => `${name}: ${x}`))
      Object.assign(procedures, data.procedures)
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.scenarios) ? data.scenarios : data && data.id ? [data] : []
    for (const sc of list) raw.push({ name, sc })
  }
  for (const { name, sc } of raw) {
    const e = validateScenario(sc, procedures)
    if (e.length) { errors.push(...e.map(x => `${name}: ${x}`)); continue }
    if (scenarios.has(sc.id)) errors.push(`${name}: ${sc.id} 가 다른 파일에도 있습니다 — 나중 것을 씁니다`)
    scenarios.set(sc.id, { mode: 'auto', roles: ['A'], pre: [], teardown: [], ...sc, _file: name })
  }
  return { scenarios, procedures, errors }
}

module.exports = {
  MODES, ACTIONS, EXPECTS, validateScenario, validateProcedures, expandSteps, substitute, bindStep, collectScenarios,
}

// ── 자가진단 ────────────────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert')
  const procs = {
    '권한 동의 통과': [
      { dev: '$dev', expect: 'visible', sel: { text: '동의하기' } },
      { dev: '$dev', do: 'tap', sel: { text: '동의하기' } },
    ],
    '아이디 로그인': [
      { dev: '$dev', do: 'tap', sel: { class: 'EditText', index: 0 } },
      { dev: '$dev', do: 'type', value: '$account.id' },
      { use: '권한 동의 통과', dev: '$dev' },
    ],
  }
  assert.deepStrictEqual(validateProcedures(procs), [])

  const good = {
    id: 'ZRT_CAA_008', mode: 'auto', roles: ['A', 'B'],
    pre: [{ use: '아이디 로그인', devs: ['A', 'B'] }],
    steps: [
      { dev: 'B', do: 'longPress', sel: { desc: 'PTT' }, ms: 3000 },
      { parallel: [{ dev: 'A', expect: 'visible', sel: { textContains: '수신중' }, timeout: 5000 }, [{ dev: 'B', do: 'sleep', ms: 100 }, { dev: 'B', expect: 'audioSilent' }]] },
      { dev: 'A', expect: 'count', sel: { class: 'Button' }, op: '>=', value: 2 },
      { do: 'ask', message: '소리가 들립니까?' },
    ],
    teardown: [{ dev: 'A', do: 'network', on: true }],
  }
  assert.deepStrictEqual(validateScenario(good, procs), [])

  // 흔한 실수들
  const bad = (patch, re) => {
    const e = validateScenario({ ...good, ...patch }, procs)
    assert.ok(e.some(x => re.test(x)), `${re} 를 기대했는데: ${e.join(' | ')}`)
  }
  bad({ id: '' }, /id 가 필요/)
  bad({ mode: 'fast' }, /mode/)
  bad({ roles: ['B'] }, /역할 A/)
  bad({ roles: ['A', 'D'] }, /roles/)
  bad({ update: 'later' }, /update/)
  bad({ steps: [{ dev: 'A', do: 'fly' }] }, /모르는 동작: fly/)
  bad({ steps: [{ dev: 'A', expect: 'shiny' }] }, /모르는 판정: shiny/)
  bad({ steps: [{ do: 'tap', sel: { text: 'x' } }] }, /dev\(역할\)/)
  bad({ steps: [{ dev: 'C', do: 'tap', sel: { text: 'x' } }] }, /역할 C 가 roles 에 없습니다/)
  bad({ steps: [{ dev: 'A', do: 'tap', sel: { txt: 'x' } }] }, /모르는 셀렉터 키/)
  bad({ steps: [{ dev: 'A', do: 'tap' }] }, /sel 이 필요/)
  bad({ steps: [{ dev: 'A', do: 'swipe', from: [0.5, 0.9], to: [600, 100] }] }, /비율 좌표/)
  bad({ steps: [{ parallel: [{ dev: 'A', do: 'stop' }] }] }, /2개 이상/)
  bad({ steps: [{ use: '없는 절차', dev: 'A' }] }, /공통 절차 "없는 절차"/)
  bad({ steps: [] }, /steps 가 비어/)
  bad({ steps: [{ dev: 'A', expect: 'count', sel: { text: 'x' }, op: '~', value: 1 }] }, /op/)
  // manual 은 steps 가 없어도 된다 (사람이 판정)
  assert.deepStrictEqual(validateScenario({ id: 'X_1', mode: 'manual' }), [])

  // 공통 절차 펼치기: $dev 바인딩, devs 반복, 중첩
  const expanded = expandSteps(good.pre, procs)
  assert.strictEqual(expanded.length, 8, '로그인(2 + 동의 2) × A·B')
  assert.deepStrictEqual(expanded.map(s => s.dev), ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'])
  assert.strictEqual(expanded[1].value, '$account.id', '변수는 실행할 때 바꾼다')
  assert.throws(() => expandSteps([{ use: 'loop' }], { loop: [{ use: 'loop' }] }), /너무 깊게/)
  // parallel 안의 단계도 펼친다
  const par = expandSteps([{ parallel: [{ use: '권한 동의 통과', dev: 'A' }, { dev: 'B', do: 'stop' }] }], procs)
  assert.strictEqual(par[0].parallel[0].length, 2)

  // 변수 치환
  const ctx = { dev: 'A', accounts: { A: { id: 'qa01', password: 'pw!' }, B: { id: 'qa02' } }, pkgs: { A: 'net.zerotalk.free' }, vars: { ch: 'test1' } }
  assert.strictEqual(substitute('$account.id', ctx), 'qa01')
  assert.strictEqual(substitute('$accounts.B.id 에게', ctx), 'qa02 에게')
  assert.strictEqual(substitute('$pkg', ctx), 'net.zerotalk.free')
  assert.strictEqual(substitute('채널 $var.ch', ctx), '채널 test1')
  assert.strictEqual(substitute('그냥 글자', ctx), '그냥 글자')
  assert.throws(() => substitute('$accounts.C.id', ctx), /역할 C 에 테스트 계정/)
  assert.throws(() => substitute('$account.phone', ctx), /값이 없습니다/)
  const bound = bindStep({ dev: 'B', do: 'type', value: '$account.id', sel: { text: '$var.ch' } }, ctx)
  assert.deepStrictEqual([bound.value, bound.sel.text, bound.dev], ['qa02', 'test1', 'B'], '단계의 dev 계정을 쓴다')

  // 파일 묶음
  const col = collectScenarios([
    { name: '_common.json', data: { procedures: procs } },
    { name: 'CA.json', data: [good, { id: 'ZRT_CAA_009', steps: [{ dev: 'A', do: 'tap', sel: { text: 'x' } }] }] },
    { name: 'broken.json', data: { id: 'ZRT_BAD', steps: [{ dev: 'A', do: 'fly' }] } },
  ])
  assert.deepStrictEqual([...col.scenarios.keys()], ['ZRT_CAA_008', 'ZRT_CAA_009'])
  assert.deepStrictEqual(col.scenarios.get('ZRT_CAA_009').roles, ['A'], '기본 역할 A')
  assert.ok(col.errors.some(e => e.startsWith('broken.json') && /fly/.test(e)), '잘못된 시나리오는 빼고 오류로 알린다')

  console.log('qa-scenario 자가진단 통과 — 검증·공통 절차·변수·파일 묶음')
}
