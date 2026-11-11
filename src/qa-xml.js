// QA 자동화 — uiautomator 화면 구조(XML) 파싱과 셀렉터 매칭.
// 순수 로직이라 Electron 없이 단독 실행된다 (`node src/qa-xml.js` = 자가진단).
//
// npm 의존성을 늘리지 않으려고 XML 파서를 쓰지 않는다. uiautomator 덤프는
// `<node 속성="값" ... >` 형태가 규칙적이고 속성값 안의 < > & " 는 전부 엔티티로
// 이스케이프돼 나오므로 정규식으로 충분하다.
//
// Flutter 화면 주의 (제로톡 net.zerotalk.free 에서 실측, 2026-11-11):
//   - 글자가 `text` 가 아니라 `content-desc` 에 들어온다.
//   - `resource-id` 는 비어 있다 (앱이 Semantics identifier 를 달지 않는 한).
//   - 여러 줄 문구는 한 노드의 content-desc 에 줄바꿈(&#10;)으로 이어져 온다.
// 그래서 text 계열 셀렉터는 text 와 content-desc 를 **둘 다** 본다.

// 안드로이드 원문은 오타("hierchary")다. 철자가 고쳐져도 잡히게 느슨하게 맞춘다.
const DUMP_TAIL_RE = /UI hier\w+ dumped to:.*$/s
const NODE_RE = /<node\b([^>]*?)\/?>/g
const ATTR_RE = /([\w:-]+)="([^"]*)"/g
const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/

const SELECTOR_KEYS = [
  'text', 'textContains', 'textMatches', 'desc', 'descContains', 'id', 'class',
  'enabled', 'checked', 'clickable', 'index', 'xy',
]

// 덤프 표준 출력에서 XML 만 남긴다. XML 이 아니면 '' (오류 문구만 온 경우)
function stripDumpTail(raw) {
  const s = String(raw || '')
  const start = s.indexOf('<?xml')
  const from = start >= 0 ? start : s.indexOf('<hierarchy')
  if (from < 0) return ''
  return s.slice(from).replace(DUMP_TAIL_RE, '').trim()
}

function decodeEntities(s) {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === 'amp') return '&'
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    if (e === 'quot') return '"'
    if (e === 'apos') return "'"
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
}

function parseBounds(s) {
  const m = BOUNDS_RE.exec(s || '')
  if (!m) return null
  const [x1, y1, x2, y2] = m.slice(1).map(Number)
  return { x1, y1, x2, y2 }
}

// bounds 의 중심. 탭 좌표로 쓴다.
function centerOf(b) {
  return { x: Math.floor((b.x1 + b.x2) / 2), y: Math.floor((b.y1 + b.y2) / 2) }
}

// XML → 노드 배열 (문서 순서). 깨졌거나 비어 있으면 [].
// 각 노드: { text, desc, label, id, cls, pkg, bounds, cx, cy, visible, enabled, checked, clickable }
//   label   = text || desc  (Flutter 는 desc 쪽에 글자가 온다)
//   visible = 넓이가 있는가. [0,0][0,0] 같은 노드는 누를 수 없으므로 매칭에서 뺀다.
function parseXml(xml) {
  const src = stripDumpTail(xml)
  if (!src) return []
  const nodes = []
  NODE_RE.lastIndex = 0
  let m
  while ((m = NODE_RE.exec(src))) {
    const a = {}
    ATTR_RE.lastIndex = 0
    let am
    while ((am = ATTR_RE.exec(m[1]))) a[am[1]] = decodeEntities(am[2])
    const bounds = parseBounds(a.bounds)
    if (!bounds) continue   // bounds 없는 노드는 쓸 데가 없다
    const c = centerOf(bounds)
    const text = a.text || ''
    const desc = a['content-desc'] || ''
    nodes.push({
      text, desc,
      label: text || desc,
      id: a['resource-id'] || '',
      cls: a.class || '',
      pkg: a.package || '',
      bounds, cx: c.x, cy: c.y,
      visible: bounds.x2 > bounds.x1 && bounds.y2 > bounds.y1,
      enabled: a.enabled !== 'false',
      checked: a.checked === 'true',
      clickable: a.clickable === 'true',
    })
  }
  return nodes
}

