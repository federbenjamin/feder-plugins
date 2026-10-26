import type { EngineInterface, Register } from 'claude-code'
import type { Source, SummaryStatus } from '../types'
import { addCall, firingReason, replyResult } from './call.ts'
import type { CallOutcome, Trigger } from './call.ts'
import { CANDIDATE_MAX, MESSAGE_CHARS, PLUGIN, QUEUED_MAX, SETTINGS_KEY, SUMMARY_REQUEST, TICK_MS, WINDOW_CHARS } from './config.ts'
import { readSummary, registerBand, writeSummary } from './band.tsx'
import { DEFAULT_VARIANT } from './prompts.ts'
import { settingsFrom, showText, summaryCommand, USAGE } from './settings.ts'
import type { Calls, Settings } from './settings.ts'
import { sessionLogPath } from './shared/firing.ts'
import { PRICES, usageUsd } from './shared/pricing.ts'
import { appendLine, record, stateDirs } from './shared/record.ts'
import { PERSON_ORIGINS } from './shared/events.ts'
import { buildRequest, captureLine, capturePath, EMPTY_SUMMARY, fileCandidates, sentFiles, formatLog, formatMessages, isBumpTurn, isDue, keptLastPrompt, newestPrompt, seedFromCapture, withQueued } from './summary.ts'
import type { Previous, Queued } from './summary.ts'

// Keeps short texts about this session (title, so far, now, files to open) in a band above the
// chat. A haiku call writes them firstSeconds after a main turn starts, every everySeconds while
// it runs, and once more when a summarized turn ends. Every call is logged and captured to the
// session's own file, which a resumed session seeds the band from. Pure logic is in summary.ts
// and call.ts.

type State = {
  isInteractive: boolean
  turnStartedAt: number // when the running main turn started, ms; 0 when none runs
  lastCallAt: number // when a tick last started a running call in this turn, ms; 0 before the first
  isTurnSummarized: boolean
  lastInput: string | undefined // the window of the last summary a call of this turn left in the band
  turn: number // bumped at each main turn.start, so a call of an earlier turn never sets this turn's lastInput
  inFlight: Promise<unknown> | undefined
  claimedTurn: number | undefined // the turn whose running call a tick claimed, until that call is made or dropped
  controller: AbortController | undefined
  calls: Calls
  epoch: number // bumped at session.start and session.end, so a call that outlived its conversation writes nothing
  isFirstPending: boolean // a main turn started on an empty band: its first model step makes the first-prompt call
  isTitleProvisional: boolean // the band's title came from the first-prompt call, written before any work
  summarizedPrompt: string // the newest prompt the band's LAST PROMPT sums up; '' until a call takes one
  queued: Queued[] // the person's prompts sent mid-turn, newest last
}

const noCalls = (): Calls => ({ count: 0, input: 0, output: 0, cached: 0, usd: 0 })

async function settingsOf($: EngineInterface): Promise<Settings> {
  return settingsFrom(await $.store.get(SETTINGS_KEY))
}

async function seed($: EngineInterface): Promise<void> {
  try {
    const { dir } = await stateDirs($)
    if (dir === '') return
    const path = capturePath(dir, await $.session.id())
    if (!(await $.fs.exists(path))) return
    const seeded = seedFromCapture(await $.fs.read(path))
    if (seeded !== null) await writeSummary($, () => seeded)
  } catch {
    // a session starts without its seed
  }
}

function reset(state: State): void {
  state.turnStartedAt = 0
  state.lastCallAt = 0
  state.isTurnSummarized = false
  state.lastInput = undefined
  state.inFlight = undefined
  state.claimedTurn = undefined
  state.controller = undefined
  state.calls = noCalls()
  state.isFirstPending = false
  state.isTitleProvisional = false
  state.summarizedPrompt = ''
  state.queued = []
  state.epoch++
}

