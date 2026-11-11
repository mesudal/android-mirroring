// QA 회차 기록 — 항목별 지난 결과, 회차 사이 변화, 이번 실행 범위, CSV 내보내기.
// 순수 로직 (`node src/qa-results.js` = 자가진단).
//
// 회차 = 실행 한 번 (run). 같은 앱·타입의 실행들을 시간순으로 보고, 항목마다 "가장 최근에 실행된 결과"를
// 지난 결과로 쓴다. 2차를 Fail 만 골라 돌리면 Pass 항목은 2차에 없으므로, 회차 단위가 아니라
// 항목 단위로 최근 결과를 찾아야 한다.

const STATUSES = ['Pass', 'Fail', 'Blocked', 'Skipped', 'To do']

// 지난 결과 → 이번 결과의 의미
//   fixed      Fail/Blocked → Pass      수정 확인
//   regression Pass → Fail             회귀 (이번 수정으로 깨짐) — 가장 눈에 띄게
//   still      Fail → Fail             아직 안 고쳐짐
//   new        처음 실행
//   same       그 외 (Pass→Pass 등)
function classifyChange(prev, now) {
  if (!now || now === 'To do' || now === 'Skipped') return ''
  if (!prev || prev === 'To do') return 'new'
  if ((prev === 'Fail' || prev === 'Blocked') && now === 'Pass') return 'fixed'
  if (prev === 'Pass' && (now === 'Fail' || now === 'Blocked')) return 'regression'
  if (prev === 'Fail' && now === 'Fail') return 'still'
  return 'same'
}

// 실행 기록들(result.json 들) → { [itemId]: { status, reason, runId, at, jira } }
// 같은 앱·타입만 본다. 실제로 실행된 결과(Pass/Fail/Blocked/Skipped)만 센다 — 중단·미실행(To do)은 건너뛴다.
// 업데이트 테스트의 '업데이트 전' 단계 결과는 기존 버전의 결과라 회차 비교에 쓰지 않는다.
function latestResults(runs, { appId, variantId, before = Infinity } = {}) {
  const sorted = (runs || [])
    .filter(r => r && r.app?.id === appId && (!variantId || r.app?.variant === variantId))
    .filter(r => new Date(r.startedAt).getTime() < before)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
  const latest = {}
  for (const run of sorted) {
    for (const it of run.items || []) {
      if (!it || it.phase === 'before' || it.status === 'To do') continue
      latest[it.id] = { status: it.status, reason: it.reason || '', runId: run.id, at: run.startedAt, jira: it.jira || latest[it.id]?.jira || '' }
    }
  }
  return latest
}

// 이번 실행 범위.
//   scope: 'default' — 지난 Fail·Blocked + 자동 시나리오 항목 전체 + 아직 안 돌린 항목 (Pass 인 수동·반자동 항목만 뺀다)
//          'failed'  — 지난 Fail·Blocked 만 (수정 확인만 빠르게)
//          'all'     — 전부
//          'custom'  — picked 에 든 것만
//   keepPriority: 숫자면, 지난 Pass 인 수동 항목이라도 중요도가 이 값 이상이면 포함 ('default' 에서만)
// 반환: 체크리스트 순서를 지킨 항목 배열
function selectItems({ items, scenarios, latest = {}, scope = 'default', picked = [], keepPriority = null, variantId = null }) {
  const pickedSet = new Set(picked)
  const isAuto = id => {
    const sc = scenarios?.get ? scenarios.get(id) : scenarios?.[id]
    if (!sc || (sc.mode || 'auto') !== 'auto') return false
    return !variantId || !sc.variants || sc.variants.includes(variantId)
  }
  return (items || []).filter(it => {
    const prev = latest[it.id]?.status
    switch (scope) {
      case 'all': return true
      case 'custom': return pickedSet.has(it.id)
      case 'failed': return prev === 'Fail' || prev === 'Blocked'
      default: {
        if (!prev || prev === 'Fail' || prev === 'Blocked') return true
        if (prev === 'Skipped') return false            // iOS 전용·대상 아님 — 다시 돌려도 같다
        if (isAuto(it.id)) return true                   // 자동은 사람 시간이 안 드니 다시 돌린다 (회귀 확인)
        return keepPriority != null && it.priority != null && it.priority >= keepPriority
      }
    }
  })
}

