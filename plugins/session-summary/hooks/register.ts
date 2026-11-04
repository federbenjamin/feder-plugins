import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import type { Source, SummaryStatus } from '../types'
import { addCall, firingReason, replyResult } from './call.ts'
import type { CallOutcome, Trigger } from './call.ts'
import { CONCISE_COMMAND, MESSAGE_CHARS, PLUGIN, QUEUED_MAX, SETTINGS_KEY, SUMMARY_REQUEST, TICK_MS, WINDOW_CHARS } from './config.ts'
import { absolutePath, capturedDocuments, fileCandidates, judgedDocuments, judgeablePaths, mergeDocuments } from './documents.ts'
import { linksOff, linksOn, syncShares } from './links-io.ts'
import { clearDocuments, openPane, readDocuments, readSummary, registerPane, writeDocuments, writeSummary } from './pane.tsx'
import { DEFAULT_VARIANT } from './prompts.ts'
import { settingsFrom, showText, summaryCommand, USAGE } from './settings.ts'
import { conciseResponse, endConcise, newConciseState, runConcise, startConcise } from './summarize.ts'
import type { Calls, Settings } from './settings.ts'
import { sessionLogPath } from './shared/firing.ts'
import { PRICES, usageUsd } from './shared/pricing.ts'
import { appendLine, record, stateDirs } from './shared/record.ts'
import { mainTurnEnded, mainTurnStarted, PERSON_ORIGINS } from './shared/events.ts'
import type { MainTurn } from './shared/events.ts'
import { buildRequest, captureLine, capturePath, EMPTY_SUMMARY, formatLog, formatMessages, isBumpTurn, isDue, keptLastPrompt, newestPrompt, seedDocuments, seedFromCapture, withQueued } from './summary.ts'
import type { Previous, Queued } from './summary.ts'

// Keeps short texts about this session (title, so far, now) and the list of its documents in a
// pane beside the chat. A haiku call writes the texts firstSeconds after a main turn starts, every
// everySeconds while it runs, and once more when a summarized turn ends. The same call judges which
// files join the list; the tick follows sent files and touches.
// Every call is logged and captured to the session's own file, which a resumed session seeds the
// pane from. Pure logic is in summary.ts, call.ts, documents.ts and links.ts.

type State = {
  isInteractive: boolean
  mainTurn: MainTurn | undefined // the running main turn, with when it started
  lastCallAt: number // when a tick last started a running call in this turn, ms; 0 before the first
  isTurnSummarized: boolean
  lastInput: string | undefined // the window of the last summary a call of this turn left in the pane
  turn: number // bumped at each main turn.start, so a call of an earlier turn never sets this turn's lastInput
  inFlight: Promise<unknown> | undefined
  claimedTurn: number | undefined // the turn whose running call a tick claimed, until that call is made or dropped
  controller: AbortController | undefined
  calls: Calls
  epoch: number // bumped at session.start and session.end, so a call that outlived its conversation writes nothing
  isPromptPending: boolean // the person sent a prompt: the next main model step summarizes it, however short the turn
  isFirstPending: boolean // a main turn started on an empty pane: its first model step makes the first-prompt call
  isTitleProvisional: boolean // the pane's title came from the first-prompt call, written before any work
  summarizedPrompt: string // the newest prompt the pane's LAST PROMPT sums up; '' until a call takes one
  queued: Queued[] // the person's prompts sent mid-turn, newest last
  isListStale: boolean // a main model step ended since the documents list last read the messages: only a step adds tool uses
  isRefreshing: boolean
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
    const text = await $.fs.read(path)
    const seeded = seedFromCapture(text)
    if (seeded !== null) await writeSummary($, () => seeded)
    // A resume leaves out a path with no file: an earlier version could list an example from a message.
    const cwd = await $.session.cwd()
    const seededDocs = seedDocuments(text)
    const present = await Promise.all(seededDocs.map(d => $.fs.exists(absolutePath(d.path, cwd))))
    await writeDocuments($, () => seededDocs.filter((_, i) => present[i]))
  } catch {
    // a session starts without its seed
  }
}

function reset(state: State): void {
  state.mainTurn = undefined
  state.lastCallAt = 0
  state.isTurnSummarized = false
  state.lastInput = undefined
  state.inFlight = undefined
  state.claimedTurn = undefined
  state.controller = undefined
  state.calls = noCalls()
  state.isPromptPending = false
  state.isFirstPending = false
  state.isTitleProvisional = false
  state.summarizedPrompt = ''
  state.queued = []
  state.isListStale = false
  state.epoch++
}