// What a summarize run came to: a call's outcome, a skip, or undefined when no call was made and
// nothing was logged (switched off, or the conversation reset under it).
type RunOutcome = CallOutcome | 'skip-same' | 'skip-inflight' | undefined

// A manual call (`/session-summary now`) runs while switched off and on an unchanged window.
async function call($: EngineInterface, state: State, status: SummaryStatus, epoch: number, turn: number, trigger: Trigger): Promise<RunOutcome> {
  const isCurrent = () => epoch === state.epoch
  const isManual = trigger === 'manual'
  let source: Source = 'messages'
  let variant = DEFAULT_VARIANT
  try {
    const id = await $.session.id()
    const { dir } = await stateDirs($)
    const settings = await settingsOf($)
    if (settings.isOff && !isManual) return undefined
    variant = settings.variant
    const messages = withQueued(await $.session.messages(), state.queued)
    const candidates = fileCandidates(messages, CANDIDATE_MAX)
    const sent = sentFiles(messages)
    const newest = newestPrompt(messages, MESSAGE_CHARS)
    let input: string | undefined
    if (settings.source === 'session-log') {
      const logFile = dir === '' ? '' : sessionLogPath(dir, id)
      if (logFile !== '' && (await $.fs.exists(logFile))) {
        input = formatLog(await $.fs.read(logFile), WINDOW_CHARS)
        source = 'session-log'
      } else {
        await record($, PLUGIN, 'log-missing', firingReason({ source: 'session-log', variant }))
      }
    }
    input ??= formatMessages(messages, { windowChars: WINDOW_CHARS, messageChars: MESSAGE_CHARS })
    if (!isCurrent()) return undefined
    // An ended call is never skipped: its status changes the request.
    if (status === 'running' && !isManual && input === state.lastInput) {
      await record($, PLUGIN, 'skip-same', firingReason({ source, variant }))
      return 'skip-same'
    }

    const stored = await readSummary($)
    const previous: Previous = { title: stored.title, lastPrompt: stored.lastPrompt, soFar: stored.soFar, now: stored.now, files: [...stored.files] }
    if (!isCurrent()) return undefined
    const startedAt = await $.clock.now()
    const controller = new AbortController()
    state.controller = controller
    let reply
    try {
      reply = await $.model.complete({ ...SUMMARY_REQUEST, ...buildRequest({ variant, source, previous, newestPrompt: newest, input, candidates, sent, status, isTitleProvisional: state.isTitleProvisional }) }, { signal: controller.signal })
    } finally {
      if (state.controller === controller) state.controller = undefined
    }
    const endedAt = await $.clock.now()
    const ms = endedAt - startedAt
    const usage = reply.usage
    const usd = usageUsd(usage, PRICES.haiku)
    const replied = replyResult(reply, previous, candidates)
    const result = { ...replied, texts: { ...replied.texts, lastPrompt: keptLastPrompt({ newest, summarized: state.summarizedPrompt, previous: previous.lastPrompt, replied: replied.texts.lastPrompt }) } }
    // Every await can let session.end reset the state, so each write checks the epoch again
    // after it; the atom update re-runs its change on a version miss, so it checks there too.
    if (isCurrent() && result.isTaken) {
      const { title, lastPrompt, soFar, now, files } = result.texts
      await writeSummary($, s => (isCurrent() ? { title, lastPrompt, soFar, now, files, at: endedAt, status, source, variant } : s))
      if (isCurrent()) {
        state.isTitleProvisional = trigger === 'first'
        state.summarizedPrompt = newest
      }
    }
    if (isCurrent()) {
      // Only a call of the running turn feeds skip-same: the turn before's running or ended call,
      // landing after this turn started and read its first message, leaves that window to be called.
      if (result.isTaken && turn === state.turn) state.lastInput = input
      state.calls = addCall(state.calls, usage, usd)
    }
    await record($, PLUGIN, result.outcome, firingReason({ source, variant, usage, usd, failure: result.failure, trigger }), ms)
    if (dir !== '') {
      const line = captureLine({
        at: new Date(endedAt).toISOString(),
        status,
        source,
        variant,
        previous,
        task: result.task,
        input,
        inputChars: input.length,
        candidates,
        newestPrompt: newest,
        ...result.texts,
        outcome: result.outcome,
        ms,
        usage,
        usd,
      })
      try {
        await appendLine($, capturePath(dir, id), line)
      } catch {
        // the capture is for reading back; the band already has the texts
      }
    }
    return result.outcome
  } catch (error) {
    await record($, PLUGIN, 'api-error', firingReason({ source, variant, failure: error instanceof Error ? error.message : 'summary failed', trigger }))
    return 'api-error'
  }
}

