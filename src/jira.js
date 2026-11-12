// Jira Cloud 연동 — 이슈 생성 + 첨부.
//
// REST API v2 를 쓴다. v3 는 description 을 ADF(Atlassian Document Format) JSON 으로만 받아서
// QA 리포트 평문을 그대로 넣을 수 없다. v2 는 평문(위키 마크업)이라 우리 용도에 맞다.
//
// Electron 없이도 돌아가도록 순수 Node 로만 짠다 (자가진단: node src/jira.js).

// 사내 Jira 는 한 곳뿐이라 입력받지 않고 고정한다. 조직이 바뀌면 이 한 줄만 고치면 된다.
const DEFAULT_SITE = 'zerosoft0.atlassian.net'

function authHeader(email, token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')
}

// 끝 슬래시를 떼고, 사람이 주소창에서 복사해 온 경로(/jira/..., /browse/...)도 잘라낸다
function apiBase(site) {
  let s = String(site || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  try {
    const u = new URL(s)
    return u.origin
  } catch {
    return s.replace(/\/+$/, '')
  }
}

// Jira 의 오류 응답은 errorMessages(전역) 와 errors(필드별) 두 군데로 나뉘어 오는데,
// 같은 문장이 양쪽에 중복으로 담기는 경우가 많아 한 번만 남긴다.
function errText(r) {
  const b = r.body
  if (b == null) return `HTTP ${r.status}`
  if (typeof b === 'string') return b.slice(0, 300).trim() || `HTTP ${r.status}`
  const raw = [
    ...(b.errorMessages || []),
    ...Object.entries(b.errors || {}).map(([k, v]) => `${k}: ${v}`),
  ]
  const seen = new Set()
  const msgs = []
  for (const m of raw) {
    const body = String(m).replace(/^[a-zA-Z]+:\s*/, '').trim()   // 'project: ...' 접두 제거 후 비교
    if (seen.has(body)) continue
    seen.add(body)
    msgs.push(m)
  }
  if (r.status === 401) msgs.push('인증에 실패했습니다 — API 토큰이 만료되었거나 이메일이 다릅니다')
  if (r.status === 404) msgs.push('사이트 주소 또는 프로젝트 키를 확인해 주세요')
  return msgs.join(' / ') || `HTTP ${r.status}`
}

async function rawFetch(base, cfg, urlPath, opts = {}) {
  const res = await fetch(base + urlPath, {
    ...opts,
    headers: {
      Authorization: authHeader(cfg.email, cfg.token),
      Accept: 'application/json',
      // 이게 없으면 오류 문구가 계정 언어(중국어 등)로 온다
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { ok: res.ok, status: res.status, body }
}

// 사이트 주소 → cloudId. 인증이 필요 없는 공개 엔드포인트다.
const cloudIdCache = new Map()
async function cloudIdOf(site) {
  const base = apiBase(site)
  if (cloudIdCache.has(base)) return cloudIdCache.get(base)
  try {
    const res = await fetch(base + '/_edge/tenant_info')
    const j = await res.json()
    if (j && j.cloudId) { cloudIdCache.set(base, j.cloudId); return j.cloudId }
  } catch { /* 네트워크가 막혀 있으면 그냥 포기한다 */ }
  return null
}

// Atlassian 의 API 토큰은 두 종류다.
//  · 클래식(ATATT…)  : https://사이트.atlassian.net/rest/... 로 직접 먹는다
//  · 스코프형(ATCTT…) : 위 주소로는 401 이고, https://api.atlassian.com/ex/jira/{cloudId}/rest/... 로만 먹는다
// 어느 쪽인지 사용자가 알 길이 없으므로, 사이트 주소로 먼저 쳐 보고 401 이면 게이트웨이로 한 번 더 친다.
const baseCache = new Map()   // 사이트 → 실제로 인증이 통한 base. 한 번 알아내면 계속 그걸 쓴다

async function jiraFetch(cfg, urlPath, opts = {}) {
  const site = apiBase(cfg.site)
  // 첨부(FormData)는 한 번 보내면 재사용이 안 되므로 시도마다 새로 만든다
  const attempt = () => (opts.makeBody ? { ...opts, body: opts.makeBody() } : opts)

  const known = baseCache.get(site)
  const first = await rawFetch(known || site, cfg, urlPath, attempt())
  if (first.status !== 401) {
    baseCache.set(site, known || site)
    return first
  }
  if (known) return first                     // 이미 아는 경로에서 401 이면 진짜 인증 문제다

  const cloudId = await cloudIdOf(cfg.site)
  if (!cloudId) return first
  const gw = `https://api.atlassian.com/ex/jira/${cloudId}`
  const second = await rawFetch(gw, cfg, urlPath, attempt())
  if (second.status === 401) return first
  baseCache.set(site, gw)
  return second
}

// 연결 확인은 프로젝트 목록으로 한다. /myself 로 확인하면, 스코프형 토큰에서 사용자 정보
// 권한만 빠져도 실제로는 멀쩡한 연결을 "인증 실패"로 잘못 판정한다 (실제로 겪었다).
// 겸사겸사 만들 수 있는 프로젝트 키를 돌려줘서 키를 손으로 외우지 않게 한다.
async function testConn(cfg) {
  const miss = missingFields(cfg)
  if (miss) return { ok: false, message: miss }
  try {
    const r = await jiraFetch(cfg, '/rest/api/2/project/search?maxResults=50&orderBy=key')
    if (!r.ok) return { ok: false, message: errText(r), status: r.status }
    // 키만 보면 무슨 프로젝트인지 모르니 이름도 같이 넘긴다
    const projects = (r.body.values || []).map(p => ({ key: p.key, name: p.name || p.key }))
    const keys = projects.map(p => p.key)

    // 이름은 있으면 좋고 없어도 그만 — 권한이 없어도 연결 판정에 쓰지 않는다
    let name = ''
    try {
      const me = await jiraFetch(cfg, '/rest/api/3/myself')
      if (me.ok) name = me.body.displayName || ''
    } catch { /* 무시 */ }

    return { ok: true, name, keys, projects, total: r.body.total ?? keys.length }
  } catch (e) {
    return { ok: false, message: `연결 실패: ${e.message}` }
  }
}

// 등록 팝업을 열 때마다 토큰이 아직 살아 있는지 확인하는 용도. 가장 가벼운 요청으로
// 친다(프로젝트 1건). /myself 는 스코프형 토큰에서 권한이 빠질 수 있어 쓰지 않는다.
async function pingAuth(cfg) {
  const miss = missingFields(cfg)
  if (miss) return { ok: false, message: miss }
  try {
    const r = await jiraFetch(cfg, '/rest/api/2/project/search?maxResults=1')
    if (!r.ok) return { ok: false, message: errText(r), status: r.status }
    return { ok: true }
  } catch (e) {
    return { ok: false, message: `연결 실패: ${e.message}`, status: 0 }
  }
}

function missingFields(cfg) {
  if (!apiBase(cfg && cfg.site)) return 'Jira 사이트 주소가 비어 있습니다'
  if (!cfg.email) return 'Jira 이메일이 비어 있습니다'
  if (!cfg.token) return 'Jira API 토큰이 비어 있습니다'
  return null
}

// 이슈 타입은 프로젝트마다 다르다 (같은 사이트에서도 PROJ 은 에픽/스토리/작업/버그,
// ANR 은 버그/ANR 이다). 그래서 고정 목록을 두지 않고 프로젝트에서 직접 받아온다.
// createmeta 대신 project 조회를 쓴다 — 엔드포인트가 안 바뀌고 한 번만 치면 된다.
async function listIssueTypes(cfg, projectKey) {
  const key = String(projectKey || '').trim().toUpperCase()
  if (!key) return { ok: false, message: '프로젝트 키가 없습니다' }
  const miss = missingFields(cfg)
  if (miss) return { ok: false, message: miss }
  try {
    const r = await jiraFetch(cfg, `/rest/api/2/project/${encodeURIComponent(key)}`)
    if (!r.ok) return { ok: false, message: errText(r), status: r.status }
    const list = (r.body.issueTypes || []).filter(t => !t.subtask)   // 하위 작업은 부모 없이는 못 만든다
    return { ok: true, types: list.map(t => t.name), items: list.map(t => ({ id: t.id, name: t.name })) }
  } catch (e) {
    return { ok: false, message: `이슈 타입 조회 실패: ${e.message}` }
  }
}

// Jira 의 '내 고정된 필드'는 이슈 화면의 사용자별 UI 설정이라 공개 API 로 못 읽는다.
// 대신 생성 화면에 실제로 뜨는 필드 목록을 받아와, 그중 쓸 것만 앱에서 골라 쓰게 한다.
// 지원 안 하는 타입(사용자·팀·이슈링크 등)은 여기서 걸러 UI 가 못 다룰 값을 애초에 안 보여준다.
const SUPPORTED_FIELD_TYPES = new Set(['option', 'array:option', 'array:version', 'array:component',
  'priority', 'array:string', 'string', 'number'])

function fieldKind(schema) {
  if (!schema) return ''
  return schema.type === 'array' ? `array:${schema.items}` : schema.type
}

async function listCreateFields(cfg, projectKey, issueTypeId) {
  const key = String(projectKey || '').trim().toUpperCase()
  if (!key || !issueTypeId) return { ok: false, message: '프로젝트와 이슈 타입을 먼저 고르세요' }
  const miss = missingFields(cfg)
  if (miss) return { ok: false, message: miss }
  try {
    const r = await jiraFetch(cfg,
      `/rest/api/3/issue/createmeta/${encodeURIComponent(key)}/issuetypes/${encodeURIComponent(issueTypeId)}?maxResults=100`)
    if (!r.ok) return { ok: false, message: errText(r), status: r.status }

    // 앱이 이미 따로 채우는 것(요약·설명·프로젝트·이슈타입·첨부)과 쓰지 않기로 한 것을 뺀다.
    // 담당자는 별도 줄로 항상 띄우므로 여기서도 제외한다.
    const skip = new Set([
      'summary', 'description', 'project', 'issuetype', 'attachment', 'parent', 'issuelinks',
      'assignee', 'versions', 'environment', 'components',
    ])
    const fields = (r.body.values || r.body.fields || [])
      .filter(f => !skip.has(f.fieldId || f.key))
      .map(f => ({
        id: f.fieldId || f.key,
        name: f.name,
        required: !!f.required,
        kind: fieldKind(f.schema),
        options: (f.allowedValues || []).map(v => ({
          id: v.id,
          label: v.value || v.name || v.label || String(v.id),
        })),
      }))
      .filter(f => SUPPORTED_FIELD_TYPES.has(f.kind))
    return { ok: true, fields }
  } catch (e) {
    return { ok: false, message: `필드 조회 실패: ${e.message}` }
  }
}

// 아바타 이미지도 인증이 걸려 있어 렌더러에서 바로 못 불러온다. 여기서 받아 data URL 로
// 바꿔 넘기고, 같은 주소는 캐시해 검색할 때마다 다시 받지 않는다.
const avatarCache = new Map()
async function fetchAvatar(cfg, url) {
  if (!url) return ''
  if (avatarCache.has(url)) return avatarCache.get(url)
  try {
    const res = await fetch(url, { headers: { Authorization: authHeader(cfg.email, cfg.token) } })
    if (!res.ok) return ''
    const type = res.headers.get('content-type') || 'image/png'
    const buf = Buffer.from(await res.arrayBuffer())
    const data = `data:${type};base64,${buf.toString('base64')}`
    avatarCache.set(url, data)
    return data
  } catch { return '' }
}

// 담당자는 allowedValues 가 없고 검색으로 찾아야 한다. 프로젝트에 배정 가능한 사람만 나온다.
async function searchAssignable(cfg, projectKey, query) {
  const key = String(projectKey || '').trim().toUpperCase()
  if (!key) return { ok: false, message: '프로젝트 키가 없습니다' }
  const miss = missingFields(cfg)
  if (miss) return { ok: false, message: miss }
  try {
    const r = await jiraFetch(cfg,
      `/rest/api/3/user/assignable/search?project=${encodeURIComponent(key)}&query=${encodeURIComponent(query || '')}&maxResults=50`)
    if (!r.ok) return { ok: false, message: errText(r), status: r.status }
    const users = (Array.isArray(r.body) ? r.body : [])
      .filter(u => u.accountId && u.active !== false)
      .map(u => ({
        accountId: u.accountId,
        name: u.displayName || u.emailAddress || u.accountId,
        avatarUrl: (u.avatarUrls || {})['24x24'] || (u.avatarUrls || {})['32x32'] || '',
      }))
    // 아바타 주소는 인증이 필요해서 <img src> 로 바로 못 쓴다. 여기서 받아 data URL 로 넘긴다.
    await Promise.all(users.map(async u => { u.avatar = await fetchAvatar(cfg, u.avatarUrl) }))
    return { ok: true, users }
  } catch (e) {
    return { ok: false, message: `담당자 조회 실패: ${e.message}` }
  }
}

// Jira 의 '내 고정된 필드'는 API 로 못 읽는다 — 실측으로 확인했다(2026-09-17).
// 계정의 user properties 28개를 전부 뽑아봤지만 전부 온보딩·UI 상태 키였고 고정 필드는 없다.
// 이슈 화면 서비스 내부 값이라 공개 REST 로는 노출되지 않는다. 다시 찾아보지 말 것.
// 대신 렌더러가 '실제로 채워 보낸 필드'를 기억해 다음부터 그것만 먼저 보여준다.

// 저장해 둔 { 필드id: 값 } 을 Jira 가 받는 모양으로 바꾼다. 타입마다 모양이 다르다.
function buildExtraFields(defs, values) {
  const out = {}
  for (const f of defs || []) {
    const v = values ? values[f.id] : undefined
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue
    switch (f.kind) {
      case 'option': out[f.id] = { id: String(v) }; break
      case 'priority': out[f.id] = { id: String(v) }; break
      case 'array:option':
      case 'array:version':
      case 'array:component':
        out[f.id] = (Array.isArray(v) ? v : [v]).map(x => ({ id: String(x) }))
        break
      case 'array:string':
        out[f.id] = Array.isArray(v) ? v : String(v).split(/[,\s]+/).filter(Boolean)
        break
      case 'number': out[f.id] = Number(v); break
      default: out[f.id] = String(v)
    }
  }
  return out
}

function buildIssueBody({ project, issueType, summary, description, labels, extra }) {
  const fields = {
    project: { key: String(project || '').trim().toUpperCase() },
    issuetype: { name: String(issueType || '').trim() },
    summary: String(summary || '').trim(),
  }
  if (description) fields.description = description
  if (labels && labels.length) fields.labels = labels
  Object.assign(fields, extra || {})   // 사용자가 고정해 둔 추가 필드
  return { fields }
}

// "대상 프로젝트가 없거나 권한이 없습니다" 는 키 오타인지 권한 문제인지 구분이 안 된다.
// 같은 토큰으로 프로젝트 목록을 한 번 더 물어서 어느 쪽인지 답까지 붙여 준다.
async function explainProjectError(cfg, key, message) {
  const t = await testConn(cfg)
  // 목록 조회까지 막히면 프로젝트 문제가 아니라 인증 문제다. 이메일이 틀리면 Jira 가 요청을
  // 익명으로 처리해서 "프로젝트가 없다"는 엉뚱한 문구를 돌려준다 (실제로 여기에 한 번 속았다).
  if (!t.ok) {
    return `${message}\n→ 이 토큰으로는 프로젝트 목록도 못 봅니다. 프로젝트가 아니라 인증 문제입니다 — 이메일과 API 토큰을 확인해 주세요.`
  }
  if (t.keys.includes(key)) {
    return `${message}\n→ 이 토큰으로 ${key} 는 보입니다. 키는 맞으니 해당 프로젝트의 '이슈 만들기' 권한이나 이슈 타입을 확인해 주세요.`
  }
  return `${message}\n→ 이 토큰으로 보이는 프로젝트: ${t.keys.join(', ') || '(없음)'}`
}

async function createIssue(cfg, issue) {
  const miss = missingFields(cfg)
  if (miss) return { ok: false, message: miss }
  if (!issue.project) return { ok: false, message: '프로젝트 키를 입력해 주세요' }
  if (!issue.summary || !issue.summary.trim()) return { ok: false, message: '제목을 입력해 주세요' }
  const body = buildIssueBody(issue)
  try {
    const r = await jiraFetch(cfg, '/rest/api/2/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      let message = errText(r)
      if (/project|프로젝트/i.test(message)) {
        message = await explainProjectError(cfg, body.fields.project.key, message)
      }
      return { ok: false, message }
    }
    const key = r.body.key
    return { ok: true, key, url: `${apiBase(cfg.site)}/browse/${key}` }
  } catch (e) {
    return { ok: false, message: `등록 실패: ${e.message}` }
  }
}

// 첨부는 XSRF 검사를 명시적으로 건너뛰어야 한다 (X-Atlassian-Token: no-check).
// Content-Type 은 직접 넣지 않는다 — FormData 경계 문자열을 fetch 가 만들어 준다.
async function attachFile(cfg, key, filename, buf) {
  try {
    const makeBody = () => {
      const form = new FormData()
      form.append('file', new Blob([buf]), filename)
      return form
    }
    const r = await jiraFetch(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}/attachments`, {
      method: 'POST',
      headers: { 'X-Atlassian-Token': 'no-check' },
      makeBody,
    })
    if (!r.ok) return { ok: false, message: errText(r), status: r.status }
    return { ok: true }
  } catch (e) {
    return { ok: false, message: `첨부 실패: ${e.message}` }
  }
}

// ── 스프린트 (Jira Software Agile REST API 1.0) ─────────────────────────
// 이슈 생성 API 로는 스프린트를 안정적으로 넣을 수 없다 — 스프린트는 커스텀 필드
// (customfield_100xx, 사이트마다 번호가 다르다)이고 생성 화면에 없으면 거부된다.
// 그래서 이슈를 만든 뒤 POST /rest/agile/1.0/sprint/{id}/issue 로 옮긴다.
// 진행 중(active)·예정(future) 스프린트에만 넣을 수 있고, 완료(closed)된 스프린트는 Jira 가 거부한다.

// 스코프형 토큰은 Jira Software 권한(read/write:sprint)이 빠져 있을 수 있다 — 원인을 같이 알려 준다
function agileErr(r) {
  const base = errText(r)
  if (r.status === 401 || r.status === 403) {
    return `${base} / 스프린트 권한이 없는 토큰일 수 있습니다 (권한 범위를 지정한 토큰이면 Jira Software 권한을 추가해 주세요)`
  }
  return base
}

// 프로젝트의 보드 목록. 스프린트는 스크럼 보드에만 있다 (칸반은 type: 'kanban').
async function listBoards(cfg, projectKey) {
  const key = String(projectKey || '').trim().toUpperCase()
  if (!key) return { ok: false, message: '프로젝트를 먼저 고르세요' }
  const miss = missingFields(cfg)
  if (miss) return { ok: false, message: miss }
  try {
    const r = await jiraFetch(cfg, `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(key)}&maxResults=50`)
    if (!r.ok) return { ok: false, message: agileErr(r), status: r.status }
    const boards = (r.body.values || []).map(b => ({ id: b.id, name: b.name || String(b.id), type: b.type || '' }))
    return { ok: true, boards }
  } catch (e) {
    return { ok: false, message: `보드 조회 실패: ${e.message}` }
  }
}

// 보드의 진행 중·예정 스프린트. 진행 중인 것을 먼저, 그 안에서는 시작일 순으로 정렬한다.
async function listSprints(cfg, boardId, states = 'active,future') {
  const id = Number(boardId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '보드를 먼저 고르세요' }
  const miss = missingFields(cfg)
  if (miss) return { ok: false, message: miss }
  try {
    const r = await jiraFetch(cfg, `/rest/agile/1.0/board/${id}/sprint?state=${encodeURIComponent(states)}&maxResults=50`)
    if (!r.ok) {
      // 칸반 보드에 스프린트를 물으면 400 "이 보드는 스프린트를 지원하지 않습니다" 가 온다
      return { ok: false, message: r.status === 400 ? `${errText(r)} / 스크럼 보드만 스프린트가 있습니다` : agileErr(r), status: r.status }
    }
    const order = { active: 0, future: 1 }
    const sprints = (r.body.values || [])
      .map(s => ({
        id: s.id, name: s.name || String(s.id), state: s.state || '',
        startDate: s.startDate || '', endDate: s.endDate || '', originBoardId: s.originBoardId ?? null,
      }))
      .sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || String(a.startDate).localeCompare(String(b.startDate)))
    return { ok: true, sprints }
  } catch (e) {
    return { ok: false, message: `스프린트 조회 실패: ${e.message}` }
  }
}

// 진행 중인 스프린트 하나를 고른다. 보통 하나지만, 병렬 스프린트를 켠 사이트는 여러 개일 수 있다.
// 그 보드에서 만든 스프린트(originBoardId)를 먼저, 그다음 먼저 끝나는 것을 고른다.
function pickActiveSprint(sprints, boardId) {
  const active = (sprints || []).filter(s => s.state === 'active')
  if (!active.length) return null
  const own = active.filter(s => s.originBoardId === Number(boardId))
  const pool = own.length ? own : active
  return pool.slice().sort((a, b) => String(a.endDate || '9').localeCompare(String(b.endDate || '9')))[0]
}

// 설정(mode·보드·스프린트) → 실제로 넣을 스프린트.
//   { ok:true, sprint }                넣을 곳이 정해졌다
//   { ok:true, sprint:null, message }  넣지 않는다 (지정 안 함 / 진행 중인 스프린트 없음)
//   { ok:false, message }              조회 실패 / 지정한 스프린트를 쓸 수 없음
async function resolveSprint(cfg, sc) {
  const mode = sc && sc.sprintMode
  if (mode !== 'active' && mode !== 'fixed') return { ok: true, sprint: null, message: '' }
  if (mode === 'active') {
    const r = await listSprints(cfg, sc.boardId, 'active')
    if (!r.ok) return r
    const sprint = pickActiveSprint(r.sprints, sc.boardId)
    return sprint ? { ok: true, sprint }
      : { ok: true, sprint: null, message: `${sc.boardName || '보드'} 에 진행 중인 스프린트가 없어 백로그에 남겼습니다` }
  }
  const id = Number(sc.sprintId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: '지정한 스프린트가 없습니다 — Jira 설정에서 스프린트를 골라 주세요' }
  try {
    const r = await jiraFetch(cfg, `/rest/agile/1.0/sprint/${id}`)
    if (!r.ok) return { ok: false, message: agileErr(r), status: r.status }
    if (r.body.state === 'closed') {
      return { ok: false, message: `지정한 스프린트 '${r.body.name || id}' 는 이미 완료됐습니다 — Jira 설정에서 다시 골라 주세요` }
    }
    return { ok: true, sprint: { id, name: r.body.name || sc.sprintName || String(id), state: r.body.state || '' } }
  } catch (e) {
    return { ok: false, message: `스프린트 조회 실패: ${e.message}` }
  }
}

// 만든 이슈를 스프린트로 옮긴다. 성공하면 Jira 는 204(본문 없음)를 준다.
async function addIssueToSprint(cfg, sprintId, issueKey) {
  try {
    const r = await jiraFetch(cfg, `/rest/agile/1.0/sprint/${Number(sprintId)}/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issues: [String(issueKey)] }),
    })
    if (!r.ok) return { ok: false, message: agileErr(r), status: r.status }
    return { ok: true }
  } catch (e) {
    return { ok: false, message: `스프린트 추가 실패: ${e.message}` }
  }
}

