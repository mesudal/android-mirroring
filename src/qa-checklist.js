// QA 체크리스트 가져오기 — 구글 시트(예: "(무전기) 제로톡 클라이언트 QA" 의 v56 탭)를
// CSV 로 내려받은 파일을 항목 목록으로 바꾼다. 순수 로직 (`node src/qa-checklist.js` = 자가진단).
//
// 시트 모양은 사람이 꾸민 표라 고정돼 있지 않다고 보고 느슨하게 읽는다.
//   - 맨 위에 제목·설명 줄이 있을 수 있다 → ID 모양(ZRT_AAA_001)이 처음 나오는 줄 바로 위를 머리글로 본다
//   - 대분류·중분류는 병합 셀이라 첫 줄에만 값이 있다 → 빈칸이면 위의 값을 이어 쓴다
//   - 열 이름은 키워드로 맞춘다 (사전 조건 / 사전조건 / 전제 조건 …)
//   - ID 가 없는 줄(구분 제목 등)은 건너뛴다
// 기기별 결과 열(시트가 기기마다 결과 열을 둔다)은 읽지 않는다 — 결과는 앱이 회차별로 따로 기록한다.

const ID_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

// 열 이름 키워드. 앞에 있는 키일수록 먼저 맞춘다 (title 의 '항목' 이 다른 열을 먹지 않게 마지막에 둔다).
const COLUMN_KEYWORDS = [
  ['id', [/^(tc\s*)?id$/i, /^no\.?$/i, /번호/, /^항목\s*id$/i]],
  ['major', [/대\s*분류/]],
  ['minor', [/중\s*분류/]],
  ['sub', [/소\s*분류/]],
  ['pre', [/사전\s*조건/, /전제\s*조건/, /precondition/i]],
  ['steps', [/절차/, /수행\s*방법/, /테스트\s*방법/, /^steps?$/i]],
  ['expected', [/기대\s*결과/, /예상\s*결과/, /expected/i]],
  ['platform', [/플랫폼/, /^os$/i, /platform/i]],
  ['priority', [/중요도/, /우선\s*순위/, /priority/i]],
  ['type', [/^타입$/, /유형/, /^type$/i]],
  ['note', [/비고/, /^note$/i]],
  ['title', [/테스트\s*항목/, /확인\s*항목/, /시험\s*항목/, /테스트\s*내용/, /^항목$/, /^제목$/, /title/i, /항목/]],
]
const FILL_DOWN = ['major', 'minor', 'sub']

// RFC 4180 CSV. 따옴표 안의 줄바꿈·쉼표·"" 를 처리하고 맨 앞 BOM 을 뗀다.
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += c
      continue
    }
    if (c === '"' && cell === '') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const clean = v => String(v ?? '').replace(/\r\n/g, '\n').trim()

// 머리글 한 줄 → { 필드: 열 번호 }. 한 열은 한 필드에만 쓴다.
function mapColumns(header) {
  const map = {}
  const used = new Set()
  for (const [field, patterns] of COLUMN_KEYWORDS) {
    for (const re of patterns) {
      const idx = header.findIndex((h, i) => !used.has(i) && re.test(clean(h).replace(/\s+/g, ' ')))
      if (idx >= 0) { map[field] = idx; used.add(idx); break }
    }
  }
  return map
}

// CSV 문자열 → { ok, items, columns, warnings } / { ok:false, message }
function parseChecklist(csvText, { name = '' } = {}) {
  const rows = parseCsv(csvText).filter(r => r.some(c => clean(c)))
  if (!rows.length) return { ok: false, message: '빈 파일입니다' }

  // ID 열: ID 모양 값이 가장 많은 열
  const width = Math.max(...rows.map(r => r.length))
  let idCol = -1
  let best = 0
  for (let c = 0; c < width; c++) {
    const n = rows.filter(r => ID_RE.test(clean(r[c]))).length
    if (n > best) { best = n; idCol = c }
  }
  if (idCol < 0) return { ok: false, message: '항목 ID(예: ZRT_AAA_001)가 있는 열을 찾지 못했습니다. 시트를 CSV 로 내려받았는지 확인해 주세요' }
  const firstIdRow = rows.findIndex(r => ID_RE.test(clean(r[idCol])))
  const header = firstIdRow > 0 ? rows[firstIdRow - 1] : []
  const columns = mapColumns(header)
  columns.id = idCol

  const warnings = []
  if (columns.title === undefined) warnings.push('테스트 항목(제목) 열을 찾지 못했습니다')
  if (columns.expected === undefined) warnings.push('기대 결과 열을 찾지 못했습니다')

  const items = []
  const seen = new Set()
  const carry = {}
  for (let r = firstIdRow; r < rows.length; r++) {
    const row = rows[r]
    const get = f => (columns[f] === undefined ? '' : clean(row[columns[f]]))
    for (const f of FILL_DOWN) {
      const v = get(f)
      if (v) carry[f] = v
    }
    const id = get('id')
    if (!ID_RE.test(id)) continue
    if (seen.has(id)) { warnings.push(`ID 가 중복됩니다: ${id} (${r + 1}번째 줄, 처음 것만 씁니다)`); continue }
    seen.add(id)
    const priorityText = get('priority')
    const priorityNum = Number((/\d+/.exec(priorityText) || [])[0])
    items.push({
      id,
      order: items.length,
      major: get('major') || carry.major || '',
      minor: get('minor') || carry.minor || '',
      sub: get('sub') || carry.sub || '',
      title: get('title'),
      pre: get('pre'),
      steps: get('steps'),
      expected: get('expected'),
      platform: get('platform'),
      priority: Number.isFinite(priorityNum) ? priorityNum : null,
      priorityText,
      type: get('type'),
      note: get('note'),
    })
  }
  if (!items.length) return { ok: false, message: '가져올 항목이 없습니다' }
  return { ok: true, name, items, columns, warnings }
}

