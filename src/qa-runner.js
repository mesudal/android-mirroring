// QA 시나리오 실행기 — 체크리스트 항목을 차례로 돌려 Pass / Fail / Blocked / Skipped 를 낸다.
// 기기 조작은 드라이버(qa-driver.js)에, 파일 저장·사람 응답·APK 설치는 hooks 로 바깥(main.js)에 맡긴다.
// 그래서 Electron 없이 가짜 기기로 자가진단할 수 있다 (`node src/qa-runner.js`).
//
// 판정 규칙
//   - iOS 전용 항목 → Skipped
//   - 시나리오가 이 앱 타입 대상이 아님(variants) → Skipped
//   - 필요한 역할의 기기가 배정되지 않음 → Blocked (기기 부족)
//   - 사전 조건(pre) 실패 → Blocked
//   - 본 절차(steps) 실패 → Fail. 실패 순간의 스크린샷·화면 구조를 남긴다
//   - 실행 중 앱이 죽음(logcat 의 FATAL EXCEPTION / ANR) → Fail (크래시)
//   - teardown 은 성공·실패·중단과 상관없이 항상 돈다. 시나리오가 끈 네트워크는 그래도 켜져 있지 않으면 되돌린다
//   - 시나리오가 없는 항목은 체크리스트 문구를 띄워 사람이 판정한다 (끄면 To do)
//
// 업데이트 테스트 (run({ update: true }))
//   기존 버전 설치 → update:'before'|'both' 시나리오 → 업데이트 설치(데이터 유지) → 나머지 전부
//   'before' 단계에서 snapshot 으로 저장한 화면 글자를 'after' 단계의 sameAsSnapshot 이 비교한다.

const qx = require('./qa-xml')
const { expandSteps, bindStep } = require('./qa-scenario')
const { isIosOnly } = require('./qa-checklist')

const DEFAULT_TIMEOUT = { visible: 10000, gone: 3000, poll: 5000 }
const ACTION_SETTLE_MS = 300     // 동작 뒤 화면이 바뀔 틈. 판정 단계는 어차피 기다리며 다시 본다

class StopRun extends Error {}           // 사용자가 전체 실행을 멈췄다
class ItemBlocked extends Error {}       // 사람이 이 항목을 Blocked 로 판정했다

const sleep = ms => new Promise(r => setTimeout(r, ms))

// logcat 줄에서 그 앱의 크래시·ANR 을 찾는다. 없으면 ''.
function detectCrash(lines, pkg) {
  const list = Array.isArray(lines) ? lines : String(lines || '').split('\n')
  for (let i = 0; i < list.length; i++) {
    const l = list[i]
    if (l.includes(`ANR in ${pkg}`)) return `ANR: ${l.trim().slice(0, 200)}`
    if (/FATAL EXCEPTION/.test(l)) {
      // 다음 몇 줄 안에 "Process: <pkg>" 가 나와야 이 앱의 크래시다
      const near = list.slice(i, i + 6).join('\n')
      if (near.includes(`Process: ${pkg}`)) return `크래시: ${(list[i + 2] || l).trim().slice(0, 200)}`
    }
    if (/Fatal signal \d+/.test(l) && l.includes(pkg)) return `네이티브 크래시: ${l.trim().slice(0, 200)}`
  }
  return ''
}

// 로그·진행 표시에 쓰는 단계 이름. 입력 값은 찍지 않는다 (비밀번호일 수 있다).
function describeStep(step) {
  if (!step) return '?'
  if (step.parallel) return `동시 실행 ${step.parallel.length}갈래`
  const name = step.do || step.expect
  const parts = [step.dev ? `[${step.dev}]` : '', step.expect ? `확인:${name}` : name]
  if (step.sel) parts.push(qx.describeSelector(step.sel))
  if (step.do === 'type') parts.push(`(${String(step.value ?? '').length}자)`)
  if (step.message) parts.push(String(step.message).slice(0, 40))
  if (step.contains) parts.push(step.contains)
  if (step.name) parts.push(step.name)
  return parts.filter(Boolean).join(' ')
}

const visibleLabels = nodes => [...new Set((nodes || []).filter(n => n.visible && n.label).map(n => n.label.trim()).filter(Boolean))]

function compare(op, a, b) {
  switch (op) {
    case '!=': return a !== b
    case '>=': return a >= b
    case '<=': return a <= b
    case '>': return a > b
    case '<': return a < b
    default: return a === b
  }
}

