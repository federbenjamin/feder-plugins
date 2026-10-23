import type { EngineInterface, Register } from 'claude-code'
import { decisionsPath, parseDecisions, rulesOnly } from './decisions.ts'
import { startDerive } from './derive-run.ts'
import { framingAndPrior, guardOutcome, judgeOutcome, judgeRequest, minutesFact, nudgeText, parseRows, splitTurn, TAIL_BYTES, transcriptFindArgv } from './judge.ts'
import { COMMAND, SETTINGS_KEY, settingsFrom, statusText, stopJudgeCommand, USAGE } from './settings.ts'
import { PERSON_ORIGINS } from './shared/events.ts'
import { countOutcomes, logPath } from './shared/firing.ts'
import { record, stateDirs } from './shared/record.ts'
import { showStatus } from './status.ts'
import type { StatusState } from './status.ts'

// Judges every main-loop turn that ends on an answer: a haiku call reads the operator's framing
// messages and the agent's final message; a "continue" it is sure of goes back to the agent as a
// user-style prompt, once per operator prompt. Nothing blocks the stop. Pure logic is in judge.ts.
// `/stop-judge derive` runs in derive-run.ts.

const DAY_MS = 86_400_000

async function transcriptTail($: EngineInterface, path: string): Promise<string> {
  let text = ''
  for await (const piece of $.process.spawn({ argv: ['tail', '-c', String(TAIL_BYTES), path] })) {
    if (piece.stream === 'stdout') text += piece.text
  }
  return text
}

// Outcome counts of the last seven days. awk keeps the lines from the cutoff on, so the 4 MiB
// cap on a run's output applies to a week of lines, not the whole log; countOutcomes tallies them.
async function recentCounts($: EngineInterface, dir: string): Promise<Record<string, number>> {
  if (dir === '') return {}
  try {
    const since = `${new Date((await $.clock.now()) - 7 * DAY_MS).toISOString().slice(0, 19)}Z`
    const { stdout } = await $.process.run(['awk', '-v', `since=${since}`, '$1 >= since', logPath(dir, COMMAND)])
    return countOutcomes(stdout.split('\n'), since)
  } catch {
    return {} // no log yet
  }
}

// The SessionStart hook in hooks.json prints DECISIONS.md unless this file exists.
const contextOffPath = (dir: string): string => `${dir}/context-off`

async function decisionsInfo($: EngineInterface, dir: string): Promise<{ lines: number; date: string } | null> {
  if (dir === '') return null
  const path = decisionsPath(dir)
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return { lines: text.split('\n').filter(l => l.trim() !== '').length, date: parseDecisions(text).date ?? 'undated' }
  } catch {
    return null
  }
}

type State = StatusState & {
  nudgedThisPrompt: boolean
  transcript: { id: string; path: string } | undefined
  isInteractive: boolean
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
    isOff: settingsFrom(await $.store.get(SETTINGS_KEY)).isOff,
    agentId: e.agentId,
    reason: e.reason,
    nested: Boolean(await $.env.get('STOP_JUDGE_NESTED')),
    nudgedThisPrompt: state.nudgedThisPrompt,
  }
  // The opening and the final message come from the transcript; these gates need neither.
  const early = guardOutcome({ ...gates, openingKind: 'none', opening: '', final: 'unread' })
  if (early) return record($, COMMAND, early, '')

  const { home } = await stateDirs($)
  const path = await transcriptPath($, state, home)
  if (path === undefined) return record($, COMMAND, 'pass-notext', 'transcript not found')
  const rows = parseRows(await transcriptTail($, path))
  const { final, opening, openingKind, prior } = splitTurn(rows, e.answer || undefined)
  const late = guardOutcome({ ...gates, openingKind, opening, final })
  if (late) return record($, COMMAND, late, '')

  const startedAt = await $.clock.now()
  const reply = await $.model.complete(judgeRequest(final, opening, framingAndPrior(prior), minutesFact(rows, new Date(startedAt))))
  const ms = (await $.clock.now()) - startedAt
  const decision = judgeOutcome(reply)
  if (decision.outcome !== 'continue') return record($, COMMAND, decision.outcome, decision.reason, ms)

  if ((await $.prompt.read()).text.trim() !== '') return record($, COMMAND, 'pass-typing', decision.reason, ms)
  state.nudgedThisPrompt = true
  try {
    await $.prompt.submit({ text: nudgeText(decision.reason), asUser: true })
  } catch (error) {
    state.nudgedThisPrompt = false
    throw error
  }
  await record($, COMMAND, 'continue', decision.reason, ms)
}

async function isContextOff($: EngineInterface, dir: string): Promise<boolean> {
  return dir !== '' && (await $.fs.exists(contextOffPath(dir)))
}

// The shell hook prints the file; the mod logs what it printed.
async function logContext($: EngineInterface): Promise<void> {
  try {
    const { dir } = await stateDirs($)
    if (dir === '' || (await isContextOff($, dir)) || !(await $.fs.exists(decisionsPath(dir)))) return
    const text = await $.fs.read(decisionsPath(dir))
    await record($, COMMAND, 'context', `chars=${rulesOnly(text).length}`)
  } catch {
    // the log is a convenience
  }
}

export const register: Register = on => {
  const state: State = { nudgedThisPrompt: false, transcript: undefined, isInteractive: false, derive: undefined, statusCalls: 0 }

  on('session.start', async ($, e, next) => {
    state.nudgedThisPrompt = false
    state.transcript = undefined
    state.isInteractive = e.isInteractive
    await showStatus($, state)
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
    const settings = settingsFrom(await $.store.get(SETTINGS_KEY))
    switch (action.kind) {
      case 'off':
      case 'on': {
        // Only the judge switch is stored; the context switch is the flag file alone.
        const isOff = action.kind === 'off'
        await $.store.set(SETTINGS_KEY, { isOff })
        await showStatus($, state)
        return { text: isOff ? 'judge off: stopped turns are not judged, in every session' : 'judge on: stopped turns are judged' }
      }
      case 'context-off':
      case 'context-on': {
        const isOff = action.kind === 'context-off'
        const { dir } = await stateDirs($)
        if (dir !== '') {
          if (isOff) await $.fs.write(contextOffPath(dir), '')
          else await $.process.run(['rm', '-f', contextOffPath(dir)])
        }
        return { text: isOff ? 'context off: new sessions start without DECISIONS.md' : 'context on: new sessions start with DECISIONS.md' }
      }
      case 'derive':
        return startDerive($, state, action.all)
      case 'usage':
        return { text: USAGE }
      case 'status': {
        // `context:` reports the flag file the SessionStart hook obeys, not a stored copy.
        const { dir } = await stateDirs($)
        const shown = { ...settings, isContextOff: await isContextOff($, dir) }
        return { text: statusText({ settings: shown, counts: await recentCounts($, dir), decisions: await decisionsInfo($, dir) }) }
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
      await record($, COMMAND, 'pass-error', error instanceof Error ? error.message : 'judge failed')
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