// The documents list and, with links on, its shares: no model call. The messages come from the
// summary call that holds them, or are read when a main step may have changed them; the shares are
// checked on every tick, since another session's write can change them. One at a time: what a
// skipped run would have read stays marked stale for the next tick.
async function refreshDocuments($: EngineInterface, state: State, given?: readonly SessionMessage[]): Promise<void> {
  if (state.isRefreshing) return
  state.isRefreshing = true
  const epoch = state.epoch
  const isCurrent = () => epoch === state.epoch
  try {
    if (given !== undefined || state.isListStale) {
      state.isListStale = false
      const messages = given ?? (await $.session.messages())
      const cwd = await $.session.cwd()
      const now = await $.clock.now()
      const home = (await $.env.get('HOME')) ?? ''
      await writeDocuments($, docs => (isCurrent() ? mergeDocuments(docs, messages, cwd, now, home) : docs))
    }
    if ((await settingsOf($)).linksBase !== '') await syncShares($, isCurrent)
  } catch {
    if (isCurrent()) state.isListStale = true
    await record($, PLUGIN, 'documents-failed', 'list or shares not updated')
  } finally {
    state.isRefreshing = false
  }
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
    const transcript = await $.session.messages()
    await refreshDocuments($, state, transcript)
    const messages = withQueued(transcript, state.queued)
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
    const previous: Previous = { title: stored.title, lastPrompt: stored.lastPrompt, soFar: stored.soFar, now: stored.now }
    const cwd = await $.session.cwd()
    const home = (await $.env.get('HOME')) ?? ''
    const listed = await readDocuments($)
    const candidates = await fileCandidates(transcript, { cwd, home, listed, exists: path => $.fs.exists(path).catch(() => false) })
    const judgeable = judgeablePaths(listed)
    const superseded = new Set(listed.filter(d => d.isSuperseded).map(d => d.path))
    if (!isCurrent()) return undefined
    const startedAt = await $.clock.now()
    const controller = new AbortController()
    state.controller = controller
    let reply
    try {
      reply = await $.model.complete({ ...SUMMARY_REQUEST, ...buildRequest({ variant, source, previous, newestPrompt: newest, input, status, isTitleProvisional: state.isTitleProvisional, candidates, superseded, judgeable }) }, { signal: controller.signal })
    } finally {
      if (state.controller === controller) state.controller = undefined
    }
    const endedAt = await $.clock.now()
    const ms = endedAt - startedAt
    const usage = reply.usage
    const usd = usageUsd(usage, PRICES.haiku)
    const replied = replyResult(reply, previous, { candidates, judgeable })
    const result = { ...replied, texts: { ...replied.texts, lastPrompt: keptLastPrompt({ newest, summarized: state.summarizedPrompt, previous: previous.lastPrompt, replied: replied.texts.lastPrompt }) } }
    // Every await can let session.end reset the state, so each write checks the epoch again
    // after it; the atom update re-runs its change on a version miss, so it checks there too.
    if (isCurrent() && result.isTaken) {
      const { title, lastPrompt, soFar, now } = result.texts
      await writeSummary($, s => (isCurrent() ? { title, lastPrompt, soFar, now, at: endedAt, status, source, variant } : s))
      if (isCurrent()) {
        state.isTitleProvisional = trigger === 'first'
        state.summarizedPrompt = newest
      }
      if (isCurrent() && result.verdict.add.length + result.verdict.superseded.length > 0) {
        await writeDocuments($, docs => (isCurrent() ? judgedDocuments(docs, result.verdict, { messages: transcript, cwd, home, now: endedAt }) : docs))
        // An added file gets its link now rather than at the next tick.
        if (result.verdict.add.length > 0) await refreshDocuments($, state)
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
        newestPrompt: newest,
        ...result.texts,
        files: capturedDocuments(await readDocuments($)),
        candidates,
        add: result.verdict.add,
        superseded: result.verdict.superseded,
        outcome: result.outcome,
        ms,
        usage,
        usd,
      })
      try {
        await appendLine($, capturePath(dir, id), line)
      } catch {
        // the capture is for reading back; the pane already has the texts
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
  if (status === 'running' && trigger !== 'manual' && (turn !== state.turn || state.mainTurn === undefined)) {
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
  if (!isDue({ now, turnStartedAt: state.mainTurn?.startedAt ?? 0, lastCallAt: state.lastCallAt, ...settings })) return
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
  return showText({ summary: await readSummary($), documents: (await readDocuments($)).map(d => d.path), settings, calls, capturePath: shown, now: await $.clock.now() })
}

export const register: Register = (on, options) => {
  registerPane(on, options)
  const concise = newConciseState()
  on('command.run', { command: CONCISE_COMMAND }, async ($, e) => runConcise($, concise, e.args))

  const state: State = {
    isInteractive: false,
    mainTurn: undefined,
    lastCallAt: 0,
    isTurnSummarized: false,
    lastInput: undefined,
    turn: 0,
    inFlight: undefined,
    claimedTurn: undefined,
    controller: undefined,
    calls: noCalls(),
    epoch: 0,
    isPromptPending: false,
    isFirstPending: false,
    isTitleProvisional: false,
    summarizedPrompt: '',
    queued: [],
    isListStale: false,
    isRefreshing: false,
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
      description: 'Open the session summary pane, or switch it on/off and set its cadence, input source, prompt and file links',
      argumentHint: '[on|off|first <s>|every <s>|source messages|session-log|variant <name>|links on|off|show|now]',
      immediate: true,
    })
    await startConcise($, concise, e.isInteractive)
    if (e.isInteractive) {
      await seed($)
      tick = $.clock.every(TICK_MS, () => {
        void onTick($, state)
        void refreshDocuments($, state)
        $.ui.invalidate('ui.render') // the pane's age
      })
      void openPane($)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId && !isBumpTurn(e.text)) {
      state.mainTurn = mainTurnStarted(state.mainTurn, e, await $.clock.now())
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
    if (!e.isMeta && !e.command && PERSON_ORIGINS.has(e.origin.kind)) state.isPromptPending = true
    if (e.turnId !== undefined && !e.isMeta && !e.command && PERSON_ORIGINS.has(e.origin.kind) && state.mainTurn !== undefined) {
      const after = (await $.session.messages()).length
      state.queued = [...state.queued, { text: e.text, after }].slice(-QUEUED_MAX)
    }
    return next(e)
  })

  // The first-prompt call: at the first model step the transcript holds the prompt. Its title is
  // provisional, so the turn's call at firstSeconds may replace it; the turn earns its ended call.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && (state.isFirstPending || state.isPromptPending)) {
      const trigger = state.isFirstPending ? 'first' : 'prompt'
      state.isFirstPending = false
      state.isPromptPending = false
      state.isTurnSummarized = true
      void summarize($, state, 'running', trigger)
    }
    const result = yield* next(e)
    if (!e.agentId) state.isListStale = true
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      const isSummarized = state.isTurnSummarized
      // A keepalive ping's turn was never the main turn, so it never counts as a response.
      const isResponse = state.mainTurn !== undefined && !e.isAborted && (e.answer ?? '').trim() !== ''
      state.mainTurn = mainTurnEnded(state.mainTurn, e)
      // A main complete under another id leaves the turn running here: its summary state is not
      // this completion's to touch.
      if (state.mainTurn !== undefined) {
        await record($, PLUGIN, 'turn-id-mismatch', `running=${state.mainTurn.turnId} completed=${e.turnId}`)
        return result
      }
      state.isTurnSummarized = false
      if (isSummarized) void summarize($, state, 'ended')
      if (isResponse) void conciseResponse($, concise)
    }
    return result
  })

  // A /clear ends the conversation and goes on under a new id with no session.start: the tick
  // keeps running (it reads the id fresh), and the pane empties.
  on('session.end', async ($, e, next) => {
    state.controller?.abort()
    reset(state)
    try {
      await writeSummary($, () => EMPTY_SUMMARY)
      await clearDocuments($)
    } catch {
      // the pane keeps the old texts until the next summary
    }
    await endConcise($, concise)
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
      case 'open': {
        const opened = await openPane($)
        return { text: opened.isPlaced ? 'pane open' : `pane open, not placed (${opened.reason})` }
      }
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
      case 'links-on': {
        const { text, base } = await linksOn($).catch((error: unknown) => ({ text: `cannot turn links on: ${error instanceof Error ? error.message : 'a step failed'}`, base: undefined }))
        if (base === undefined) return { text }
        await $.store.set(SETTINGS_KEY, { ...(await settingsOf($)), linksBase: base })
        if (state.isInteractive) {
          await refreshDocuments($, state)
          $.ui.invalidate('ui.render')
        }
        return { text }
      }
      // The stored base goes first: no session shares again while the shares file is being removed.
      case 'links-off': {
        await $.store.set(SETTINGS_KEY, { ...settings, linksBase: '' })
        const text = await linksOff($).catch((error: unknown) => `links off, with leftovers: ${error instanceof Error ? error.message : 'a step failed'}`)
        if (state.isInteractive) $.ui.invalidate('ui.render')
        return { text }
      }
      case 'show':
        return { text: await show($, settings, state.calls) }
      // One call now, with the session's real status, outside the timer: the turn's own calls
      // keep their schedule.
      case 'now': {
        if (!state.isInteractive) return { text: 'now: no call; summaries run in interactive sessions only' }
        const outcome = await summarize($, state, state.mainTurn !== undefined ? 'running' : 'ended', 'manual')
        return { text: `now: ${outcome ?? 'no call; the conversation reset'}\n${await show($, await settingsOf($), state.calls)}` }
      }
      case 'usage':
        return { text: USAGE }
    }
  })
}