async function skipInflight($: EngineInterface, settings: Settings): Promise<void> {
  await record($, PLUGIN, 'skip-inflight', firingReason({ source: settings.source, variant: settings.variant }))
}

// One call at a time, and a call waits for the one in flight: the tick never starts a running call
// behind a call of its own turn, so a running call waits only for a call of an earlier turn (its
// running or ended call), and the new turn's first call still comes firstSeconds after it started.
// A manual call waits its turn too, and is made whatever happened to the turn meanwhile.
async function summarize($: EngineInterface, state: State, status: SummaryStatus, trigger: Trigger = 'timer'): Promise<RunOutcome> {
  const epoch = state.epoch
  const turn = state.turn
  while (state.inFlight !== undefined) await state.inFlight.catch(() => undefined)
  if (epoch !== state.epoch || !state.isInteractive) return undefined
  // A running call whose turn ended while it waited leaves that turn to its ended call.
  if (status === 'running' && trigger !== 'manual' && (turn !== state.turn || state.turnStartedAt === 0)) {
    await skipInflight($, await settingsOf($))
    return 'skip-inflight'
  }
  const run = call($, state, status, epoch, turn, trigger)
  state.inFlight = run
  try {
    return await run
  } finally {
    if (state.inFlight === run) state.inFlight = undefined
  }
}

// The tick that acts claims the running turn's call at once, before any await: the turn's next
// call is then due `everySeconds` later whatever this one does (skipped, failed, slow), the turn
// earns its ended call even while this one is still in flight, and a turn that starts meanwhile is
// not charged with it. The claim holds while the call waits behind an earlier turn's, so a stall
// there never queues a second call for the turn.
async function onTick($: EngineInterface, state: State): Promise<void> {
  const settings = await settingsOf($)
  const now = await $.clock.now()
  if (!isDue({ now, turnStartedAt: state.turnStartedAt, lastCallAt: state.lastCallAt, ...settings })) return
  const turn = state.turn
  if (state.claimedTurn === turn) {
    await skipInflight($, settings)
    return
  }
  state.claimedTurn = turn
  state.lastCallAt = now
  state.isTurnSummarized = true
  try {
    await summarize($, state, 'running')
  } finally {
    if (state.claimedTurn === turn) state.claimedTurn = undefined
  }
}

async function show($: EngineInterface, settings: Settings, calls: Calls): Promise<string> {
  const { dir } = await stateDirs($)
  const shown = dir === '' ? null : capturePath(dir, await $.session.id())
  return showText({ summary: await readSummary($), settings, calls, capturePath: shown, now: await $.clock.now() })
}