// roles: { A: { driver, pkg, account, variantId, serial, model }, ... } — 배정된 역할만
// hooks: {
//   progress(evt)                         진행 알림 (화면 표시용)
//   ask(req) → Promise<answer>            사람 응답. req.kind = 'prompt' | 'ask'
//                                          prompt 응답 { action: 'continue' | 'block' | 'stop', note }
//                                          ask    응답 { result: 'Pass' | 'Fail' | 'Blocked' | 'Skipped', note } 또는 { action: 'stop' }
//   evidence(itemId, role, file, data) → Promise<저장 경로|null>
//   logcat: { mark(role) → 토큰, slice(role, 토큰) → 줄 배열 }
//   installApk(kind) → Promise<{ ok, message, skipped }>   kind = 'base' | 'update'
// }
function createRunner({ roles, scenarios, procedures = {}, hooks = {}, options = {} }) {
  const opts = { manualForUnscripted: true, settleMs: ACTION_SETTLE_MS, pollMs: 700, ...options }
  const progress = e => { try { hooks.progress?.(e) } catch { } }
  let stopped = false
  let inTeardown = false   // teardown 중에는 멈춤 요청이 와도 끝까지 돌린다 (되돌리기를 반만 하면 기기가 이상한 상태로 남는다)
  const snapshots = {}     // 이름 → { dev, labels } — 업데이트 전 단계에서 저장해 후 단계에서 비교

  const checkStop = () => { if (stopped && !inTeardown) throw new StopRun('중단됨') }

  async function wait(ms) {
    const until = Date.now() + ms
    while (Date.now() < until) { checkStop(); await sleep(Math.min(200, until - Date.now())) }
  }

  // cond() 가 { done:true } 를 줄 때까지 반복. 마지막 결과를 돌려준다.
  async function poll(cond, timeout) {
    const until = Date.now() + timeout
    let last
    for (;;) {
      checkStop()
      last = await cond()
      if (last.done) return last
      if (Date.now() + opts.pollMs > until) return last
      await sleep(opts.pollMs)
    }
  }

  function roleOf(dev) {
    const r = roles[dev]
    if (!r) throw new Error(`역할 ${dev} 에 기기가 배정되지 않았습니다`)
    return r
  }

  // 단계 하나. 성공이면 { ok:true, message }, 실패면 { ok:false, message }.
  async function execStep(step, ctx) {
    checkStop()
    if (step.parallel) {
      const branches = step.parallel.map(b => (Array.isArray(b) ? b : [b]))
      const results = await Promise.all(branches.map(list => runSeq(list, ctx).catch(e => {
        if (e instanceof StopRun || e instanceof ItemBlocked) throw e
        return { ok: false, message: e.message }
      })))
      const bad = results.find(r => !r.ok)
      return bad || { ok: true, message: '동시 실행 완료' }
    }

    const s = bindStep(step, { dev: step.dev, accounts: ctx.accounts, pkgs: ctx.pkgs, vars: ctx.vars })
    const name = s.do || s.expect

    // 기기를 쓰지 않는 단계
    if (name === 'sleep') { await wait(s.ms); return { ok: true, message: `${s.ms}ms 대기` } }
    if (name === 'prompt' || name === 'ask') return ask(s, ctx)

    const role = roleOf(s.dev)
    const d = role.driver
    const pkg = role.pkg
    const waitOpts = { timeout: s.timeout ?? DEFAULT_TIMEOUT.visible }

    if (s.do) {
      let r
      switch (name) {
        case 'tap': r = await d.tap(s.sel, waitOpts); break
        case 'longPress': r = await d.longPress(s.sel, s.ms ?? 1000, waitOpts); break
        case 'tapAt': {
          if (Array.isArray(s.xy)) {
            const p = await d.locate({ xy: s.xy })
            r = p.ok ? await d.tapAt(p.x, p.y) : p
          } else r = await d.tapAt(s.x, s.y)
          break
        }
        case 'swipe': {
          const sz = await d.screenSize()
          if (!sz.ok) { r = sz; break }
          r = await d.swipe(sz.width * s.from[0], sz.height * s.from[1], sz.width * s.to[0], sz.height * s.to[1], s.ms ?? 300)
          break
        }
        case 'scrollTo': r = await d.scrollFind(s.sel, { direction: s.direction || 'down', maxSwipes: s.maxSwipes ?? 8 }); break
        case 'type': {
          if (s.sel) { const t = await d.tap(s.sel, waitOpts); if (!t.ok) { r = t; break } await sleep(opts.settleMs) }
          r = await d.type(s.value)
          break
        }
        case 'key': r = await d.key(s.key); break
        case 'launch': r = await d.launch(s.pkg || pkg); break
        case 'stop': r = await d.stop(s.pkg || pkg); break
        case 'clearData': r = await d.clearData(s.pkg || pkg); break
        case 'adb': { const x = await d.shell(s.cmd); r = x.ok ? { ok: true, message: `adb: ${s.cmd}` } : x; break }
        case 'network':
          r = await d.network(s.on)
          if (r.ok) { if (s.on) delete ctx.netOff[s.dev]; else ctx.netOff[s.dev] = true }
          break
        case 'screenOff': r = await d.key('screenOff'); break
        case 'screenOn': r = await d.key('screenOn'); break
        case 'openNotifications': r = await d.notifications(true); break
        case 'closeNotifications': r = await d.notifications(false); break
        case 'permission': r = await d.permission(s.pkg || pkg, s.perm, s.grant); break
        case 'overlay': r = await d.overlay(s.pkg || pkg, s.allow); break
        case 'location': r = await d.location(s.on); break
        case 'snapshot': {
          const dump = await d.dump()
          if (!dump.ok) { r = dump; break }
          snapshots[s.name] = { dev: s.dev, labels: visibleLabels(dump.nodes) }
          r = { ok: true, message: `화면 글자 ${snapshots[s.name].labels.length}개 저장 (${s.name})` }
          break
        }
        default: r = { ok: false, message: `모르는 동작: ${name}` }
      }
      if (r.ok) await sleep(opts.settleMs)
      return { ok: !!r.ok, message: r.message || '' }
    }

    // 판정
    switch (name) {
      case 'visible': {
        const r = await d.waitFor(s.sel, waitOpts)
        return r.ok ? { ok: true, message: `보임: ${r.node?.label || qx.describeSelector(s.sel)}` } : { ok: false, message: r.message }
      }
      case 'gone': {
        const r = await d.waitGone(s.sel, { timeout: s.timeout ?? DEFAULT_TIMEOUT.gone })
        return { ok: !!r.ok, message: r.ok ? `안 보임: ${qx.describeSelector(s.sel)}` : r.message }
      }
      case 'activity': {
        const r = await poll(async () => {
          const a = await d.currentActivity()
          return { done: a.ok && a.activity.includes(s.contains), a }
        }, s.timeout ?? DEFAULT_TIMEOUT.poll)
        return r.done ? { ok: true, message: `화면: ${r.a.activity}` } : { ok: false, message: `화면이 ${s.contains} 가 아닙니다 (지금: ${r.a?.activity || '알 수 없음'})` }
      }
      case 'appRunning':
      case 'appNotRunning': {
        const want = name === 'appRunning'
        const r = await poll(async () => {
          const a = await d.appRunning(s.pkg || pkg)
          return { done: a.ok && a.running === want, a }
        }, s.timeout ?? DEFAULT_TIMEOUT.poll)
        return r.done ? { ok: true, message: want ? '앱 실행 중' : '앱 종료됨' }
          : { ok: false, message: want ? '앱이 실행 중이 아닙니다' : '앱이 아직 실행 중입니다' }
      }
      case 'audioPlaying':
      case 'audioSilent': {
        const want = name === 'audioPlaying'
        const r = await poll(async () => {
          const a = await d.audioPlaying(s.pkg || pkg)
          return { done: a.ok && a.playing === want, a }
        }, s.timeout ?? DEFAULT_TIMEOUT.poll)
        return r.done ? { ok: true, message: want ? '소리 재생 중' : '소리 없음' }
          : { ok: false, message: want ? '앱이 소리를 내지 않습니다 (재생 중인 오디오 없음)' : '앱이 아직 소리를 내고 있습니다' }
      }
      case 'count': {
        const dump = await d.dump()
        if (!dump.ok) return { ok: false, message: dump.message }
        const n = qx.findAll(dump.nodes, s.sel).length
        const op = s.op || '=='
        return compare(op, n, s.value)
          ? { ok: true, message: `${qx.describeSelector(s.sel)} ${n}개` }
          : { ok: false, message: `${qx.describeSelector(s.sel)} 가 ${n}개 — 기대 ${op} ${s.value}` }
      }
      case 'sameAsSnapshot': {
        const snap = snapshots[s.name]
        if (!snap) return { ok: false, message: `저장된 화면 "${s.name}" 이 없습니다 (업데이트 전 단계의 snapshot 이 실행되지 않았습니다)` }
        const dump = await d.dump()
        if (!dump.ok) return { ok: false, message: dump.message }
        const now = new Set(visibleLabels(dump.nodes))
        const ignore = (s.ignore || []).map(p => new RegExp(p))
        const missing = snap.labels.filter(l => !now.has(l) && !ignore.some(re => re.test(l)))
        return missing.length
          ? { ok: false, message: `업데이트 전에 있던 ${missing.length}개가 사라졌습니다: ${missing.slice(0, 10).join(' / ')}${missing.length > 10 ? ' …' : ''}` }
          : { ok: true, message: `업데이트 전 화면 글자 ${snap.labels.length}개 모두 있음` }
      }
      default:
        return { ok: false, message: `모르는 판정: ${name}` }
    }
  }

  // 사람에게 묻는 단계
  async function ask(s, ctx) {
    if (!hooks.ask) return { ok: false, message: '사람 응답을 받을 수 없습니다' }
    const kind = s.do
    progress({ type: 'waiting', itemId: ctx.item.id, kind, message: s.message })
    const a = await hooks.ask({
      kind, itemId: ctx.item.id, title: ctx.item.title, message: s.message,
      detail: { pre: ctx.item.pre || '', steps: ctx.item.steps || '', expected: ctx.item.expected || '' },
      dev: s.dev || '',
    }) || {}
    if (a.action === 'stop') { stopped = true; throw new StopRun('사용자가 중단했습니다') }
    if (kind === 'prompt') {
      if (a.action === 'block') throw new ItemBlocked(a.note ? `진행 불가: ${a.note}` : '진행할 수 없다고 응답했습니다')
      return { ok: true, message: '확인 후 계속' }
    }
    ctx.answerNote = a.note || ''
    if (a.result === 'Pass') return { ok: true, message: a.note ? `사람 판정 Pass — ${a.note}` : '사람 판정 Pass' }
    if (a.result === 'Blocked') throw new ItemBlocked(a.note || '사람 판정 Blocked')
    if (a.result === 'Skipped') { ctx.skipped = a.note || '사람이 건너뜀'; throw new ItemBlocked('__skip__') }
    return { ok: false, message: a.note ? `사람 판정 Fail — ${a.note}` : '사람 판정 Fail' }
  }

  // 단계 목록을 차례로. 첫 실패에서 멈춘다.
  async function runSeq(list, ctx, part = 'steps') {
    for (const step of list) {
      checkStop()
      const label = describeStep(step)
      progress({ type: 'step', itemId: ctx.item.id, part, label })
      let r
      try { r = await execStep(step, ctx) } catch (e) {
        if (e instanceof StopRun || e instanceof ItemBlocked) throw e
        r = { ok: false, message: e.message }
      }
      // optional: 기기·OS 버전에 따라 나오지 않을 수 있는 단계 (예: Android 13 미만엔 알림 권한 창이 없다)
      if (!r.ok && step.optional) {
        ctx.log.push({ part, label, ok: true, message: `건너뜀(선택 단계): ${r.message}` })
        continue
      }
      ctx.log.push({ part, label, ok: r.ok, message: r.message })
      if (!r.ok) return { ok: false, message: `${label} — ${r.message}`, step }
    }
    return { ok: true }
  }

  // 실패 순간의 증거: 쓰인 역할 기기마다 스크린샷과 화면 구조
  async function captureEvidence(item, roleList, res) {
    if (!hooks.evidence) return
    for (const dev of roleList) {
      const r = roles[dev]
      if (!r) continue
      try {
        const shot = await r.driver.screenshot()
        if (shot.ok) { const p = await hooks.evidence(item.id, dev, `${dev}-screen.png`, shot.buf); if (p) res.evidence.push(p) }
        const dump = await r.driver.dump()
        if (dump.ok) { const p = await hooks.evidence(item.id, dev, `${dev}-screen.xml`, dump.xml); if (p) res.evidence.push(p) }
      } catch (e) { res.notes.push(`증거 저장 실패(${dev}): ${e.message}`) }
    }
  }

  async function runItem(item, phase) {
    const started = Date.now()
    const res = {
      id: item.id, title: item.title || '', phase, status: 'To do', reason: '', mode: '',
      startedAt: new Date(started).toISOString(), durationMs: 0, steps: [], evidence: [], notes: [],
    }
    const done = (status, reason = '') => {
      res.status = status
      res.reason = reason
      res.durationMs = Date.now() - started
      progress({ type: 'item-end', itemId: item.id, phase, status, reason })
      return res
    }
    progress({ type: 'item-start', itemId: item.id, phase, title: item.title })

    if (isIosOnly(item)) return done('Skipped', 'iOS 전용 항목')
    const dut = roles.A
    const sc0 = scenarios.get(item.id)
    let sc = sc0
    if (!sc) {
      if (!opts.manualForUnscripted) return done('To do', '시나리오 없음')
      // 시나리오가 없는 항목: 체크리스트 문구를 보여 주고 사람이 판정한다
      sc = { id: item.id, mode: 'manual', roles: ['A'], pre: [], steps: [], teardown: [] }
    }
    res.mode = sc0 ? (sc.mode || 'auto') : 'manual'
    if (sc.variants && dut?.variantId && !sc.variants.includes(dut.variantId)) return done('Skipped', `이 앱 타입(${dut.variantId}) 대상 항목이 아닙니다`)
    const missing = (sc.roles || ['A']).filter(r => !roles[r])
    if (missing.length) return done('Blocked', `기기 부족: 역할 ${missing.join('·')} 에 기기가 배정되지 않았습니다`)

    const usedRoles = sc.roles || ['A']
    const ctx = {
      item, log: res.steps, vars: {}, netOff: {}, answerNote: '', skipped: '',
      accounts: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v.account])),
      pkgs: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v.pkg])),
    }
    const marks = {}
    for (const dev of usedRoles) { try { marks[dev] = hooks.logcat?.mark(dev) } catch { } }

    let status = 'Pass'
    let reason = ''
    let evidenceTaken = false
    try {
      const pre = expandSteps(sc.pre || [], procedures)
      const preR = await runSeq(pre, ctx, 'pre')
      if (!preR.ok) {
        status = 'Blocked'
        reason = `사전 조건 실패: ${preR.message}`
      } else {
        let steps = expandSteps(sc.steps || [], procedures)
        // 사람 판정 항목인데 묻는 단계가 없으면 마지막에 기대 결과로 묻는다
        if (res.mode === 'manual' && !JSON.stringify(steps).includes('"do":"ask"')) {
          steps = [...steps, { do: 'ask', message: item.expected ? `기대 결과: ${item.expected}` : (item.title || item.id) }]
        }
        const r = await runSeq(steps, ctx, 'steps')
        if (!r.ok) { status = 'Fail'; reason = r.message }
      }
      if (status !== 'Pass') { await captureEvidence(item, usedRoles, res); evidenceTaken = true }
    } catch (e) {
      if (e instanceof StopRun) { status = 'To do'; reason = '중단됨' }
      else if (e instanceof ItemBlocked) {
        if (e.message === '__skip__') { status = 'Skipped'; reason = ctx.skipped } else { status = 'Blocked'; reason = e.message }
      } else { status = 'Blocked'; reason = `실행 오류: ${e.message}` }
    } finally {
      // teardown 은 무슨 일이 있어도 끝까지 돈다 (멈춤 요청은 그 뒤에 반영된다)
      inTeardown = true
      try {
        const td = expandSteps(sc.teardown || [], procedures)
        if (td.length) {
          const t = await runSeq(td, ctx, 'teardown').catch(e => ({ ok: false, message: e.message }))
          if (!t.ok) res.notes.push(`정리 단계 실패: ${t.message}`)
        }
        for (const dev of Object.keys(ctx.netOff)) {
          const n = await roles[dev]?.driver.network(true)
          res.notes.push(n?.ok ? `역할 ${dev} 네트워크를 다시 켰습니다 (시나리오가 켜지 않았음)` : `역할 ${dev} 네트워크 복구 실패: ${n?.message}`)
        }
      } catch (e) { res.notes.push(`정리 단계 오류: ${e.message}`) }
      inTeardown = false
    }

    // 크래시 확인 + 로그 저장
    for (const dev of usedRoles) {
      let lines = []
      try { lines = hooks.logcat?.slice(dev, marks[dev]) || [] } catch { }
      const crash = dev === 'A' || roles[dev]?.pkg ? detectCrash(lines, roles[dev]?.pkg || '') : ''
      if (crash && status !== 'To do') {
        reason = status === 'Pass' ? crash : `${crash} / ${reason}`
        status = 'Fail'
        if (!evidenceTaken) { await captureEvidence(item, usedRoles, res); evidenceTaken = true }
      }
      if ((status === 'Fail' || status === 'Blocked') && lines.length && hooks.evidence) {
        try {
          const p = await hooks.evidence(item.id, dev, `${dev}-logcat.txt`, lines.join('\n'))
          if (p) res.evidence.push(p)
        } catch { }
      }
    }
    if (ctx.answerNote && !reason) res.notes.push(ctx.answerNote)
    return done(status, reason)
  }

  async function wake() {
    for (const [dev, r] of Object.entries(roles)) {
      try {
        await r.driver.key('screenOn')
        await r.driver.shell('wm dismiss-keyguard')
      } catch (e) { progress({ type: 'log', message: `역할 ${dev} 화면 깨우기 실패: ${e.message}` }) }
    }
  }

  // items: 실행할 체크리스트 항목(순서대로). update: 업데이트 테스트로 돌릴지.
  async function run({ items, update = false }) {
    const results = []
    const markRest = (list, phase, status, reason) => {
      for (const it of list) if (!results.some(r => r.id === it.id && r.phase === phase)) results.push({ id: it.id, title: it.title || '', phase, status, reason, mode: '', durationMs: 0, steps: [], evidence: [], notes: [] })
    }
    await wake()
    const phaseOf = it => scenarios.get(it.id)?.update
    const runList = async (list, phase) => {
      for (const it of list) {
        if (stopped) break
        results.push(await runItem(it, phase))
      }
      if (stopped) markRest(list, phase, 'To do', '중단됨')
    }

    if (!update) {
      progress({ type: 'phase', phase: 'run', total: items.length })
      await runList(items, '')
      return { items: results, stopped }
    }

    const beforeItems = items.filter(it => ['before', 'both'].includes(phaseOf(it)))
    const afterItems = items.filter(it => phaseOf(it) !== 'before')
    progress({ type: 'phase', phase: 'install-base', total: beforeItems.length + afterItems.length })
    const base = hooks.installApk ? await hooks.installApk('base') : { ok: false, message: 'APK 설치를 할 수 없습니다' }
    if (!base.ok) {
      markRest(beforeItems, 'before', 'Blocked', `기존 버전 설치 실패: ${base.message}`)
      markRest(afterItems, 'after', 'Blocked', `기존 버전 설치 실패: ${base.message}`)
      return { items: results, stopped, message: base.message }
    }
    progress({ type: 'phase', phase: 'before', message: base.message })
    await runList(beforeItems, 'before')
    if (stopped) { markRest(afterItems, 'after', 'To do', '중단됨'); return { items: results, stopped } }

    progress({ type: 'phase', phase: 'install-update' })
    const upd = await hooks.installApk('update')
    if (!upd.ok) {
      markRest(afterItems, 'after', 'Blocked', `업데이트 설치 실패: ${upd.message}`)
      return { items: results, stopped, message: upd.message }
    }
    await wake()
    progress({ type: 'phase', phase: 'after', message: upd.message })
    await runList(afterItems, 'after')
    return { items: results, stopped }
  }

  return { run, stop() { stopped = true }, get stopped() { return stopped } }
}

