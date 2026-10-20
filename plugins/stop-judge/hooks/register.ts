import type { EngineInterface, Register } from 'claude-code'
import { buildSystem, buildUser, decide, framingAndPrior, guardOutcome, minutesSinceOperator, nudgeText, parseRows, parseVerdict, splitTurn, TAIL_BYTES, transcriptFindArgv } from './judge.ts'
import { firingLine, logPath } from './shared/firing.ts'
import { settingsFrom, statusText, stopJudgeCommand, USAGE } from './settings.ts'
import type { Settings } from './settings.ts'

// Judges every main-loop turn that ends on an answer: a haiku call reads the operator's framing
// messages and the agent's final message; a "continue" it is sure of goes back to the agent as a
// user-style prompt, once per operator prompt. Nothing blocks the stop. Pure logic is in judge.ts.

const COMMAND = 'stop-judge'
const SETTING = 'settings'
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'slack-ping'])
const DAY_MS = 86_400_000
const MODEL_TIMEOUT_MS = 20_000

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

async function decisionsInfo($: EngineInterface, dir: string): Promise<{ lines: number; date: string } | null> {
  if (dir === '') return null
  const path = `${dir}/DECISIONS.md`
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return { lines: text.split('\n').filter(l => l.trim() !== '').length, date: /^# Decisions \(derived (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? 'undated' }
  } catch {
    return null
  }
}

const statusFor = (s: Settings): string | undefined => (s.isOff ? 'stop-judge off' : undefined)

type State = { nudgedThisPrompt: boolean; transcript: { id: string; path: string } | undefined }

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

export const register: Register = on => {
  const state: State = { nudgedThisPrompt: false, transcript: undefined }

  on('session.start', async ($, e, next) => {
    state.nudgedThisPrompt = false
    state.transcript = undefined
    $.ui.status(statusFor(settingsFrom(await $.store.get(SETTING))))
    // A refused registration (the other install of this plugin holds the name) stops the rest.
    await $.command.register({
      name: COMMAND,
      description: 'Stop judge on/off, DECISIONS.md context on/off, derive [all]',
      argumentHint: '[off|on|context off|on|derive [all]]',
      immediate: true,
    })
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
      case 'context-on':
      case 'derive':
        return { text: `${action.kind === 'derive' ? 'derive' : 'context'} lands in the next build` }
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
    return next(e)
  })
}