export const register: Register = (on, options) => {
  registerBand(on, options)

  const state: State = {
    isInteractive: false,
    turnStartedAt: 0,
    lastCallAt: 0,
    isTurnSummarized: false,
    lastInput: undefined,
    turn: 0,
    inFlight: undefined,
    claimedTurn: undefined,
    controller: undefined,
    calls: noCalls(),
    epoch: 0,
    isFirstPending: false,
    isTitleProvisional: false,
    summarizedPrompt: '',
    queued: [],
  }
  let tick: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    tick?.cancel()
    tick = undefined
    state.controller?.abort()
    reset(state)
    state.isInteractive = e.isInteractive
    // Registered before the interactive gate, as stop-judge does, so the command answers in a
    // `claude -p` run too.
    await $.command.register({
      name: PLUGIN,
      description: 'Show the session summary, or switch it on/off and set its cadence, input source and prompt',
      argumentHint: '[on|off|first <s>|every <s>|source messages|session-log|variant <name>|show|now]',
      immediate: true,
    })
    if (e.isInteractive) {
      await seed($)
      tick = $.clock.every(TICK_MS, () => {
        void onTick($, state)
      })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId && !isBumpTurn(e.text)) {
      state.turnStartedAt = await $.clock.now()
      state.lastCallAt = 0
      state.isTurnSummarized = false
      state.lastInput = undefined
      state.turn++
      state.isFirstPending = state.isInteractive && (await readSummary($)).at === 0
      // A prompt kept as mid-turn that waited for this turn instead is in the messages now.
      state.queued = state.queued.filter(q => q.text !== e.text)
    }
    return next(e)
  })

  // A prompt the person sends while a main turn runs reaches the model inside that turn, but not
  // $.session.messages(): keep it, with where it arrived, so the window shows it as theirs.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId !== undefined && !e.isMeta && !e.command && PERSON_ORIGINS.has(e.origin.kind) && state.turnStartedAt > 0) {
      const after = (await $.session.messages()).length
      state.queued = [...state.queued, { text: e.text, after }].slice(-QUEUED_MAX)
    }
    return next(e)
  })

  // The first-prompt call: at the first model step the transcript holds the prompt. Its title is
  // provisional, so the turn's call at firstSeconds may replace it; the turn earns its ended call.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && state.isFirstPending) {
      state.isFirstPending = false
      state.isTurnSummarized = true
      void summarize($, state, 'running', 'first')
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      const isSummarized = state.isTurnSummarized
      state.turnStartedAt = 0
      state.isTurnSummarized = false
      if (isSummarized) void summarize($, state, 'ended')
    }
    return result
  })

  // A /clear ends the conversation and goes on under a new id with no session.start: the tick
  // keeps running (it reads the id fresh), and the band empties.
  on('session.end', async ($, e, next) => {
    state.controller?.abort()
    reset(state)
    try {
      await writeSummary($, () => EMPTY_SUMMARY)
    } catch {
      // the band keeps the old texts until the next summary
    }
    return next(e)
  })

  on('command.run', { command: PLUGIN }, async ($, e) => {
    const action = summaryCommand(e.args)
    const settings = await settingsOf($)
    const save = async (next: Settings, text: string) => {
      await $.store.set(SETTINGS_KEY, next)
      return { text }
    }
    switch (action.kind) {
      case 'on':
      case 'off':
        return save({ ...settings, isOff: action.kind === 'off' }, action.kind === 'off' ? 'off: no summary calls, in every session' : 'on: summary calls resume, in every session')
      case 'first':
        return save({ ...settings, firstSeconds: action.seconds }, `first ${action.seconds}s after a turn starts`)
      case 'every':
        return save({ ...settings, everySeconds: action.seconds }, `every ${action.seconds}s after that`)
      case 'source':
        return save({ ...settings, source: action.source }, `source ${action.source}`)
      case 'variant':
        return save({ ...settings, variant: action.variant }, `variant ${action.variant}`)
      case 'show':
        return { text: await show($, settings, state.calls) }
      // One call now, with the session's real status, outside the timer: the turn's own calls
      // keep their schedule.
      case 'now': {
        if (!state.isInteractive) return { text: 'now: no call; summaries run in interactive sessions only' }
        const outcome = await summarize($, state, state.turnStartedAt > 0 ? 'running' : 'ended', 'manual')
        return { text: `now: ${outcome ?? 'no call; the conversation reset'}\n${await show($, await settingsOf($), state.calls)}` }
      }
      case 'usage':
        return { text: USAGE }
    }
  })
}
