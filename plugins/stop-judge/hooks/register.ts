import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, Register } from 'claude-code'
import { bulletCount, CONTEXT_MAX_CHARS, datedQuotesOf, fitContext, headerLine, keepVerifiedBullets, validateDecisions, withHeader } from './decisions.ts'
import { READER_PROMPT, SYNTH_PROMPT } from './derive-prompts.ts'
import {
  batches,
  capSynthesisInput,
  confirmText,
  contentOfReply,
  COST_PER_TURN_USD,
  estimateUsd,
  isPermanent,
  mayHoldTurn,
  MIN_TYPED,
  packSessions,
  parseReaderLines,
  pool,
  POOL,
  retryDelayS,
  ROW_GREP_PATTERN,
  selectCandidates,
  sessionDates,
  SYNTH_INPUT_MAX_CHARS,
  synthesisInput,
  tooManyFailed,
  TURN_CAP,
  typedTurnsOf,
  usageUsd,
  verifyReaderLines,
  windowText,
} from './derive.ts'
import type { Batch, Session } from './derive.ts'
import { buildSystem, buildUser, decide, framingAndPrior, guardOutcome, minutesSinceOperator, nudgeText, parseRows, parseVerdict, splitTurn, TAIL_BYTES, transcriptFindArgv } from './judge.ts'
import { firingLine, logPath } from './shared/firing.ts'
import { settingsFrom, statusText, stopJudgeCommand, USAGE } from './settings.ts'
import type { Settings } from './settings.ts'

// Judges every main-loop turn that ends on an answer: a haiku call reads the operator's framing
// messages and the agent's final message; a "continue" it is sure of goes back to the agent as a
// user-style prompt, once per operator prompt. Nothing blocks the stop. Pure logic is in judge.ts.
// `/stop-judge derive` scans the transcripts inside the command, then reads and synthesizes in a
// loop detached from it; its pure side is derive.ts and decisions.ts.

const COMMAND = 'stop-judge'
const SETTING = 'settings'
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'slack-ping'])
const DAY_MS = 86_400_000
const MODEL_TIMEOUT_MS = 20_000
const READER_TIMEOUT_MS = 300_000
const SYNTH_TIMEOUT_MS = 600_000
const RUN = 'Run'

async function stateDir($: EngineInterface): Promise<{ home: string; dir: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = (await $.env.get('STOPSTOPPING_DIR')) || (home ? `${home}/.claude/stopstopping` : '')
  return { home, dir }
}

// One line per firing in the shared log; a failed write never stops the judge.
async function record($: EngineInterface, outcome: string, reason: string, ms = 0): Promise<void> {
  try {
    const { dir } = await stateDir($)
    if (dir === '') return
    const path = logPath(dir, COMMAND)
    if (!(await $.fs.exists(path))) await $.fs.write(path, '')
    const line = firingLine(outcome, await $.session.id(), ms, reason, new Date(await $.clock.now()))
    await $.process.run(['tee', '-a', path], { stdin: line })
  } catch {
    // the log is a convenience
  }
}

async function transcriptTail($: EngineInterface, path: string): Promise<string> {
  let text = ''
  for await (const piece of $.process.spawn({ argv: ['tail', '-c', String(TAIL_BYTES), path] })) {
    if (piece.stream === 'stdout') text += piece.text
  }
  return text
}

// Outcome counts of the last seven days; awk filters on the log's leading UTC time, so the
// 4 MiB cap on a run's output never applies to the log.
async function recentCounts($: EngineInterface, dir: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  if (dir === '') return counts
  try {
    const since = `${new Date((await $.clock.now()) - 7 * DAY_MS).toISOString().slice(0, 19)}Z`
    const { stdout } = await $.process.run(['awk', '-v', `since=${since}`, '$1 >= since {print $2}', logPath(dir, COMMAND)])
    for (const outcome of stdout.split('\n')) if (outcome !== '') counts[outcome] = (counts[outcome] ?? 0) + 1
  } catch {
    // no log yet
  }
  return counts
}