// 요약 숫자
function summarize(items) {
  const s = { total: 0, Pass: 0, Fail: 0, Blocked: 0, Skipped: 0, 'To do': 0, fixed: 0, regression: 0, still: 0 }
  for (const it of items || []) {
    if (it.phase === 'before') continue
    s.total++
    if (s[it.status] !== undefined) s[it.status]++
    if (it.change && s[it.change] !== undefined) s[it.change]++
  }
  return s
}

// 시트에 붙여 넣기 좋은 CSV: ID, 결과, 버그 내용. 체크리스트 순서 그대로 전 항목을 쓴다 —
// 이번 회차에 안 돌린 항목은 지난 결과를 채워 시트 한 열을 통째로 붙일 수 있게 한다.
function toSheetCsv(checklistItems, runItems, latest = {}) {
  const byId = new Map()
  for (const it of runItems || []) if (it.phase !== 'before') byId.set(it.id, it)
  const q = v => {
    const s = String(v ?? '')
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = ['ID,결과,버그 내용']
  for (const item of checklistItems || []) {
    const now = byId.get(item.id)
    const src = now && now.status !== 'To do' ? now : latest[item.id] ? { ...latest[item.id], carried: true } : now
    const status = src?.status || 'To do'
    const bug = status === 'Fail' || status === 'Blocked'
      ? [src.jira, src.reason].filter(Boolean).join(' ')
      : ''
    lines.push([item.id, status, bug].map(q).join(','))
  }
  return '﻿' + lines.join('\r\n') + '\r\n'    // 엑셀·시트가 UTF-8 로 읽게 BOM
}

module.exports = { STATUSES, classifyChange, latestResults, selectItems, summarize, toSheetCsv }

// ── 자가진단 ────────────────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert')

  assert.strictEqual(classifyChange('Fail', 'Pass'), 'fixed')
  assert.strictEqual(classifyChange('Blocked', 'Pass'), 'fixed')
  assert.strictEqual(classifyChange('Pass', 'Fail'), 'regression')
  assert.strictEqual(classifyChange('Fail', 'Fail'), 'still')
  assert.strictEqual(classifyChange(undefined, 'Pass'), 'new')
  assert.strictEqual(classifyChange('Pass', 'Pass'), 'same')
  assert.strictEqual(classifyChange('Pass', 'To do'), '', '안 돌린 것은 비교하지 않는다')

  // 1차: 전부 / 2차: Fail 만 / 다른 타입·다른 앱 기록 섞임 / 2차의 업데이트 전 단계 결과
  const app = (variant = 'free') => ({ id: 'zerotalk', variant })
  const runs = [
    { id: 'r1', startedAt: '2026-11-11T01:00:00Z', app: app(), items: [
      { id: 'A1', status: 'Pass' }, { id: 'A2', status: 'Fail', reason: '문구 없음', jira: 'ZT-1' },
      { id: 'A3', status: 'Pass' }, { id: 'A4', status: 'Skipped' }, { id: 'A5', status: 'Blocked' },
    ] },
    { id: 'r2', startedAt: '2026-11-12T01:00:00Z', app: app(), items: [
      { id: 'A2', status: 'Pass' }, { id: 'A5', status: 'To do', reason: '중단됨' },
      { id: 'A1', status: 'Fail', phase: 'before' },
    ] },
    { id: 'rX', startedAt: '2026-11-13T01:00:00Z', app: app('admin'), items: [{ id: 'A1', status: 'Fail' }] },
    { id: 'rY', startedAt: '2026-11-13T01:00:00Z', app: { id: 'other', variant: 'free' }, items: [{ id: 'A1', status: 'Fail' }] },
  ]
  const latest = latestResults(runs, { appId: 'zerotalk', variantId: 'free' })
  assert.strictEqual(latest.A1.status, 'Pass', '업데이트 전 단계·다른 타입·다른 앱 결과는 쓰지 않는다')
  assert.strictEqual(latest.A2.status, 'Pass', '2차 결과가 최신')
  assert.strictEqual(latest.A2.runId, 'r2')
  assert.strictEqual(latest.A2.jira, 'ZT-1', '지난 Jira 연결은 이어 간다')
  assert.strictEqual(latest.A3.runId, 'r1', '2차에서 안 돌린 Pass 는 1차 결과 그대로')
  assert.strictEqual(latest.A5.status, 'Blocked', '중단(To do)은 덮어쓰지 않는다')
  assert.strictEqual(latestResults(runs, { appId: 'zerotalk', variantId: 'free', before: Date.parse('2026-11-12T00:00:00Z') }).A2.status, 'Fail', 'before 시각 이전만')

  // 실행 범위
  const items = [
    { id: 'A1', priority: 5 }, { id: 'A2', priority: 3 }, { id: 'A3', priority: 3 },
    { id: 'A4', priority: 1 }, { id: 'A5', priority: 1 }, { id: 'A6', priority: 1 }, { id: 'A7', priority: 2 },
  ]
  const scenarios = new Map([
    ['A1', { mode: 'manual' }], ['A2', { mode: 'auto' }], ['A3', { mode: 'auto' }],
    ['A7', { mode: 'auto', variants: ['admin'] }],
  ])
  const prev = { A1: { status: 'Pass' }, A2: { status: 'Fail' }, A3: { status: 'Pass' }, A4: { status: 'Skipped' }, A5: { status: 'Blocked' }, A7: { status: 'Pass' } }
  const ids = o => selectItems({ items, scenarios, latest: prev, variantId: 'free', ...o }).map(i => i.id)
  assert.deepStrictEqual(ids({}), ['A2', 'A3', 'A5', 'A6'], '기본: Fail·Blocked + 자동 + 처음 — Pass 수동(A1)·Skipped(A4)·이 타입 대상 아닌 자동(A7) 제외')
  assert.deepStrictEqual(ids({ keepPriority: 5 }), ['A1', 'A2', 'A3', 'A5', 'A6'], '중요도 5 수동 항목은 포함')
  assert.deepStrictEqual(ids({ scope: 'failed' }), ['A2', 'A5'])
  assert.deepStrictEqual(ids({ scope: 'all' }).length, 7)
  assert.deepStrictEqual(ids({ scope: 'custom', picked: ['A6', 'A1'] }), ['A1', 'A6'], '체크리스트 순서 유지')
  assert.deepStrictEqual(selectItems({ items, scenarios, latest: {} }).length, 7, '첫 회차는 전부')

  // 요약
  const s = summarize([
    { id: 'A1', status: 'Pass', change: 'fixed' }, { id: 'A2', status: 'Fail', change: 'regression' },
    { id: 'A3', status: 'To do' }, { id: 'A1', status: 'Pass', phase: 'before' },
  ])
  assert.deepStrictEqual([s.total, s.Pass, s.Fail, s['To do'], s.fixed, s.regression], [3, 1, 1, 1, 1, 1])

  // CSV: 체크리스트 순서, 안 돌린 항목은 지난 결과, 따옴표 처리, BOM
  const csv = toSheetCsv(
    [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }, { id: 'A9' }],
    [{ id: 'A2', status: 'Fail', reason: '버튼이 "회색"으로, 안 눌림', jira: 'ZT-9' }, { id: 'A1', status: 'Pass' }],
    { A3: { status: 'Pass' } })
  assert.ok(csv.startsWith('﻿ID,결과,버그 내용\r\n'))
  assert.deepStrictEqual(csv.replace('﻿', '').trim().split('\r\n'), [
    'ID,결과,버그 내용', 'A1,Pass,', 'A2,Fail,"ZT-9 버튼이 ""회색""으로, 안 눌림"', 'A3,Pass,', 'A9,To do,',
  ])

  console.log('qa-results 자가진단 통과 — 변화 분류·최근 결과·실행 범위·요약·CSV')
}