// 화면 크기 — 최상위 노드의 bounds. 상태바·내비게이션바를 뺀 앱 창 크기일 수 있으므로
// 정확한 물리 해상도가 필요하면 드라이버의 `wm size` 를 쓴다.
function screenOf(nodes) {
  const b = nodes[0]?.bounds
  return b ? { width: b.x2, height: b.y2 } : null
}

// 셀렉터 검증. 문제 없으면 null, 있으면 사유 문자열.
function selectorError(sel) {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return '셀렉터가 객체가 아닙니다'
  const keys = Object.keys(sel)
  if (!keys.length) return '셀렉터가 비어 있습니다'
  const unknown = keys.filter(k => !SELECTOR_KEYS.includes(k))
  if (unknown.length) return `모르는 셀렉터 키: ${unknown.join(', ')}`
  if (sel.xy !== undefined) {
    const ok = Array.isArray(sel.xy) && sel.xy.length === 2 &&
      sel.xy.every(v => typeof v === 'number' && v >= 0 && v <= 1)
    if (!ok) return 'xy 는 [0~1, 0~1] 비율 좌표여야 합니다'
    if (keys.length > 1) return 'xy 는 다른 조건과 함께 쓸 수 없습니다'
  }
  if (sel.textMatches !== undefined) {
    try { new RegExp(sel.textMatches) } catch (e) { return `textMatches 정규식 오류: ${e.message}` }
  }
  if (sel.index !== undefined && !(Number.isInteger(sel.index) && sel.index >= 0)) {
    return 'index 는 0 이상의 정수여야 합니다'
  }
  if (keys.length === 1 && keys[0] === 'index') return 'index 만으로는 찾을 수 없습니다'
  return null
}

// 글자 비교는 앞뒤 공백을 무시한다. Flutter 가 문구 끝에 줄바꿈을 붙여 주는 일이 있다.
const norm = s => String(s).trim()

function matches(node, sel, re) {
  if (sel.text !== undefined) {
    const want = norm(sel.text)
    if (norm(node.text) !== want && norm(node.desc) !== want) return false
  }
  if (sel.textContains !== undefined) {
    if (!node.text.includes(sel.textContains) && !node.desc.includes(sel.textContains)) return false
  }
  if (re && !re.test(node.text) && !re.test(node.desc)) return false
  if (sel.desc !== undefined && norm(node.desc) !== norm(sel.desc)) return false
  if (sel.descContains !== undefined && !node.desc.includes(sel.descContains)) return false
  if (sel.id !== undefined) {
    // "btn_ptt" 는 "com.app:id/btn_ptt" 와 맞는다. 전체 문자열을 줘도 된다.
    if (node.id !== sel.id && !node.id.endsWith('/' + sel.id)) return false
  }
  if (sel.class !== undefined) {
    // "Button" 은 "android.widget.Button" 과 맞는다
    if (node.cls !== sel.class && !node.cls.endsWith('.' + sel.class)) return false
  }
  if (sel.enabled !== undefined && node.enabled !== sel.enabled) return false
  if (sel.checked !== undefined && node.checked !== sel.checked) return false
  if (sel.clickable !== undefined && node.clickable !== sel.clickable) return false
  return true
}

// 조건에 맞는 보이는 노드 전부 (문서 순서). index 는 여기서 적용하지 않는다.
// xy 셀렉터나 잘못된 셀렉터는 [].
function findAll(nodes, sel) {
  if (selectorError(sel) || sel.xy !== undefined) return []
  const re = sel.textMatches !== undefined ? new RegExp(sel.textMatches) : null
  return nodes.filter(n => n.visible && matches(n, sel, re))
}