const decisionsPath = (dir: string): string => `${dir}/DECISIONS.md`
// The SessionStart hook in hooks.json prints DECISIONS.md unless this file exists.
const contextOffPath = (dir: string): string => `${dir}/context-off`

async function decisionsInfo($: EngineInterface, dir: string): Promise<{ lines: number; date: string } | null> {
  if (dir === '') return null
  const path = decisionsPath(dir)
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return { lines: text.split('\n').filter(l => l.trim() !== '').length, date: /^# Decisions \(derived (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? 'undated' }
  } catch {
    return null
  }
}

const statusFor = (s: Settings): string | undefined => (s.isOff ? 'stop-judge off' : undefined)

type DeriveRun = { controller: AbortController; done: number; total: number }

type State = {
  nudgedThisPrompt: boolean
  transcript: { id: string; path: string } | undefined
  isInteractive: boolean
  derive: DeriveRun | undefined
}

// Found by session id: the project folder is named for where the session started, which a
// worktree move changes. Looked up on a turn, not at session start, when the file may not exist yet.
async function transcriptPath($: EngineInterface, state: State, home: string): Promise<string | undefined> {
  const id = await $.session.id()
  if (state.transcript?.id === id) return state.transcript.path
  if (home === '') return undefined
  const found = (await $.process.run(transcriptFindArgv(home, id))).stdout.split('\n').find(l => l.trim() !== '')
  state.transcript = found ? { id, path: found.trim() } : undefined
  return state.transcript?.path
}

async function judge($: EngineInterface, state: State, e: { agentId?: string; reason: string; answer: string }): Promise<void> {
  const gates = {
    isOff: settingsFrom(await $.store.get(SETTING)).isOff,
    agentId: e.agentId,
    reason: e.reason,
    nested: Boolean(await $.env.get('STOP_JUDGE_NESTED')),
    nudgedThisPrompt: state.nudgedThisPrompt,
  }
  // The opening and the final message come from the transcript; these gates need neither.
  const early = guardOutcome({ ...gates, openingKind: 'none', opening: '', final: 'unread' })
  if (early) return record($, early, '')

  const { home } = await stateDir($)
  const path = await transcriptPath($, state, home)
  if (path === undefined) return record($, 'pass-notext', 'transcript not found')
  const rows = parseRows(await transcriptTail($, path))
  const { final, opening, openingKind, prior } = splitTurn(rows, e.answer || undefined)
  const late = guardOutcome({ ...gates, openingKind, opening, final })
  if (late) return record($, late, '')

  const startedAt = await $.clock.now()
  const minutes = minutesSinceOperator(rows, new Date(startedAt))
  const reply = await $.model.complete({
    model: 'haiku',
    system: buildSystem(),
    prompt: buildUser(final, opening, framingAndPrior(prior), minutes),
    maxTokens: 300,
    effort: 'low',
    timeoutMs: MODEL_TIMEOUT_MS,
  })
  const ms = (await $.clock.now()) - startedAt
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `api-error ${reply.error}` : reply.reason
    return record($, reply.reason === 'aborted' ? 'pass-timeout' : 'pass-error', why, ms)
  }
  const verdict = parseVerdict(reply.text)
  if (!verdict) return record($, 'pass-error', `no verdict in: ${reply.text.slice(0, 160)}`, ms)
  const decision = decide(verdict)
  if (decision.outcome !== 'continue') return record($, decision.outcome, decision.reason, ms)

  if ((await $.prompt.read()).text.trim() !== '') return record($, 'pass-typing', decision.reason, ms)
  state.nudgedThisPrompt = true
  try {
    await $.prompt.submit({ text: nudgeText(decision.reason), asUser: true })
  } catch (error) {
    state.nudgedThisPrompt = false
    throw error
  }
  await record($, 'continue', decision.reason, ms)
}