module.exports = { createRunner, detectCrash, describeStep }

// ── 자가진단 (가짜 기기) ────────────────────────────────────────
if (require.main === module) {
  const assert = require('assert')

  // 화면 = 글자 목록. tap 하면 transitions[글자] 로 화면이 바뀐다.
  function fakeDevice(name, { screens, start, transitions = {}, crashOnTap = '' } = {}) {
    const st = { screen: start, net: true, taps: [], typed: [], shell: [], keys: [], running: true, playing: false, logs: [], screenshots: 0 }
    const node = l => ({ text: l, desc: '', label: l, id: '', cls: 'android.widget.Button', visible: true, enabled: true, checked: false, clickable: true, cx: 10, cy: 10, bounds: { x1: 0, y1: 0, x2: 20, y2: 20 } })
    const nodes = () => (screens[st.screen] || []).map(node)
    const find = sel => qx.find(nodes(), sel)
    const d = {
      st,
      async dump() { return { ok: true, xml: `<hierarchy>${st.screen}</hierarchy>`, nodes: nodes() } },
      async waitFor(sel) { const n = find(sel); return n ? { ok: true, node: n } : { ok: false, message: `요소 없음: ${qx.describeSelector(sel)}` } },
      async waitGone(sel) { return find(sel) ? { ok: false, message: '보이면 안 되는 요소' } : { ok: true } },
      async tap(sel) {
        const n = find(sel)
        if (!n) return { ok: false, message: `요소 없음: ${qx.describeSelector(sel)}` }
        st.taps.push(n.label)
        if (crashOnTap === n.label) { st.logs.push('E AndroidRuntime: FATAL EXCEPTION: main', 'E AndroidRuntime: Process: net.app, PID: 1', 'E AndroidRuntime: java.lang.NullPointerException') }
        if (transitions[n.label]) st.screen = transitions[n.label]
        return { ok: true, x: 10, y: 10, node: n }
      },
      async longPress(sel, ms) { st.playing = true; return d.tap(sel) },
      async type(v) { st.typed.push(v); return { ok: true, message: `텍스트 입력 (${String(v).length}자)` } },
      async key(k) { st.keys.push(k); return { ok: true } },
      async shell(c) { st.shell.push(c); return { ok: true, out: '' } },
      async network(on) { st.net = on; return { ok: true } },
      async launch() { st.running = true; return { ok: true } },
      async stop() { st.running = false; return { ok: true } },
      async clearData() { return { ok: true } },
      async appRunning() { return { ok: true, running: st.running } },
      async audioPlaying() { return { ok: true, playing: st.playing } },
      async currentActivity() { return { ok: true, pkg: 'net.app', activity: 'net.app.MainActivity' } },
      async screenshot() { st.screenshots++; return { ok: true, buf: Buffer.from('PNG') } },
      async screenSize() { return { ok: true, width: 1000, height: 2000 } },
      async locate(sel) { return { ok: true, x: 500, y: 1000 } },
      async tapAt() { return { ok: true } },
      async swipe() { return { ok: true } },
      async scrollFind(sel) { return d.waitFor(sel) },
      async notifications() { return { ok: true } },
      async permission() { return { ok: true } },
      async overlay() { return { ok: true } },
      async location() { return { ok: true } },
    }
    return d
  }

  const screens = {
    consent: ['전화번호 수집 동의', '동의하기', '앱 종료'],
    login: ['이메일 로그인', '로그인'],
    main: ['채널 test1', 'PTT'],
    receiving: ['채널 test1', '수신중'],
  }

  ;(async () => {
    const evidence = []
    const asks = []
    let answers = []
    const mk = (roleDevs, extra = {}) => {
      const roles = {}
      for (const [k, dev] of Object.entries(roleDevs)) roles[k] = { driver: dev, pkg: 'net.app', account: { id: `qa_${k}`, password: 'pw' }, variantId: 'free' }
      return createRunner({
        roles,
        scenarios: extra.scenarios,
        procedures: extra.procedures || {},
        options: { settleMs: 0, pollMs: 10, ...extra.options },
        hooks: {
          evidence: async (id, dev, file, data) => { evidence.push(`${id}/${file}`); return `${id}/${file}` },
          ask: async req => { asks.push(req); return answers.shift() || { result: 'Pass' } },
          logcat: { mark: dev => roleDevs[dev].st.logs.length, slice: (dev, m) => roleDevs[dev].st.logs.slice(m) },
          installApk: extra.installApk,
          progress: extra.progress,
        },
      })
    }
    const procedures = {
      '권한 동의 통과': [{ dev: '$dev', do: 'tap', sel: { text: '동의하기' } }],
      '로그인': [{ dev: '$dev', do: 'type', value: '$account.id' }, { dev: '$dev', do: 'tap', sel: { text: '로그인' } }],
    }
    const scenarios = new Map(Object.entries({
      PASS_1: { id: 'PASS_1', roles: ['A'], pre: [{ use: '권한 동의 통과', dev: 'A' }], steps: [{ dev: 'A', expect: 'visible', sel: { text: '이메일 로그인' } }], teardown: [] },
      FAIL_1: {
        id: 'FAIL_1', roles: ['A'], pre: [],
        steps: [{ dev: 'A', do: 'network', on: false }, { dev: 'A', expect: 'visible', sel: { text: '없는 문구' }, timeout: 10 }],
        teardown: [{ dev: 'A', do: 'adb', cmd: 'echo teardown' }],
      },
      PRE_FAIL: { id: 'PRE_FAIL', roles: ['A'], pre: [{ dev: 'A', do: 'tap', sel: { text: '없는 버튼' }, timeout: 10 }], steps: [{ dev: 'A', do: 'stop' }], teardown: [] },
      TWO_DEV: {
        id: 'TWO_DEV', roles: ['A', 'B'], pre: [],
        steps: [{ parallel: [{ dev: 'B', do: 'longPress', sel: { text: 'PTT' }, ms: 10 }, [{ dev: 'A', do: 'sleep', ms: 5 }, { dev: 'A', expect: 'visible', sel: { text: '채널 test1' } }]] }, { dev: 'B', expect: 'audioPlaying', timeout: 50 }],
        teardown: [],
      },
      ADMIN_ONLY: { id: 'ADMIN_ONLY', roles: ['A'], variants: ['admin'], steps: [{ dev: 'A', do: 'stop' }], pre: [], teardown: [] },
      NO_ACCOUNT: { id: 'NO_ACCOUNT', roles: ['A'], pre: [{ dev: 'A', do: 'type', value: '$account.phone' }], steps: [{ dev: 'A', do: 'stop' }], teardown: [] },
      CRASH: { id: 'CRASH', roles: ['A'], pre: [], steps: [{ dev: 'A', do: 'tap', sel: { text: '동의하기' } }], teardown: [] },
      SEMI: { id: 'SEMI', mode: 'semi', roles: ['A'], pre: [], steps: [{ do: 'prompt', message: '관리자 페이지에서 재시작 요청을 보내 주세요' }, { dev: 'A', expect: 'appRunning' }], teardown: [] },
      COUNT: { id: 'COUNT', roles: ['A'], pre: [], steps: [{ dev: 'A', expect: 'count', sel: { class: 'Button' }, op: '>=', value: 3 }], teardown: [] },
    }))

    // ── 일반 실행 ──
    const A = fakeDevice('A', { screens, start: 'consent', transitions: { 동의하기: 'login' } })
    const B = fakeDevice('B', { screens, start: 'main' })
    const r1 = await mk({ A, B }, { scenarios, procedures }).run({ items: [
      { id: 'PASS_1', title: '동의 후 로그인 화면' },
      { id: 'FAIL_1', title: '없는 문구' },
      { id: 'PRE_FAIL' },
      { id: 'IOS_1', platform: 'iOS' },
      { id: 'ADMIN_ONLY' },
      { id: 'NO_ACCOUNT' },
      { id: 'UNSCRIPTED', title: '진동이 울린다', expected: '진동이 1회 울린다' },
    ] })
    const by = id => r1.items.find(i => i.id === id)
    assert.strictEqual(by('PASS_1').status, 'Pass', JSON.stringify(by('PASS_1')))
    assert.strictEqual(A.st.taps[0], '동의하기', '공통 절차로 동의하기를 눌렀다')
    assert.strictEqual(by('FAIL_1').status, 'Fail')
    assert.ok(by('FAIL_1').reason.includes('없는 문구'), by('FAIL_1').reason)
    assert.ok(by('FAIL_1').evidence.includes('FAIL_1/A-screen.png') && by('FAIL_1').evidence.includes('FAIL_1/A-screen.xml'), '실패 증거')
    assert.ok(A.st.shell.includes('echo teardown'), '실패해도 teardown 은 돈다')
    assert.strictEqual(A.st.net, true, '시나리오가 끈 네트워크를 되돌린다')
    assert.ok(by('FAIL_1').notes.some(n => n.includes('네트워크를 다시 켰습니다')))
    assert.strictEqual(by('PRE_FAIL').status, 'Blocked')
    assert.ok(by('PRE_FAIL').reason.startsWith('사전 조건 실패'))
    assert.strictEqual(by('IOS_1').status, 'Skipped')
    assert.strictEqual(by('ADMIN_ONLY').status, 'Skipped', '이 타입 대상 아님')
    assert.strictEqual(by('NO_ACCOUNT').status, 'Blocked')
    assert.ok(/계정|값이 없습니다/.test(by('NO_ACCOUNT').reason), by('NO_ACCOUNT').reason)
    assert.strictEqual(by('UNSCRIPTED').status, 'Pass', '시나리오 없는 항목은 사람 판정 (기본 응답 Pass)')
    assert.strictEqual(by('UNSCRIPTED').mode, 'manual')
    const unscriptedAsk = asks.find(a => a.itemId === 'UNSCRIPTED')
    assert.ok(unscriptedAsk && unscriptedAsk.message.includes('진동이 1회') && unscriptedAsk.detail.expected === '진동이 1회 울린다', '체크리스트 문구를 보여 준다')
    assert.ok(!JSON.stringify(r1).includes('"pw"'), '비밀번호가 결과에 남지 않는다')

    // optional 단계: 없으면 건너뛰고 다음 단계로
    const optSc = new Map([['OPT', { id: 'OPT', roles: ['A'], pre: [], steps: [
      { dev: 'A', do: 'tap', sel: { text: '알림 허용' }, timeout: 10, optional: true },
      { dev: 'A', expect: 'visible', sel: { text: 'PTT' } },
    ], teardown: [] }]])
    const rOpt = await mk({ A: fakeDevice('A', { screens, start: 'main' }) }, { scenarios: optSc }).run({ items: [{ id: 'OPT' }] })
    assert.strictEqual(rOpt.items[0].status, 'Pass', JSON.stringify(rOpt.items[0]))
    assert.ok(rOpt.items[0].steps[0].message.startsWith('건너뜀'))

    // ── 다중 기기·병렬·오디오, 기기 부족, 크래시, 반자동, 개수 ──
    const A2 = fakeDevice('A', { screens, start: 'main', crashOnTap: '' })
    const B2 = fakeDevice('B', { screens, start: 'main' })
    const r2 = await mk({ A: A2, B: B2 }, { scenarios, procedures }).run({ items: [{ id: 'TWO_DEV' }, { id: 'COUNT' }] })
    assert.strictEqual(r2.items[0].status, 'Pass', JSON.stringify(r2.items[0]))
    assert.deepStrictEqual(B2.st.taps, ['PTT'])
    assert.strictEqual(r2.items[1].status, 'Fail', '버튼 2개 < 3')
    assert.ok(r2.items[1].reason.includes('2개'))
    const r3 = await mk({ A: fakeDevice('A', { screens, start: 'main' }) }, { scenarios }).run({ items: [{ id: 'TWO_DEV' }] })
    assert.strictEqual(r3.items[0].status, 'Blocked')
    assert.ok(r3.items[0].reason.includes('기기 부족'))
    const AC = fakeDevice('A', { screens, start: 'consent', transitions: { 동의하기: 'login' }, crashOnTap: '동의하기' })
    const r4 = await mk({ A: AC }, { scenarios }).run({ items: [{ id: 'CRASH' }] })
    assert.strictEqual(r4.items[0].status, 'Fail', '단계는 통과해도 크래시면 Fail')
    assert.ok(r4.items[0].reason.startsWith('크래시'), r4.items[0].reason)
    assert.ok(r4.items[0].evidence.some(e => e.endsWith('A-logcat.txt')), '로그 저장')
    answers = [{ action: 'continue' }]
    const r5 = await mk({ A: fakeDevice('A', { screens, start: 'main' }) }, { scenarios }).run({ items: [{ id: 'SEMI' }] })
    assert.strictEqual(r5.items[0].status, 'Pass')
    answers = [{ action: 'block', note: '관리자 계정 없음' }]
    const r6 = await mk({ A: fakeDevice('A', { screens, start: 'main' }) }, { scenarios }).run({ items: [{ id: 'SEMI' }] })
    assert.strictEqual(r6.items[0].status, 'Blocked')
    assert.ok(r6.items[0].reason.includes('관리자 계정 없음'))
    answers = [{ result: 'Fail', note: '진동 없음' }]
    const r7 = await mk({ A: fakeDevice('A', { screens, start: 'main' }) }, { scenarios }).run({ items: [{ id: 'UNSCRIPTED', title: '진동' }] })
    assert.strictEqual(r7.items[0].status, 'Fail')
    assert.ok(r7.items[0].reason.includes('진동 없음'))

    // ── 중단: 현재 항목은 To do(중단됨), 나머지도 To do, teardown 은 돈다 ──
    answers = [{ action: 'stop' }]
    const AS = fakeDevice('A', { screens, start: 'main' })
    const stopSc = new Map([...scenarios, ['STOPPER', { id: 'STOPPER', roles: ['A'], pre: [], steps: [{ do: 'ask', message: '확인?' }], teardown: [{ dev: 'A', do: 'adb', cmd: 'echo cleanup' }] }]])
    const r8 = await mk({ A: AS }, { scenarios: stopSc }).run({ items: [{ id: 'STOPPER' }, { id: 'COUNT' }] })
    assert.strictEqual(r8.stopped, true)
    assert.deepStrictEqual(r8.items.map(i => [i.id, i.status, i.reason]), [['STOPPER', 'To do', '중단됨'], ['COUNT', 'To do', '중단됨']])
    assert.ok(AS.st.shell.includes('echo cleanup'), '중단돼도 teardown')

    // ── 업데이트 테스트: 기존 설치 → before(스냅샷) → 업데이트 설치 → after(비교) ──
    const installs = []
    const AU = fakeDevice('A', { screens: { ...screens, history: ['기록 1', '기록 2', '설정'] }, start: 'history' })
    const updSc = new Map([
      ['U_BEFORE', { id: 'U_BEFORE', update: 'before', roles: ['A'], pre: [], steps: [{ dev: 'A', do: 'snapshot', name: '히스토리' }], teardown: [] }],
      ['U_AFTER', { id: 'U_AFTER', update: 'after', roles: ['A'], pre: [], steps: [{ dev: 'A', expect: 'sameAsSnapshot', name: '히스토리' }], teardown: [] }],
      ['U_NORMAL', { id: 'U_NORMAL', roles: ['A'], pre: [], steps: [{ dev: 'A', expect: 'visible', sel: { text: '설정' } }], teardown: [] }],
    ])
    const r9 = await mk({ A: AU }, {
      scenarios: updSc,
      installApk: async kind => {
        installs.push(kind)
        if (kind === 'update') AU.st.screen = 'history2'     // 업데이트 후 '기록 2' 가 사라진 상황
        return { ok: true, message: `${kind} 설치` }
      },
    }).run({ items: [{ id: 'U_BEFORE' }, { id: 'U_AFTER' }, { id: 'U_NORMAL' }], update: true })
    assert.deepStrictEqual(installs, ['base', 'update'], '기존 → 업데이트 순서')
    assert.deepStrictEqual(r9.items.map(i => [i.id, i.phase]), [['U_BEFORE', 'before'], ['U_AFTER', 'after'], ['U_NORMAL', 'after']])
    assert.strictEqual(r9.items[0].status, 'Pass')
    assert.strictEqual(r9.items[1].status, 'Fail', '업데이트 후 사라진 정보 → Fail')
    assert.ok(r9.items[1].reason.includes('기록 1') && r9.items[1].reason.includes('기록 2'), r9.items[1].reason)
    // 업데이트 설치 실패 → 이후 항목 Blocked
    const r10 = await mk({ A: fakeDevice('A', { screens, start: 'main' }) }, {
      scenarios: updSc, installApk: async kind => (kind === 'base' ? { ok: true } : { ok: false, message: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' }),
    }).run({ items: [{ id: 'U_BEFORE' }, { id: 'U_NORMAL' }], update: true })
    const after = r10.items.find(i => i.id === 'U_NORMAL')
    assert.strictEqual(after.status, 'Blocked')
    assert.ok(after.reason.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE'))

    // 크래시 판별
    assert.strictEqual(detectCrash(['I foo', 'E AndroidRuntime: FATAL EXCEPTION: main', 'E AndroidRuntime: Process: other.app, PID: 2'], 'net.app'), '', '다른 앱 크래시는 무시')
    assert.ok(detectCrash(['E ActivityManager: ANR in net.app (net.app/.Main)'], 'net.app').startsWith('ANR'))
    assert.strictEqual(describeStep({ dev: 'A', do: 'type', value: 'secret' }).includes('secret'), false, '입력 값은 표시하지 않는다')

    console.log('qa-runner 자가진단 통과 — 판정·증거·teardown·다중 기기·사람 판정·중단·크래시·업데이트 테스트')
  })().catch(e => { console.error('자가진단 실패:', e); process.exit(1) })
}
