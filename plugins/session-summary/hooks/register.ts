import type { EngineInterface, Register } from 'claude-code'
import type { Source, SummaryStatus } from '../types'
import { CANDIDATE_MAX, MESSAGE_CHARS, PANE_TITLE, PLUGIN, SETTINGS_KEY, SUMMARY_REQUEST, TICK_MS, WINDOW_CHARS } from './config.ts'
import { readSummary, registerPane, writeSummary } from './pane.tsx'
import { settingsFrom, showText, summaryCommand, USAGE } from './settings.ts'
import type { Calls, Settings } from './settings.ts'
import { sessionLogPath } from './shared/firing.ts'
import { PRICES, usageUsd } from './shared/pricing.ts'
import { appendLine, record, stateDirs } from './shared/record.ts'
import { buildRequest, captureLine, capturePath, EMPTY_SUMMARY, fileCandidates, formatLog, formatMessages, isBumpTurn, isDue, parseReply, seedFromCapture } from './summary.ts'
import type { Previous } from './summary.ts'

// Keeps three short texts about this session (so far, now, files to open) in a pane beside the
// chat. A haiku call writes them firstSeconds after a main turn starts, every everySeconds while
// it runs, and once more when a summarized turn ends. Every call is logged and captured to the
// session's own file, which a resumed session seeds the pane from. Pure logic is in summary.ts.

type State = {
  isInteractive: boolean
  turnStartedAt: number // when the running main turn started, ms; 0 when none runs
  lastCallAt: number
  isTurnSummarized: boolean
  lastInput: string | undefined
  inFlight: Promise<void> | undefined
  controller: AbortController | undefined
  calls: Calls
  epoch: number // bumped at session.start and session.end, so a call that outlived its conversation writes nothing
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
  state.controller = undefined
  state.calls = noCalls()
  state.epoch++
}