// 자가진단에서 가짜 서버를 바꿔 끼울 때만 쓴다
function baseCacheClearForTest() { baseCache.clear(); cloudIdCache.clear() }

module.exports = {
  DEFAULT_SITE, authHeader, apiBase, errText, missingFields, buildIssueBody,
  createIssue, attachFile, testConn, listIssueTypes, listCreateFields, buildExtraFields, searchAssignable, pingAuth,
  listBoards, listSprints, pickActiveSprint, resolveSprint, addIssueToSprint,
}

// ── 자가진단: node src/jira.js ────────────────────────────────
if (require.main === module) {
  const assert = require('assert')

  assert.strictEqual(authHeader('a@b.c', 'tok'), 'Basic ' + Buffer.from('a@b.c:tok').toString('base64'))

  // 사람이 복사해 오는 온갖 형태의 주소를 origin 으로 정규화한다
  assert.strictEqual(apiBase('https://zerosoft0.atlassian.net/'), 'https://zerosoft0.atlassian.net')
  assert.strictEqual(apiBase('zerosoft0.atlassian.net'), 'https://zerosoft0.atlassian.net')
  assert.strictEqual(apiBase('https://zerosoft0.atlassian.net/jira/software/projects/PROJ/boards/1'),
    'https://zerosoft0.atlassian.net')
  assert.strictEqual(apiBase(''), '')

  const body = buildIssueBody({ project: ' proj ', issueType: '버그', summary: ' 제목 ', description: '본문', labels: ['qa'] })
  assert.strictEqual(body.fields.project.key, 'PROJ', '프로젝트 키는 대문자로 보정')
  assert.strictEqual(body.fields.summary, '제목')
  assert.strictEqual(body.fields.issuetype.name, '버그')
  assert.deepStrictEqual(body.fields.labels, ['qa'])
  // 설명이 비면 필드를 아예 빼야 한다 (빈 문자열을 거부하는 화면이 있다)
  assert.ok(!('description' in buildIssueBody({ project: 'A', summary: 's' }).fields))

  assert.strictEqual(errText({ status: 400, body: { errors: { summary: '필수입니다' } } }), 'summary: 필수입니다')
  // 토큰 만료도 401 로 온다 — 문구에 '만료'가 있어야 사용자가 원인을 안다
  assert.ok(errText({ status: 401, body: {} }).includes('만료'))
  assert.ok(errText({ status: 401, body: {} }).includes('API 토큰'))
  assert.ok(errText({ status: 404, body: {} }).includes('프로젝트 키'))

  assert.ok(missingFields({}).includes('사이트'))
  assert.ok(missingFields({ site: 'x.atlassian.net' }).includes('이메일'))
  assert.ok(missingFields({ site: 'x.atlassian.net', email: 'a@b.c' }).includes('토큰'))
  assert.strictEqual(missingFields({ site: 'x.atlassian.net', email: 'a@b.c', token: 't' }), null)

  // 같은 문장이 errorMessages 와 errors 양쪽에 오면 한 번만 남아야 한다 (실제로 이렇게 온다)
  const dup = errText({ status: 400, body: { errorMessages: ['프로젝트가 없습니다'], errors: { project: '프로젝트가 없습니다' } } })
  assert.strictEqual(dup, '프로젝트가 없습니다', '중복 제거 실패: ' + dup)

  // 스코프형 토큰 폴백: 사이트 주소는 401, api.atlassian.com 게이트웨이는 통과해야 한다
  ;(async () => {
    const calls = []
    global.fetch = async (url, opts) => {
      calls.push(url)
      if (url.endsWith('/_edge/tenant_info')) return mk(200, { cloudId: 'CID' })
      if (url.startsWith('https://api.atlassian.com/ex/jira/CID')) {
        return url.includes('/myself')
          ? mk(403, { errorMessages: ['권한 없음'] })          // 스코프 빠져도 연결은 성공이어야 한다
          : mk(200, { values: [{ key: 'PROJ', name: '샘플프로젝트' }, { key: 'ANR' }], total: 2 })
      }
      return mk(401, { errorMessages: ['Client must be authenticated to access this resource.'] })
    }
    const mk = (status, obj) => ({
      ok: status < 400, status,
      text: async () => JSON.stringify(obj),
      json: async () => obj,          // cloudId 조회는 json() 을 쓴다
    })

    const cfg = { site: 'x.atlassian.net', email: 'a@b.c', token: 'ATCTT-scoped' }
    const r = await testConn(cfg)
    assert.ok(r.ok, '게이트웨이 폴백 실패: ' + r.message)
    assert.deepStrictEqual(r.keys, ['PROJ', 'ANR'], '프로젝트 키를 못 받았다')
    // 이름이 없는 프로젝트는 키로 대체해야 화면에 '- PROJ' 처럼 빈 이름이 안 뜬다
    assert.deepStrictEqual(r.projects, [{ key: 'PROJ', name: '샘플프로젝트' }, { key: 'ANR', name: 'ANR' }])
    assert.strictEqual(r.name, '', '/myself 가 403 이어도 연결은 성공이어야 한다')
    assert.ok(calls.some(u => u.includes('tenant_info')), 'cloudId 조회를 안 했다')
    assert.ok(calls.some(u => u.startsWith('https://api.atlassian.com/ex/jira/CID')), '게이트웨이로 재시도를 안 했다')

    // 두 번째 호출은 알아낸 경로로 바로 가야 한다 (사이트 주소 재시도 없음)
    calls.length = 0
    await testConn(cfg)
    assert.ok(calls.every(u => u.startsWith('https://api.atlassian.com/ex/jira/CID')), '경로를 캐시하지 않았다: ' + calls)

    // 프로젝트 오류가 나면, 같은 토큰으로 보이는 프로젝트 목록을 물어 원인을 좁혀 줘야 한다
    baseCacheClearForTest()
    global.fetch = async (url) => {
      if (url.endsWith('/_edge/tenant_info')) return mk(200, { cloudId: 'CID' })
      if (url.includes('/rest/api/2/issue') && !url.includes('project/search')) {
        return mk(400, { errorMessages: ['대상 프로젝트가 존재하지 않거나 권한이 없습니다'] })
      }
      if (url.includes('project/search')) return mk(200, { values: [{ key: 'ANR' }, { key: 'MUSIC' }], total: 2 })
      return mk(200, {})
    }
    const bad = await createIssue({ site: 'y.atlassian.net', email: 'a@b.c', token: 't' },
      { project: 'PROJ', issueType: '버그', summary: '테스트' })
    assert.ok(!bad.ok)
    assert.ok(bad.message.includes('보이는 프로젝트: ANR, MUSIC'), '원인 안내가 없다: ' + bad.message)

    baseCacheClearForTest()
    global.fetch = async (url) => {
      if (url.includes('/rest/api/2/issue') && !url.includes('project/search')) {
        return mk(400, { errorMessages: ['대상 프로젝트가 존재하지 않거나 권한이 없습니다'] })
      }
      if (url.includes('project/search')) return mk(200, { values: [{ key: 'PROJ' }], total: 1 })
      return mk(200, {})
    }
    const perm = await createIssue({ site: 'y.atlassian.net', email: 'a@b.c', token: 't' },
      { project: 'PROJ', issueType: '버그', summary: '테스트' })
    assert.ok(perm.message.includes('키는 맞으니'), '권한 쪽 안내가 없다: ' + perm.message)

    // 이메일 오타 → Jira 가 익명으로 처리 → 생성은 '프로젝트 없음', 목록 조회는 401.
    // 이때 프로젝트 탓을 하면 안 되고 인증 문제라고 말해야 한다 (실제로 겪은 사례).
    baseCacheClearForTest()
    global.fetch = async (url) => {
      if (url.endsWith('/_edge/tenant_info')) return mk(404, {})
      if (url.includes('project/search')) return mk(401, { errorMessages: ['Client must be authenticated to access this resource.'] })
      return mk(400, { errorMessages: ['대상 프로젝트가 존재하지 않거나 권한이 없습니다'] })
    }
    const anon = await createIssue({ site: 'z.atlassian.net', email: 'typo@b.c', token: 't' },
      { project: 'PROJ', issueType: '버그', summary: '테스트' })
    assert.ok(anon.message.includes('인증 문제'), '이메일 오타를 인증 문제로 안내하지 않는다: ' + anon.message)

    // 이슈 타입은 프로젝트에서 받아오고, 하위 작업은 빼야 한다 (부모 없이 못 만든다)
    baseCacheClearForTest()
    global.fetch = async (url) => {
      if (url.includes('/rest/api/2/project/PROJ')) {
        return mk(200, {
          issueTypes: [
            { name: '에픽' }, { name: '스토리' }, { name: '작업' },
            { name: '버그' }, { name: '하위 작업', subtask: true },
          ],
        })
      }
      return mk(404, {})
    }
    const cfg2 = { site: 'w.atlassian.net', email: 'a@b.c', token: 't' }
    const ts = await listIssueTypes(cfg2, ' proj ')
    assert.ok(ts.ok, '이슈 타입 조회 실패: ' + ts.message)
    assert.deepStrictEqual(ts.types, ['에픽', '스토리', '작업', '버그'], '하위 작업이 안 걸러졌다: ' + ts.types)
    assert.ok(!(await listIssueTypes(cfg2, '')).ok, '빈 키를 걸러야 한다')

    // 생성 화면 필드 목록 — 실제 PROJ/버그 응답 모양으로 검사한다
    baseCacheClearForTest()
    global.fetch = async (url) => {
      if (!url.includes('/createmeta/')) return mk(404, {})
      return mk(200, {
        values: [
          { fieldId: 'summary', name: '요약', required: true, schema: { type: 'string' } },
          { fieldId: 'description', name: '설명', schema: { type: 'string' } },
          {
            fieldId: 'customfield_10131', name: '플랫폼', schema: { type: 'array', items: 'option' },
            allowedValues: [{ id: '10204', value: 'AOS' }, { id: '10205', value: 'Web' }],
          },
          {
            fieldId: 'fixVersions', name: '수정 버전', schema: { type: 'array', items: 'version' },
            allowedValues: [{ id: '10840', name: 'App-v53' }],
          },
          {
            fieldId: 'priority', name: '우선 순위', required: true, schema: { type: 'priority' },
            allowedValues: [{ id: '3', name: 'Medium' }],
          },
          { fieldId: 'assignee', name: '담당자', schema: { type: 'user' } },   // 지원 안 함 → 빠져야 한다
          { fieldId: 'issuelinks', name: '연결된 이슈', schema: { type: 'array', items: 'issuelinks' } },
        ],
      })
    }
    const fr = await listCreateFields(cfg2, 'PROJ', '10023')
    assert.ok(fr.ok, '필드 조회 실패: ' + fr.message)
    assert.deepStrictEqual(fr.fields.map(f => f.id), ['customfield_10131', 'fixVersions', 'priority'],
      '요약·설명·미지원 타입이 안 걸러졌다: ' + fr.fields.map(f => f.id))
    assert.deepStrictEqual(fr.fields[0].options, [{ id: '10204', label: 'AOS' }, { id: '10205', label: 'Web' }])
    assert.strictEqual(fr.fields[1].options[0].label, 'App-v53', '버전은 name 을 라벨로 써야 한다')

    // 타입별 직렬화 — 여기가 틀리면 Jira 가 400 을 뱉는다
    const extra = buildExtraFields(fr.fields, {
      customfield_10131: ['10204', '10205'], fixVersions: '10840', priority: '3',
    })
    assert.deepStrictEqual(extra, {
      customfield_10131: [{ id: '10204' }, { id: '10205' }],
      fixVersions: [{ id: '10840' }],
      priority: { id: '3' },
    }, '직렬화 모양이 다르다: ' + JSON.stringify(extra))
    assert.deepStrictEqual(buildExtraFields(fr.fields, { customfield_10131: [] }), {}, '빈 값은 빼야 한다')
    assert.deepStrictEqual(
      buildExtraFields([{ id: 'labels', kind: 'array:string' }], { labels: 'qa, mirror' }),
      { labels: ['qa', 'mirror'] }, '레이블은 문자열 배열이다')

    // 추가 필드가 생성 본문에 합쳐지는지
    const body2 = buildIssueBody({ project: 'A', issueType: '버그', summary: 's', extra })
    assert.deepStrictEqual(body2.fields.priority, { id: '3' })

    // 토큰 만료: 조회 함수들이 status 401 과 '만료' 문구를 같이 돌려줘야 렌더러가 안내할 수 있다
    baseCacheClearForTest()
    global.fetch = async () => mk(401, { errorMessages: ['Client must be authenticated'] })
    const cfgOld = { site: 'expired.atlassian.net', email: 'a@b.c', token: 'old' }
    for (const [name, r] of [
      ['listIssueTypes', await listIssueTypes(cfgOld, 'PROJ')],
      ['pingAuth', await pingAuth(cfgOld)],
    ]) {
      assert.strictEqual(r.status, 401, name + ': status 가 안 넘어온다')
      assert.ok(r.message.includes('만료'), name + ': 만료 안내가 없다 — ' + r.message)
    }

    // ── 스프린트 ──
    // 진행 중 스프린트 고르기: 여러 개면 그 보드에서 만든 것, 그다음 먼저 끝나는 것
    const SP = [
      { id: 1, name: '예정', state: 'future', originBoardId: 7 },
      { id: 2, name: '다른보드', state: 'active', endDate: '2026-11-15', originBoardId: 9 },
      { id: 3, name: '늦게끝남', state: 'active', startDate: '2026-11-10', endDate: '2026-11-30', originBoardId: 7 },
      { id: 4, name: '먼저끝남', state: 'active', startDate: '2026-11-06', endDate: '2026-11-20', originBoardId: 7 },
    ]
    assert.strictEqual(pickActiveSprint(SP, 7).id, 4, '자기 보드 것 중 먼저 끝나는 것')
    assert.strictEqual(pickActiveSprint(SP, 99).id, 2, '자기 보드 것이 없으면 전체 중 먼저 끝나는 것')
    assert.strictEqual(pickActiveSprint([SP[0]], 7), null, '진행 중이 없으면 null')
    assert.strictEqual(pickActiveSprint([], 7), null)

    // 보드·스프린트 조회 + 정렬(진행 중 먼저) + 이슈 추가 요청 모양
    baseCacheClearForTest()
    const agileCalls = []
    global.fetch = async (url, opts = {}) => {
      agileCalls.push({ url, method: opts.method || 'GET', body: opts.body })
      if (url.includes('/rest/agile/1.0/board?projectKeyOrId=PROJ')) {
        return mk(200, { values: [{ id: 7, name: 'PROJ 보드', type: 'scrum' }, { id: 8, name: '칸반', type: 'kanban' }] })
      }
      if (url.includes('/rest/agile/1.0/board/8/sprint')) return mk(400, { errorMessages: ['The board does not support sprints'] })
      if (url.includes('/rest/agile/1.0/board/7/sprint?state=active%2Cfuture')) return mk(200, { values: [SP[0], SP[2], SP[3]] })
      if (url.includes('/rest/agile/1.0/board/7/sprint?state=active')) return mk(200, { values: [SP[2], SP[3]] })
      if (url.includes('/rest/agile/1.0/board/6/sprint?state=active')) return mk(200, { values: [] })
      if (url.endsWith('/rest/agile/1.0/sprint/4')) return mk(200, { id: 4, name: '먼저끝남', state: 'active' })
      if (url.endsWith('/rest/agile/1.0/sprint/5')) return mk(200, { id: 5, name: '지난 스프린트', state: 'closed' })
      if (url.endsWith('/rest/agile/1.0/sprint/4/issue')) return { ok: true, status: 204, text: async () => '', json: async () => null }
      if (url.endsWith('/rest/agile/1.0/sprint/6/issue')) return mk(403, { errorMessages: ['권한 없음'] })
      return mk(404, {})
    }
    const cfgA = { site: 'a.atlassian.net', email: 'a@b.c', token: 't' }
    const bl = await listBoards(cfgA, ' proj ')
    assert.ok(bl.ok, '보드 조회 실패: ' + bl.message)
    assert.deepStrictEqual(bl.boards, [{ id: 7, name: 'PROJ 보드', type: 'scrum' }, { id: 8, name: '칸반', type: 'kanban' }])
    assert.ok(!(await listBoards(cfgA, '')).ok, '빈 프로젝트 키는 거부')

    const sl = await listSprints(cfgA, 7)
    assert.ok(sl.ok, '스프린트 조회 실패: ' + sl.message)
    assert.deepStrictEqual(sl.sprints.map(s => s.id), [4, 3, 1], '진행 중 먼저, 그 안에서는 시작일 순')
    const kb = await listSprints(cfgA, 8)
    assert.ok(!kb.ok && kb.message.includes('스크럼 보드'), '칸반 보드 안내가 없다: ' + kb.message)
    assert.ok(!(await listSprints(cfgA, 'x')).ok, '잘못된 보드 id 는 거부')

    // 설정 → 실제 스프린트
    assert.deepStrictEqual(await resolveSprint(cfgA, { sprintMode: 'off' }), { ok: true, sprint: null, message: '' })
    assert.strictEqual((await resolveSprint(cfgA, { sprintMode: 'active', boardId: 7 })).sprint.id, 4)
    const none = await resolveSprint(cfgA, { sprintMode: 'active', boardId: 6, boardName: 'B6' })
    assert.ok(none.ok && none.sprint === null && none.message.includes('백로그'), '진행 중 없음 안내: ' + none.message)
    assert.strictEqual((await resolveSprint(cfgA, { sprintMode: 'fixed', sprintId: 4 })).sprint.name, '먼저끝남')
    const closed = await resolveSprint(cfgA, { sprintMode: 'fixed', sprintId: 5 })
    assert.ok(!closed.ok && closed.message.includes('완료'), '완료된 스프린트는 거부: ' + closed.message)
    assert.ok(!(await resolveSprint(cfgA, { sprintMode: 'fixed' })).ok, '지정 모드인데 스프린트가 없으면 실패')

    // 이슈 추가: 204 성공, 403 은 권한 안내
    agileCalls.length = 0
    assert.ok((await addIssueToSprint(cfgA, 4, 'PROJ-12')).ok, '204 를 성공으로 봐야 한다')
    const add = agileCalls.find(c => c.url.endsWith('/sprint/4/issue'))
    assert.strictEqual(add.method, 'POST')
    assert.deepStrictEqual(JSON.parse(add.body), { issues: ['PROJ-12'] })
    const denied = await addIssueToSprint(cfgA, 6, 'PROJ-12')
    assert.ok(!denied.ok && denied.message.includes('스프린트 권한'), '권한 안내가 없다: ' + denied.message)

    console.log('jira.js 자가진단 통과 — 주소 4 / 페이로드 5 / 오류문구 4 / 필수값 4 / 토큰 폴백 4 / 원인 안내 3 / 이슈타입 3 / 필드 7 / 스프린트 15')
  })().catch(e => { console.error('자가진단 실패:', e.message); process.exit(1) })
}