async function isContextOff($: EngineInterface, dir: string): Promise<boolean> {
  return dir !== '' && (await $.fs.exists(contextOffPath(dir)))
}

// The shell hook prints the file; the mod logs what it printed.
async function logContext($: EngineInterface): Promise<void> {
  try {
    const { dir } = await stateDir($)
    if (dir === '' || (await isContextOff($, dir)) || !(await $.fs.exists(decisionsPath(dir)))) return
    const text = await $.fs.read(decisionsPath(dir))
    await record($, 'context', `context chars=${text.length}`)
  } catch {
    // the log is a convenience
  }
}

// The host's grep does the coarse filter; a line cut between two pieces is carried to the next.
async function transcriptLines($: EngineInterface, path: string): Promise<string[]> {
  const lines: string[] = []
  let carry = ''
  for await (const piece of $.process.spawn({ argv: ['grep', '-a', '-E', ROW_GREP_PATTERN, path] })) {
    if (piece.stream !== 'stdout') continue
    const parts = (carry + piece.text).split('\n')
    carry = parts.pop() ?? ''
    for (const line of parts) if (mayHoldTurn(line)) lines.push(line)
  }
  if (mayHoldTurn(carry)) lines.push(carry)
  return lines
}

async function listOrEmpty($: EngineInterface, path: string) {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

// Every top-level session with its typed turns, newest first.
async function scanSessions($: EngineInterface, home: string): Promise<Session[]> {
  const projectsDir = `${home}/.claude/projects`
  const projects = []
  for (const entry of await listOrEmpty($, projectsDir)) {
    if (entry.kind === 'dir') projects.push({ name: entry.name, files: await listOrEmpty($, `${projectsDir}/${entry.name}`) })
  }
  const candidates = selectCandidates(projects, projectsDir)
  let scanned = 0
  return pool(candidates, POOL, async c => {
    let turns: Session['turns'] = []
    try {
      turns = typedTurnsOf(await transcriptLines($, c.path)).turns
    } catch {
      // an unreadable transcript counts as one with no typed turns
    }
    $.ui.status(`derive: scanning ${++scanned}/${candidates.length}`)
    return { id: c.id, project: c.project, turns }
  })
}

async function lastRate($: EngineInterface, dir: string): Promise<number> {
  try {
    const path = `${dir}/last-run.json`
    if (!(await $.fs.exists(path))) return COST_PER_TURN_USD
    const rate = (JSON.parse(await $.fs.read(path)) as { usdPerTurn?: unknown }).usdPerTurn
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : COST_PER_TURN_USD
  } catch {
    return COST_PER_TURN_USD
  }
}

// One retry, after the back-off, on an API error a wait may clear; a permanent one ends the run.
async function completeWithRetry($: EngineInterface, request: ModelCompleteRequest, signal: AbortSignal): Promise<{ reply: ModelCompleteResult; usd: number }> {
  let reply = await $.model.complete(request, { signal })
  let usd = usageUsd(reply.usage)
  if (!reply.isAnswered && reply.reason === 'api-error') {
    if (isPermanent(reply)) throw new Error(`api-error ${reply.error}`)
    const delayS = retryDelayS(reply, 0)
    if (delayS !== undefined) {
      await $.clock.sleep(delayS * 1000, { signal })
      reply = await $.model.complete(request, { signal })
      usd += usageUsd(reply.usage)
    }
  }
  return { reply, usd }
}

type DerivePlan = { dir: string; today: string; kept: Session[]; turns: number; work: Batch[] }

async function deriveRun($: EngineInterface, run: DeriveRun, plan: DerivePlan): Promise<void> {
  const { signal } = run.controller
  const dates = sessionDates(plan.kept)
  let readerUsd = 0
  let failed = 0
  const found = await pool(plan.work, POOL, async batch => {
    const { reply, usd } = await completeWithRetry($, { model: 'sonnet', system: READER_PROMPT, prompt: batch.text, maxTokens: 8000, timeoutMs: READER_TIMEOUT_MS }, signal)
    readerUsd += usd
    $.ui.status(`derive ${++run.done}/${run.total}`)
    if (!reply.isAnswered) {
      failed++
      return []
    }
    const batchDates = Object.fromEntries(batch.sessions.flatMap(id => (dates[id] === undefined ? [] : [[id, dates[id]]])))
    return verifyReaderLines(parseReaderLines(reply.text, batchDates), batch.operatorText)
  })
  if (signal.aborted) throw new Error('aborted')
  if (tooManyFailed(plan.work.length, failed)) throw new Error(`${failed} of ${plan.work.length} reader calls failed`)

  const path = decisionsPath(plan.dir)
  const current = (await $.fs.exists(path)) ? await $.fs.read(path) : null
  const { kept: lines, dropped } = capSynthesisInput(found.flat(), Math.max(0, SYNTH_INPUT_MAX_CHARS - (current?.length ?? 0)))
  const synth = await completeWithRetry($, { model: 'sonnet', system: SYNTH_PROMPT, prompt: synthesisInput(lines, current), maxTokens: 16000, timeoutMs: SYNTH_TIMEOUT_MS }, signal)
  if (!synth.reply.isAnswered) throw new Error(`synthesis ${synth.reply.reason}`)

  const allowed = [...lines.map(l => ({ quote: l.quote, date: l.date })), ...(current === null ? [] : datedQuotesOf(current))]
  const header = headerLine(plan.today, plan.kept.length, windowText(plan.kept))
  const checked = keepVerifiedBullets(withHeader(contentOfReply(synth.reply.text), header), allowed)
  const valid = validateDecisions(checked.text)
  if (!valid.ok) {
    await record($, 'derive-error', `derive-error reason=line ${valid.line}: ${valid.text}`)
    $.ui.status('derive failed: invalid file, old one kept')
    return
  }
  // Every bullet dropped as unverified: an empty file would replace a good one.
  if (bulletCount(checked.text) === 0) throw new Error(`no bullet kept (${checked.dropped} dropped as unverified)`)
  const file = fitContext(checked.text, CONTEXT_MAX_CHARS)
  if (current !== null) await $.fs.write(`${path}.prev`, current)
  await $.fs.write(path, file)
  const lastRun = { at: new Date(await $.clock.now()).toISOString(), sessions: plan.kept.length, turns: plan.turns, batches: plan.work.length, usdPerTurn: readerUsd / plan.turns }
  await $.fs.write(`${plan.dir}/last-run.json`, `${JSON.stringify(lastRun, null, 2)}\n`)
  const cost = (readerUsd + synth.usd).toFixed(2)
  const drops = `failed-batches=${failed} dropped-lines=${dropped} dropped-bullets=${checked.dropped}`
  await record($, 'derive', `derive sessions=${plan.kept.length} turns=${plan.turns} batches=${plan.work.length} cost=$${cost} ${drops}`)
  $.ui.status(`derive done: ${bulletCount(file)} bullets`)
}

async function deriveInBackground($: EngineInterface, state: State, run: DeriveRun, plan: DerivePlan): Promise<void> {
  try {
    await deriveRun($, run, plan)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'derive failed'
    await record($, 'derive-error', `derive-error reason=${reason}`)
    $.ui.status(`derive failed: ${reason}; old file kept`)
  } finally {
    if (state.derive === run) state.derive = undefined
  }
}

// Scan and confirm inside the command; on Run, the model calls go on after it returns.
async function startDerive($: EngineInterface, state: State, all: boolean, settings: Settings): Promise<{ text: string }> {
  if (!state.isInteractive) return { text: 'derive needs an interactive session' }
  if (state.derive) return { text: state.derive.total === 0 ? 'derive is already started' : `derive is running (${state.derive.done}/${state.derive.total} batches)` }
  const { home, dir } = await stateDir($)
  if (home === '' || dir === '') return { text: 'derive needs HOME' }
  const run: DeriveRun = { controller: new AbortController(), done: 0, total: 0 }
  state.derive = run
  let isDetached = false
  try {
    const sessions = await scanSessions($, home)
    const total = sessions.filter(s => s.turns.length >= MIN_TYPED).reduce((n, s) => n + s.turns.length, 0)
    const { kept, turns } = packSessions(sessions, all ? null : TURN_CAP)
    if (turns === 0) return { text: 'derive: no session with two or more typed turns' }
    const usd = estimateUsd(turns, await lastRate($, dir))
    // A dismissed dialog rejects; it counts as Cancel.
    const answer = await $.ui.ask(confirmText({ sessions: kept.length, turns, total, usd }), [RUN, 'Cancel']).catch(() => 'Cancel')
    if (answer !== RUN || run.controller.signal.aborted) {
      await record($, 'derive-cancelled', `derive-cancelled sessions=${kept.length} turns=${turns}`)
      return { text: 'derive cancelled' }
    }
    const work = batches(kept)
    run.total = work.length
    const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
    void deriveInBackground($, state, run, { dir, today, kept, turns, work })
    isDetached = true
    return { text: `derive: ${work.length} batches in the background; the status line counts them` }
  } finally {
    if (!isDetached) {
      if (state.derive === run) state.derive = undefined
      $.ui.status(statusFor(settings))
    }
  }
}

export const register: Register = on => {
  const state: State = { nudgedThisPrompt: false, transcript: undefined, isInteractive: false, derive: undefined }

  on('session.start', async ($, e, next) => {
    state.nudgedThisPrompt = false
    state.transcript = undefined
    state.isInteractive = e.isInteractive
    $.ui.status(statusFor(settingsFrom(await $.store.get(SETTING))))
    // A refused registration (the other install of this plugin holds the name) stops the rest.
    await $.command.register({
      name: COMMAND,
      description: 'Stop judge on/off, DECISIONS.md context on/off, derive [all]',
      argumentHint: '[off|on|context off|on|derive [all]]',
      immediate: true,
    })
    await logContext($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const action = stopJudgeCommand(e.args)
    const settings = settingsFrom(await $.store.get(SETTING))
    switch (action.kind) {
      case 'off':
      case 'on': {
        const next = { ...settings, isOff: action.kind === 'off' }
        await $.store.set(SETTING, next)
        $.ui.status(statusFor(next))
        return { text: next.isOff ? 'judge off: stopped turns are not judged, in every session' : 'judge on: stopped turns are judged' }
      }
      case 'context-off':
      case 'context-on': {
        const isOff = action.kind === 'context-off'
        await $.store.set(SETTING, { ...settings, isContextOff: isOff })
        const { dir } = await stateDir($)
        if (dir !== '') {
          if (isOff) await $.fs.write(contextOffPath(dir), '')
          else await $.process.run(['rm', '-f', contextOffPath(dir)])
        }
        return { text: isOff ? 'context off: new sessions start without DECISIONS.md' : 'context on: new sessions start with DECISIONS.md' }
      }
      case 'derive':
        return startDerive($, state, action.all, settings)
      case 'usage':
        return { text: USAGE }
      case 'status': {
        const { dir } = await stateDir($)
        return { text: statusText({ settings, counts: await recentCounts($, dir), decisions: await decisionsInfo($, dir) }) }
      }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.has(e.origin.kind)) state.nudgedThisPrompt = false
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      await judge($, state, e)
    } catch (error) {
      await record($, 'pass-error', error instanceof Error ? error.message : 'judge failed')
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    state.nudgedThisPrompt = false
    state.transcript = undefined
    state.derive?.controller.abort()
    return next(e)
  })
}