async function call($: EngineInterface, state: State, status: SummaryStatus, epoch: number): Promise<void> {
  const isCurrent = () => epoch === state.epoch
  try {
    const id = await $.session.id()
    const { dir } = await stateDirs($)
    const settings = await settingsOf($)
    if (settings.isOff) return
    const variant = settings.variant
    const messages = await $.session.messages()
    const candidates = fileCandidates(messages, CANDIDATE_MAX)
    let source: Source = 'messages'
    let input: string | undefined
    if (settings.source === 'session-log') {
      const logFile = dir === '' ? '' : sessionLogPath(dir, id)
      if (logFile !== '' && (await $.fs.exists(logFile))) {
        input = formatLog(await $.fs.read(logFile), WINDOW_CHARS)
        source = 'session-log'
      } else {
        await record($, PLUGIN, 'log-missing', 'source=session-log')
      }
    }
    input ??= formatMessages(messages, { windowChars: WINDOW_CHARS, messageChars: MESSAGE_CHARS })
    if (!isCurrent()) return
    // An ended call is never skipped: its status changes the request.
    if (status === 'running' && input === state.lastInput) {
      await record($, PLUGIN, 'skip-same', `source=${source} variant=${variant}`)
      return
    }

    const stored = await readSummary($)
    const previous: Previous = { soFar: stored.soFar, now: stored.now, files: [...stored.files] }
    if (!isCurrent()) return
    const startedAt = await $.clock.now()
    state.lastCallAt = startedAt
    if (status === 'running') state.isTurnSummarized = true
    const controller = new AbortController()
    state.controller = controller
    let reply
    try {
      reply = await $.model.complete({ ...SUMMARY_REQUEST, ...buildRequest({ variant, source, previous, input, candidates, status }) }, { signal: controller.signal })
    } finally {
      if (state.controller === controller) state.controller = undefined
    }
    const endedAt = await $.clock.now()
    const ms = endedAt - startedAt
    const usage = reply.usage
    const usd = usageUsd(usage, PRICES.haiku)

    let outcome: string
    let failure = ''
    let after: Previous = previous
    if (!reply.isAnswered) {
      outcome = reply.reason === 'aborted' ? 'aborted' : 'api-error'
      if (outcome === 'api-error') failure = ` ${reply.reason} ${'error' in reply ? reply.error : ''}`.trimEnd()
    } else {
      const parsed = parseReply(reply.text, previous, candidates, status)
      outcome = parsed.outcome
      after = parsed
      if (parsed.outcome !== 'parse-failed' && isCurrent()) {
        await writeSummary($, () => ({ soFar: parsed.soFar, now: parsed.now, files: parsed.files, at: endedAt, status, source, variant }))
      }
    }
    if (isCurrent()) {
      state.lastInput = input
      const c = state.calls
      state.calls = {
        count: c.count + 1,
        input: c.input + usage.input_tokens,
        output: c.output + usage.output_tokens,
        cached: c.cached + usage.cache_read_input_tokens,
        usd: c.usd + usd,
      }
    }
    const reason = `source=${source} variant=${variant} in=${usage.input_tokens} out=${usage.output_tokens} cached=${usage.cache_read_input_tokens} usd=${usd.toFixed(4)}${failure}`
    await record($, PLUGIN, outcome, reason, ms)
    if (dir !== '') {
      const line = captureLine({
        at: new Date(endedAt).toISOString(),
        status,
        source,
        variant,
        previous,
        input,
        inputChars: input.length,
        candidates,
        soFar: after.soFar,
        now: after.now,
        files: after.files,
        outcome,
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
  } catch (error) {
    await record($, PLUGIN, 'api-error', error instanceof Error ? error.message : 'summary failed')
  }
}

// One call at a time: a running call starts only when none is in flight (the tick checks); an
// ended call waits for the one in flight.
async function summarize($: EngineInterface, state: State, status: SummaryStatus): Promise<void> {
  const epoch = state.epoch
  if (status === 'ended') {
    while (state.inFlight !== undefined) await state.inFlight.catch(() => undefined)
  }
  if (epoch !== state.epoch || !state.isInteractive) return
  const run = call($, state, status, epoch)
  state.inFlight = run
  try {
    await run
  } finally {
    if (state.inFlight === run) state.inFlight = undefined
  }
}

async function onTick($: EngineInterface, state: State): Promise<void> {
  const settings = await settingsOf($)
  const now = await $.clock.now()
  if (!isDue({ now, turnStartedAt: state.turnStartedAt, lastCallAt: state.lastCallAt, ...settings })) return
  if (state.inFlight !== undefined) {
    await record($, PLUGIN, 'skip-inflight', `source=${settings.source} variant=${settings.variant}`)
    return
  }
  await summarize($, state, 'running')
}

export const register: Register = (on, options) => {
  registerPane(on, options)

  const state: State = {
    isInteractive: false,
    turnStartedAt: 0,
    lastCallAt: 0,
    isTurnSummarized: false,
    lastInput: undefined,
    inFlight: undefined,
    controller: undefined,
    calls: noCalls(),
    epoch: 0,
  }
  let tick: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    tick?.cancel()
    tick = undefined
    state.controller?.abort()
    reset(state)
    state.isInteractive = e.isInteractive
    // A refused registration (another install of this plugin holds the name) stops the rest, so
    // two installs never both summarize.
    await $.command.register({
      name: PLUGIN,
      description: 'Open the session summary pane, or switch it on/off and set its cadence, input source and prompt',
      argumentHint: '[on|off|first <s>|every <s>|source messages|session-log|variant <name>|show]',
      immediate: true,
    })
    if (e.isInteractive) {
      await seed($)
      tick = $.clock.every(TICK_MS, () => {
        void onTick($, state)
      })
      void $.ui.open({ id: PLUGIN, title: PANE_TITLE })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId && !isBumpTurn(e.text)) {
      state.turnStartedAt = await $.clock.now()
      state.isTurnSummarized = false
    }
    return next(e)
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
  // keeps running (it reads the id fresh), and the pane starts empty.
  on('session.end', async ($, e, next) => {
    state.controller?.abort()
    reset(state)
    try {
      await writeSummary($, () => EMPTY_SUMMARY)
    } catch {
      // the pane keeps the old texts until the next summary
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
      case 'open': {
        const opened = await $.ui.open({ id: PLUGIN, title: PANE_TITLE })
        return { text: opened.isPlaced ? 'session-summary: pane open' : `session-summary: pane open, not placed (${opened.reason})` }
      }
      case 'on':
      case 'off':
        return save({ ...settings, isOff: action.kind === 'off' }, action.kind === 'off' ? 'session-summary off: no summary calls, in every session' : 'session-summary on')
      case 'first':
        return save({ ...settings, firstSeconds: action.seconds }, `session-summary: first ${action.seconds}s after a turn starts`)
      case 'every':
        return save({ ...settings, everySeconds: action.seconds }, `session-summary: every ${action.seconds}s after that`)
      case 'source':
        return save({ ...settings, source: action.source }, `session-summary: source ${action.source}`)
      case 'variant':
        return save({ ...settings, variant: action.variant }, `session-summary: variant ${action.variant}`)
      case 'show': {
        const { dir } = await stateDirs($)
        const shown = dir === '' ? null : capturePath(dir, await $.session.id())
        return { text: showText({ summary: await readSummary($), settings, calls: state.calls, capturePath: shown, now: await $.clock.now() }) }
      }
      case 'usage':
        return { text: USAGE }
    }
  })
}