// 한 개만. index 가 있으면 n번째(0부터), 없으면 첫 번째. 없으면 null.
function find(nodes, sel) {
  return findAll(nodes, sel)[sel?.index || 0] || null
}

// 셀렉터 → 탭 좌표. xy 는 화면 비율로, 나머지는 찾은 노드의 중심으로 계산한다.
// screen 은 { width, height }. 못 구하면 null.
function resolvePoint(nodes, sel, screen) {
  if (selectorError(sel)) return null
  if (sel.xy !== undefined) {
    const sc = screen || screenOf(nodes)
    if (!sc) return null
    return { x: Math.round(sc.width * sel.xy[0]), y: Math.round(sc.height * sel.xy[1]) }
  }
  const n = find(nodes, sel)
  return n ? { x: n.cx, y: n.cy, node: n } : null
}

// 사람이 읽는 셀렉터 표기 — 로그·실패 사유에 쓴다
function describeSelector(sel) {
  if (!sel || typeof sel !== 'object') return String(sel)
  return Object.entries(sel).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
}

module.exports = {
  SELECTOR_KEYS,
  stripDumpTail, decodeEntities, parseBounds, centerOf,
  parseXml, screenOf, selectorError, findAll, find, resolvePoint, describeSelector,
}

// ── 자가진단 ────────────────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert')

  // 실기기(SM-G986N, Android 13)에서 뜬 Flutter 화면 덤프를 줄인 것 + 네이티브 노드 몇 개
  const HEAD = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>`
  const node = (attrs, inner) => {
    const base = { index: '0', text: '', 'resource-id': '', class: 'android.view.View',
      package: 'net.zerotalk.free', 'content-desc': '', checkable: 'false', checked: 'false',
      clickable: 'false', enabled: 'true', bounds: '[0,0][1080,2201]', ...attrs }
    const s = Object.entries(base).map(([k, v]) => `${k}="${v}"`).join(' ')
    return inner === undefined ? `<node ${s} />` : `<node ${s}>${inner}</node>`
  }
  const SAMPLE = HEAD + `<hierarchy rotation="0">` + node({ class: 'android.widget.FrameLayout' },
    node({ 'content-desc': '전화번호 수집 동의&#10;제로톡은 통화 상태를 구분하기 위해 수집합니다.', bounds: '[0,73][1080,2201]' }) +
    node({ class: 'android.widget.Button', 'content-desc': '앱 종료', clickable: 'true', bounds: '[458,1321][630,1447]' }) +
    node({ class: 'android.widget.Button', 'content-desc': '동의하기', clickable: 'true', bounds: '[630,1321][845,1447]' }) +
    node({ class: 'android.widget.TextView', text: '확인', 'resource-id': 'com.app:id/btn_ok', clickable: 'true', bounds: '[100,100][300,200]' }) +
    node({ class: 'android.widget.TextView', text: '확인', 'resource-id': 'com.app:id/btn_ok2', clickable: 'true', enabled: 'false', bounds: '[100,300][300,400]' }) +
    node({ class: 'android.widget.Switch', text: 'A &amp; B &lt;1&gt; &quot;q&quot;', checked: 'true', bounds: '[0,500][200,560]' }) +
    node({ text: '단말기 변경 횟수가 3회 남았습니다', bounds: '[0,600][800,660]' }) +
    node({ text: '숨은 확인', 'resource-id': 'android:id/navigationBarBackground', bounds: '[0,0][0,0]' })
  ) + `</hierarchy>`

  // 덤프 꼬리 문구 제거 — 안드로이드 원문 오타(hierchary)와 바른 철자 둘 다
  assert.strictEqual(stripDumpTail(SAMPLE + 'UI hierchary dumped to: /dev/tty'), SAMPLE)
  assert.strictEqual(stripDumpTail(SAMPLE + '\nUI hierarchy dumped to: /dev/tty\n'), SAMPLE)
  assert.strictEqual(stripDumpTail(SAMPLE), SAMPLE)
  // XML 이 아닌 출력(오류 문구)은 빈 문자열
  assert.strictEqual(stripDumpTail('ERROR: could not get idle state.'), '')
  assert.strictEqual(stripDumpTail(''), '')
  assert.strictEqual(stripDumpTail(null), '')
  // 앞에 경고 줄이 섞여도 XML 부터 자른다
  assert.strictEqual(stripDumpTail('WARNING: linker\n' + SAMPLE), SAMPLE)

  // 파싱
  const nodes = parseXml(SAMPLE + 'UI hierchary dumped to: /dev/tty')
  assert.strictEqual(nodes.length, 9)
  assert.deepStrictEqual(screenOf(nodes), { width: 1080, height: 2201 })
  assert.strictEqual(nodes[1].desc, '전화번호 수집 동의\n제로톡은 통화 상태를 구분하기 위해 수집합니다.')
  assert.strictEqual(nodes[1].label, nodes[1].desc, 'text 가 비면 label 은 desc')
  assert.strictEqual(nodes[6].text, 'A & B <1> "q"', '엔티티 복원')
  assert.strictEqual(nodes[6].checked, true)
  assert.strictEqual(nodes[5].enabled, false)
  assert.strictEqual(nodes[8].visible, false, '넓이 0 노드')
  assert.strictEqual(decodeEntities('&#xAC00;&#44032;&apos;&unknown;'), "가가'&unknown;")

  // bounds 와 중심
  assert.deepStrictEqual(parseBounds('[458,1321][630,1447]'), { x1: 458, y1: 1321, x2: 630, y2: 1447 })
  assert.strictEqual(parseBounds('[1,2]'), null)
  assert.strictEqual(parseBounds(undefined), null)
  assert.deepStrictEqual(centerOf({ x1: 458, y1: 1321, x2: 630, y2: 1447 }), { x: 544, y: 1384 })
  assert.deepStrictEqual(centerOf({ x1: 0, y1: 0, x2: 1, y2: 1 }), { x: 0, y: 0 })

  // 셀렉터: text 는 text·content-desc 양쪽 완전 일치
  assert.strictEqual(find(nodes, { text: '동의하기' }).cx, 737)          // Flutter: desc 쪽
  assert.strictEqual(find(nodes, { text: '확인' }).id, 'com.app:id/btn_ok')  // 네이티브: text 쪽
  assert.strictEqual(find(nodes, { text: '동의' }), null, '완전 일치는 부분 문자열에 안 맞는다')
  assert.strictEqual(find(nodes, { text: ' 동의하기 ' }).cx, 737, '앞뒤 공백 무시')
  // 넓이 0 노드는 안 잡힌다
  assert.strictEqual(find(nodes, { text: '숨은 확인' }), null)
  assert.strictEqual(find(nodes, { id: 'navigationBarBackground' }), null)

  // textContains / textMatches
  assert.strictEqual(find(nodes, { textContains: '수집 동의' }).bounds.y1, 73)
  assert.strictEqual(findAll(nodes, { textContains: '확인' }).length, 2)
  assert.ok(find(nodes, { textMatches: '단말기 변경 횟수가 \\d+회' }))
  assert.strictEqual(find(nodes, { textMatches: '단말기 변경 횟수가 \\d+번' }), null)
  assert.ok(find(nodes, { textMatches: '^전화번호 수집 동의\\n' }), '여러 줄 desc')

  // desc / id / class
  assert.strictEqual(find(nodes, { desc: '앱 종료' }).cx, 544)
  assert.strictEqual(find(nodes, { desc: '확인' }), null, 'desc 는 content-desc 만 본다')
  assert.ok(find(nodes, { descContains: '통화 상태' }))
  assert.strictEqual(find(nodes, { id: 'btn_ok' }).cy, 150)
  assert.strictEqual(find(nodes, { id: 'com.app:id/btn_ok2' }).cy, 350)
  assert.strictEqual(find(nodes, { id: 'ok' }), null, 'id 는 "/" 뒤 전체가 맞아야 한다')
  assert.strictEqual(findAll(nodes, { class: 'Button' }).length, 2)
  assert.strictEqual(findAll(nodes, { class: 'android.widget.Button' }).length, 2)

  // index / 상태 조건
  assert.strictEqual(find(nodes, { text: '확인', index: 1 }).id, 'com.app:id/btn_ok2')
  assert.strictEqual(find(nodes, { text: '확인', index: 2 }), null)
  assert.strictEqual(find(nodes, { text: '확인', enabled: false }).id, 'com.app:id/btn_ok2')
  assert.strictEqual(findAll(nodes, { class: 'Switch', checked: true }).length, 1)
  assert.strictEqual(findAll(nodes, { class: 'Switch', checked: false }).length, 0)
  assert.strictEqual(findAll(nodes, { clickable: true }).length, 4)

  // 좌표 계산
  assert.deepStrictEqual(resolvePoint(nodes, { xy: [0.5, 0.82] }), { x: 540, y: 1805 })
  assert.deepStrictEqual(resolvePoint(nodes, { xy: [0.5, 0.5] }, { width: 1080, height: 2400 }), { x: 540, y: 1200 })
  const p = resolvePoint(nodes, { text: '동의하기' })
  assert.deepStrictEqual([p.x, p.y], [737, 1384])
  assert.strictEqual(resolvePoint(nodes, { text: '없는 버튼' }), null)
  assert.strictEqual(resolvePoint([], { xy: [0.5, 0.5] }), null, '화면 크기를 모르면 null')

  // 셀렉터 검증
  assert.strictEqual(selectorError({ text: '확인' }), null)
  assert.strictEqual(selectorError({ xy: [0.5, 0.82] }), null)
  assert.ok(selectorError(null))
  assert.ok(selectorError({}))
  assert.ok(selectorError({ txt: '오타' }))
  assert.ok(selectorError({ xy: [540, 1800] }), '픽셀 좌표는 거부')
  assert.ok(selectorError({ xy: [0.5, 0.5], text: '확인' }))
  assert.ok(selectorError({ textMatches: '([' }))
  assert.ok(selectorError({ index: 1 }))
  assert.ok(selectorError({ text: '확인', index: -1 }))
  assert.deepStrictEqual(findAll(nodes, { textMatches: '([' }), [], '잘못된 셀렉터는 예외 없이 []')
  assert.strictEqual(find(nodes, null), null)

  // 빈 화면 · 깨진 XML
  assert.deepStrictEqual(parseXml(''), [])
  assert.deepStrictEqual(parseXml('ERROR: could not get idle state.'), [])
  assert.deepStrictEqual(parseXml(HEAD + '<hierarchy rotation="0"></hierarchy>'), [])
  assert.deepStrictEqual(parseXml(HEAD + '<hierarchy rotation="0" />'), [])
  // 전송이 중간에 끊긴 덤프: 온전한 노드까지만 건진다
  const cut = SAMPLE.slice(0, SAMPLE.indexOf('동의하기') + 10)
  const partial = parseXml(cut)
  assert.strictEqual(partial.length, 3)
  assert.strictEqual(partial[2].desc, '앱 종료')
  // bounds 가 깨진 노드는 버린다
  assert.deepStrictEqual(parseXml(HEAD + '<hierarchy><node text="x" bounds="[0,0]" /></hierarchy>'), [])
  assert.strictEqual(screenOf([]), null)

  assert.strictEqual(describeSelector({ text: '확인', index: 1 }), 'text="확인" index=1')

  console.log('qa-xml 자가진단 통과')
}