// 플랫폼 열 값으로 iOS 전용 항목인지 — 지금 자동화는 Android 만 한다
function isIosOnly(item) {
  const p = String(item?.platform || '').toLowerCase()
  if (!p) return false
  return /ios/.test(p) && !/aos|android|공통|all/.test(p)
}

module.exports = { ID_RE, parseCsv, mapColumns, parseChecklist, isIosOnly }

// ── 자가진단 ────────────────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert')

  // CSV: 따옴표 안 줄바꿈·쉼표·"" , CRLF, BOM
  assert.deepStrictEqual(parseCsv('﻿a,b\r\n"x,1","줄1\n줄2"\r\n"say ""hi""",\n'),
    [['a', 'b'], ['x,1', '줄1\n줄2'], ['say "hi"', '']])
  assert.deepStrictEqual(parseCsv('a,b'), [['a', 'b']], '끝 줄바꿈 없음')
  assert.deepStrictEqual(parseCsv(''), [])

  // 시트 모양: 제목 줄 + 머리글 + 병합 셀(빈칸) + 구분 줄 + 기기별 결과 열
  const CSV = [
    '(무전기) 제로톡 클라이언트 QA,,,,,,,,,',
    'v56,,,,,,,,,',
    '대분류,중분류,ID,플랫폼,타입,중요도,테스트 항목,사전 조건,테스트 절차,기대 결과,S9 결과,S20 결과',
    'A. 권한,AA. 권한,ZRT_AAA_001,AOS,공통,5,최초 실행 권한,"앱 최초 설치 상태","1. 앱 실행\n2. 동의하기",권한 안내가 보인다,Pass,',
    ',,ZRT_AAA_002,AOS,공통,4,오디오 권한 거부,,앱 실행 후 거부,"안내 문구, 재요청",,',
    '"[참고] 이 구간은 무료용만",,,,,,,,,',
    ',AB. 업데이트,ZRT_ABA_001,iOS,공통,3,업데이트 안내,,,,',
    'B. 로그인,BA. 무료용,ZRT_BAA_001,AOS/iOS,무료용,높음 5,이메일 로그인,,,,',
    ',,ZRT_AAA_001,AOS,,,중복 ID,,,,',
  ].join('\n')
  const r = parseChecklist(CSV, { name: 'v56' })
  assert.ok(r.ok, r.message)
  assert.deepStrictEqual(r.items.map(i => i.id), ['ZRT_AAA_001', 'ZRT_AAA_002', 'ZRT_ABA_001', 'ZRT_BAA_001'])
  assert.strictEqual(r.columns.id, 2)
  assert.strictEqual(r.columns.title, 6, '"테스트 항목" 열')
  assert.strictEqual(r.columns.steps, 8, '"테스트 절차" 열')
  const [a1, a2, ab, ba] = r.items
  assert.strictEqual(a1.steps, '1. 앱 실행\n2. 동의하기', '셀 안 줄바꿈 유지')
  assert.strictEqual(a1.priority, 5)
  assert.strictEqual(a2.major, 'A. 권한', '병합 셀은 위 값을 이어 쓴다')
  assert.strictEqual(a2.minor, 'AA. 권한')
  assert.strictEqual(a2.expected, '안내 문구, 재요청')
  assert.strictEqual(ab.minor, 'AB. 업데이트', '새 중분류')
  assert.strictEqual(ba.major, 'B. 로그인')
  assert.strictEqual(ba.priority, 5, '"높음 5" 에서 숫자만')
  assert.ok(r.warnings.some(w => w.includes('중복')), '중복 ID 경고')
  assert.deepStrictEqual(r.items.map(i => i.order), [0, 1, 2, 3], '시트 순서 유지')

  // iOS 전용 판별
  assert.strictEqual(isIosOnly(ab), true)
  assert.strictEqual(isIosOnly(ba), false, 'AOS/iOS 는 공통')
  assert.strictEqual(isIosOnly(a1), false)
  assert.strictEqual(isIosOnly({ platform: '' }), false)

  // 머리글이 없어도 ID 열만으로 읽는다 (경고)
  const bare = parseChecklist('ZRT_X_001,제목\nZRT_X_002,제목2')
  assert.ok(bare.ok && bare.items.length === 2)
  assert.ok(bare.warnings.length >= 1)

  // 실패
  assert.strictEqual(parseChecklist('').ok, false)
  assert.ok(/ID/.test(parseChecklist('a,b\nc,d').message))

  console.log('qa-checklist 자가진단 통과 — CSV·머리글·병합 셀·중복·iOS')
}
