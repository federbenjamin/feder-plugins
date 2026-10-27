import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult } from 'claude-code'
import { bulletCount, CONTEXT_MAX_CHARS, datedQuotesOf, decisionsPath, fitContext, headerLine, keepVerifiedBullets, validateDecisions, withHeader } from './decisions.ts'
import { READER_PROMPT, SYNTH_PROMPT } from './derive-prompts.ts'
import {
  batches,
  capSynthesisInput,
  confirmText,
  contentOfReply,
  COST_PER_TURN_USD,
  estimateUsd,
  mayHoldTurn,
  MIN_TYPED,
  packSessions,
  parseReaderLines,
  pool,
  POOL,
  ROW_GREP_PATTERN,
  selectCandidates,
  sessionDates,
  SYNTH_INPUT_MAX_CHARS,
  synthesisInput,
  TURN_CAP,
  typedTurnsOf,
  verifyReaderLines,
  windowText,
} from './derive.ts'
import type { Batch, Session } from './derive.ts'
import { isPermanent, retryDelayS, tooManyFailed } from './shared/retry.ts'
import { COMMAND } from './settings.ts'
import { PRICES, usageUsd } from './shared/pricing.ts'
import { record, stateDirs } from './shared/record.ts'
import { setProgress, showStatus } from './status.ts'
import type { DeriveRun, StatusState } from './status.ts'

// `/stop-judge derive`: the transcripts are scanned and the run confirmed inside the command;
// on Run, the model calls go on in a loop detached from it. The pure side is derive.ts and
// decisions.ts. `startDerive` is the one entry.

const READER_TIMEOUT_MS = 300_000
const SYNTH_TIMEOUT_MS = 600_000
const RUN = 'Run'

export type DeriveState = StatusState & { isInteractive: boolean }

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

// Every top-level session with its typed turns, newest first. The project folders are listed
// POOL at once, as the transcripts are read.
async function scanSessions($: EngineInterface, state: StatusState, run: DeriveRun, home: string): Promise<Session[]> {
  const projectsDir = `${home}/.claude/projects`
  const folders = (await listOrEmpty($, projectsDir)).filter(entry => entry.kind === 'dir')
  const projects = await pool(folders, POOL, async entry => ({ name: entry.name, files: await listOrEmpty($, `${projectsDir}/${entry.name}`) }))
  const candidates = selectCandidates(projects, projectsDir)
  let scanned = 0
  return pool(candidates, POOL, async c => {
    let turns: Session['turns'] = []
    try {
      turns = typedTurnsOf(await transcriptLines($, c.path)).turns
    } catch {
      // an unreadable transcript counts as one with no typed turns
    }
    await setProgress($, state, run, `derive: scanning ${++scanned}/${candidates.length}`)
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
  let usd = usageUsd(reply.usage, PRICES.sonnet)
  if (!reply.isAnswered && reply.reason === 'api-error') {
    if (isPermanent(reply)) throw new Error(`api-error ${reply.error}`)
    const delayS = retryDelayS(reply, 0)
    if (delayS !== undefined) {
      await $.clock.sleep(delayS * 1000, { signal })
      reply = await $.model.complete(request, { signal })
      usd += usageUsd(reply.usage, PRICES.sonnet)
    }
  }
  return { reply, usd }
}

type DerivePlan = { dir: string; today: string; kept: Session[]; turns: number; work: Batch[] }

// What the run did, for the toast at its end.
async function deriveRun($: EngineInterface, state: StatusState, run: DeriveRun, plan: DerivePlan): Promise<string> {
  const { signal } = run.controller
  const dates = sessionDates(plan.kept)
  let readerUsd = 0
  let failed = 0
  const found = await pool(plan.work, POOL, async batch => {
    const { reply, usd } = await completeWithRetry($, { model: 'sonnet', system: READER_PROMPT, prompt: batch.text, maxTokens: 8000, timeoutMs: READER_TIMEOUT_MS }, signal)
    readerUsd += usd
    await setProgress($, state, run, `derive ${++run.done}/${run.total}`)
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
    await record($, COMMAND, 'derive-error', `line ${valid.line}: ${valid.text}`)
    return 'derive failed: invalid file, old one kept'
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
  await record($, COMMAND, 'derive', `sessions=${plan.kept.length} turns=${plan.turns} batches=${plan.work.length} cost=$${cost} ${drops}`)
  return `derive done: ${bulletCount(file)} bullets`
}

// However the run ends (done, failed, aborted at session end), its message goes up as a toast
// and the status line goes back to the settings stored at that moment.
async function deriveInBackground($: EngineInterface, state: StatusState, run: DeriveRun, plan: DerivePlan): Promise<void> {
  let message: string
  try {
    message = await deriveRun($, state, run, plan)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'derive failed'
    await record($, COMMAND, 'derive-error', reason)
    message = `derive failed: ${reason}; old file kept`
  }
  if (state.derive === run) state.derive = undefined
  try {
    $.ui.toast(message)
    await showStatus($, state)
  } catch {
    // the session may be gone
  }
}

// Scan and confirm inside the command; on Run, the model calls go on after it returns.
export async function startDerive($: EngineInterface, state: DeriveState, all: boolean): Promise<{ text: string }> {
  if (!state.isInteractive) return { text: 'derive needs an interactive session' }
  if (state.derive) return { text: state.derive.total === 0 ? 'derive is already started' : `derive is running (${state.derive.done}/${state.derive.total} batches)` }
  const { home, dir } = await stateDirs($)
  if (home === '' || dir === '') return { text: 'derive needs HOME' }
  const run: DeriveRun = { controller: new AbortController(), done: 0, total: 0, progress: undefined }
  state.derive = run
  let isDetached = false
  try {
    const sessions = await scanSessions($, state, run, home)
    const total = sessions.filter(s => s.turns.length >= MIN_TYPED).reduce((n, s) => n + s.turns.length, 0)
    const { kept, turns } = packSessions(sessions, all ? null : TURN_CAP)
    if (turns === 0) return { text: 'derive: no session with two or more typed turns' }
    const usd = estimateUsd(turns, await lastRate($, dir))
    // A dismissed dialog rejects; it counts as Cancel.
    const answer = await $.ui.ask(confirmText({ sessions: kept.length, turns, total, usd }), [RUN, 'Cancel']).catch(() => 'Cancel')
    if (answer !== RUN || run.controller.signal.aborted) {
      await record($, COMMAND, 'derive-cancelled', `sessions=${kept.length} turns=${turns}`)
      return { text: 'derive cancelled' }
    }
    const work = batches(kept)
    run.total = work.length
    await setProgress($, state, run, `derive 0/${work.length}`)
    const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
    void deriveInBackground($, state, run, { dir, today, kept, turns, work })
    isDetached = true
    return { text: `derive: ${work.length} batches in the background; the status line counts them` }
  } finally {
    if (!isDetached) {
      if (state.derive === run) state.derive = undefined
      await showStatus($, state)
    }
  }
}
