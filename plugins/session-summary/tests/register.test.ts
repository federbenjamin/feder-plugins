import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult, On, SessionMessage } from 'claude-code'
import type { Summary } from '../types'
import { PLUGIN } from '../hooks/config'
import { VARIANTS } from '../hooks/prompts'
import { capturePath, paneLines } from '../hooks/summary'

const T0 = Date.parse('2026-10-23T12:00:00Z')
const DIR = '/tmp/state'
const ID = 'synthetic-session'
const CAPTURE = capturePath(DIR, ID)
const LOG = `${DIR}/logs/${PLUGIN}.log`
const PLAN = 'notes/plan.md'

const USAGE = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answer = (soFar: string, now: string, files = PLAN): ModelCompleteResult => ({ isAnswered: true, text: `SO FAR: ${soFar}\nNOW: ${now}\nFILES: ${files}`, usage: USAGE })
const ANSWER = answer('Building the summary plugin.', 'Writing its plan.')
const FAILURES: { outcome: string; reply: ModelCompleteResult }[] = [
  { outcome: 'api-error', reply: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO } },
  { outcome: 'aborted', reply: { isAnswered: false, reason: 'aborted', usage: ZERO } },
  { outcome: 'parse-failed', reply: { isAnswered: true, text: 'I am not sure what this session is doing.', usage: USAGE } },
]

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const wrote = (path: string): SessionMessage => ({ role: 'assistant', text: 'Writing it down.', toolUses: [{ tool_use_id: `w-${path}`, tool: 'Write', input: { file_path: path } }] })

const PANE = { title: 'Session', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} }

function world(on: On, options: { capture?: string; settings?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { STOPSTOPPING_DIR: DIR })
  mock.store(on, options.settings ? { settings: options.settings } : {})
  const w = {
    clock,
    files: new Map<string, string>(options.capture ? [[CAPTURE, options.capture]] : []),
    messages: [user('build the summary plugin'), wrote(PLAN)],
    replies: [] as ModelCompleteResult[],
    modelHoldMs: 0,
    isAbortIgnored: false, // a reply already on its way when the call is aborted
    messagesHoldMs: 0,
    messagesError: '',
    requests: [] as ModelCompleteRequest[],
    commands: [] as string[],
    opened: [] as string[],
    reads: [] as string[],
  }
  on('fs.exists', async (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', async (_$, e) => {
    w.reads.push(e.path)
    return { value: w.files.get(e.path) ?? '' }
  })
  on('fs.write', async (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    if (e.argv[0] !== 'tee' || e.argv[1] !== '-a') throw new Error('unexpected process command')
    const path = e.argv[2]!
    w.files.set(path, (w.files.get(path) ?? '') + (e.init?.stdin ?? ''))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', async () => ({ value: ID }))
  on('session.messages', async () => {
    const hold = w.messagesHoldMs
    w.messagesHoldMs = 0
    if (hold > 0) await clock.sleep(hold)
    const error = w.messagesError
    w.messagesError = ''
    if (error !== '') return { deny: error }
    return { value: [...w.messages] }
  })
  // A held reply waits on the call's own signal as the engine's does: aborted, it resolves aborted.
  on('model.complete', async ($, e, next) => {
    w.requests.push(e)
    const hold = w.modelHoldMs
    w.modelHoldMs = 0
    if (hold > 0 && w.isAbortIgnored) await clock.sleep(hold)
    else if (hold > 0) {
      try {
        await $.clock.sleep(hold, { signal: next.signal })
      } catch {
        return { value: { isAnswered: false, reason: 'aborted', usage: ZERO } }
      }
    }
    return { value: w.replies.shift() ?? ANSWER }
  })
  on('command.register', async (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', async (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  return w
}

type World = ReturnType<typeof world>

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/tmp/project', surface: isInteractive ? 'terminal' : null, isInteractive })
const turnStart = ($: Engine, text = 'build the summary plugin', agentId?: string) => $.turn.start({ text, turnId: 't1', ...(agentId ? { agentId } : {}) })
const run = ($: Engine, args: string) => $.command.run({ command: PLUGIN, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const complete = ($: Engine) => $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
const logLines = (w: World) => (w.files.get(LOG) ?? '').split('\n').filter(Boolean)
const outcomes = (w: World) => logLines(w).map(l => l.split(' ')[1])
const captures = (w: World) =>
  (w.files.get(CAPTURE) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
const statuses = (w: World) => w.requests.map(r => /^Status: (\w+)/.exec(String(r.prompt))?.[1])
const paneTexts = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts
}

const summary = (changes: Partial<Summary> = {}): Summary => ({
  soFar: 'Build the summary plugin',
  now: 'Pin its lifecycle contract',
  files: ['plugins/session-summary/hooks/register.ts'],
  at: T0 - 2 * 60_000,
  status: 'running',
  source: 'messages',
  variant: 'edit',
  ...changes,
})

test('the pane keeps labels and freshness dim while leaving summary content readable', async () => {
  expect(paneLines(summary(), T0)).toEqual([
    { text: 'So far', dim: true },
    { text: 'Build the summary plugin', dim: false },
    { text: 'Now', dim: true },
    { text: 'Pin its lifecycle contract', dim: false },
    { text: 'plugins/session-summary/hooks/register.ts', dim: true },
    { text: 'updated 2 min ago · messages · edit', dim: true },
  ])
})

test('an empty summary says so instead of rendering blank pane rows', async () => {
  expect(paneLines(summary({ soFar: '', now: '', files: [], at: 0 }), T0)).toEqual([
    { text: 'So far', dim: true },
    { text: '(none yet)', dim: false },
    { text: 'Now', dim: true },
    { text: '(none yet)', dim: false },
    { text: 'no summary yet', dim: true },
  ])
})

test('a non-interactive session registers /session-summary but opens no pane and makes no call', async ($, on) => {
  const w = world(on)
  await start($, false)
  expect(w.commands).toEqual([PLUGIN])
  expect(w.opened).toEqual([])
  await turnStart($)
  await w.clock.advance(120_000)
  expect(w.requests).toEqual([])
  expect(w.files.has(CAPTURE)).toBe(false)
})

test('an interactive session restores its synthetic capture into the Session pane', async ($, on) => {
  const capture = `${JSON.stringify({ at: '2026-10-23T11:58:00.000Z', soFar: 'Earlier work', now: 'Resume it', files: [PLAN], status: 'running', source: 'messages', variant: 'edit' })}\n`
  const w = world(on, { capture })
  await start($)
  expect(w.reads).toEqual([CAPTURE])
  expect(w.commands).toEqual([PLUGIN])
  expect(w.opened).toEqual([PLUGIN])
  expect(await paneTexts($)).toEqual(['So far', 'Earlier work', 'Now', 'Resume it', PLAN, 'updated 2 min ago · messages · edit'])
})

test('a main turn gets its first summary 90 s in: one request, one firing line, one capture line, the pane filled', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(60_000)
  expect(w.requests).toEqual([])

  await w.clock.advance(30_000)
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]).toMatchObject({ model: 'haiku', system: VARIANTS.edit, maxTokens: 300, effort: 'low', timeoutMs: 20_000 })
  expect(String(w.requests[0]!.prompt)).toContain('Status: running')
  expect(String(w.requests[0]!.prompt)).toContain(`Candidate files (newest last):\n- ${PLAN}`)
  expect(logLines(w)).toHaveLength(1)
  expect(logLines(w)[0]).toMatch(/^\S+ summary session=synthetic-session ms=\d+ reason=source=messages variant=edit in=1200 out=80 cached=300 usd=\d+\.\d{4}$/)
  expect(captures(w)).toEqual([
    expect.objectContaining({ status: 'running', source: 'messages', variant: 'edit', outcome: 'summary', soFar: 'Building the summary plugin.', now: 'Writing its plan.', files: [PLAN], candidates: [PLAN] }),
  ])
  expect(await paneTexts($)).toEqual(['So far', 'Building the summary plugin.', 'Now', 'Writing its plan.', PLAN, 'updated 0 min ago · messages · edit'])
})

test('a running turn is summarized again 600 s later, and once more with status ended when it completes', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  w.messages.push(user('<task-notification> the check finished'))
  await w.clock.advance(570_000)
  expect(w.requests).toHaveLength(1)
  await w.clock.advance(30_000)
  expect(statuses(w)).toEqual(['running', 'running'])

  await complete($)
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running', 'running', 'ended'])
  expect(captures(w).map(c => c.status)).toEqual(['running', 'running', 'ended'])
})

test('a turn that ends before its first due tick makes no call', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(60_000)
  await complete($)
  await w.clock.advance(1_200_000)
  expect(w.requests).toEqual([])
  expect(logLines(w)).toEqual([])
})

test('a keepalive bump turn and a subagent turn arm nothing', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($, 'keepalive ping. Reply only: ok')
  await w.clock.advance(120_000)
  await turnStart($, 'look into the parser', 'agent-1')
  await w.clock.advance(120_000)
  expect(w.requests).toEqual([])
})

test('switched off, a running turn makes no call', async ($, on) => {
  const w = world(on, { settings: { isOff: true } })
  await start($)
  await turnStart($)
  await w.clock.advance(700_000)
  await complete($)
  await w.clock.settle()
  expect(w.requests).toEqual([])
  expect(logLines(w)).toEqual([])
})

test('source session-log with no log file logs log-missing and reads the messages', async ($, on) => {
  const w = world(on, { settings: { source: 'session-log' } })
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  expect(outcomes(w)).toEqual(['log-missing', 'summary'])
  expect(logLines(w)[0]).toMatch(/ reason=source=session-log variant=edit in=0 out=0 cached=0 usd=0\.0000$/)
  expect(logLines(w)[1]).toContain(' reason=source=messages variant=edit ')
  expect(String(w.requests[0]!.prompt)).toContain('Recent activity (oldest first, may start mid-way):\nUSER: build the summary plugin')
})

test('a tick due while a call is still unanswered logs skip-inflight', async ($, on) => {
  const w = world(on, { settings: { everySeconds: 30 } })
  await start($)
  await turnStart($)
  w.messagesHoldMs = 45_000
  await w.clock.advance(90_000)
  await w.clock.advance(30_000)
  expect(outcomes(w)).toEqual(['skip-inflight'])
  expect(logLines(w)[0]).toMatch(/ reason=source=messages variant=edit in=0 out=0 cached=0 usd=0\.0000$/)
  await w.clock.advance(15_000)
  expect(outcomes(w)).toEqual(['skip-inflight', 'summary'])
  expect(w.requests).toHaveLength(1)
})

test('an unchanged window is skipped once per every period, not on every tick', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  await w.clock.advance(600_000)
  expect(outcomes(w)).toEqual(['summary', 'skip-same'])
  expect(logLines(w)[1]).toMatch(/ reason=source=messages variant=edit in=0 out=0 cached=0 usd=0\.0000$/)
  await w.clock.advance(570_000)
  expect(outcomes(w)).toEqual(['summary', 'skip-same'])
  await w.clock.advance(30_000)
  expect(outcomes(w)).toEqual(['summary', 'skip-same', 'skip-same'])
  expect(w.requests).toHaveLength(1)
})

for (const failure of FAILURES) {
  test(`after a call that ends ${failure.outcome}, the unchanged window is called again at the every cadence`, async ($, on) => {
    const w = world(on)
    w.replies.push(failure.reply)
    await start($)
    await turnStart($)
    await w.clock.advance(90_000)
    expect(outcomes(w)).toEqual([failure.outcome])
    await w.clock.advance(570_000)
    expect(w.requests).toHaveLength(1)
    await w.clock.advance(30_000)
    expect(outcomes(w)).toEqual([failure.outcome, 'summary'])
    expect(w.requests).toHaveLength(2)
    expect(w.requests[1]!.prompt).toBe(w.requests[0]!.prompt)
  })
}

test('the ended call of a turn, starting after the next turn started, leaves that turn its first summary at firstSeconds', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(100_000)
  w.messagesHoldMs = 5_000
  await complete($)
  w.messages.push(user('STOP JUDGE — open the PR yourself.'))
  await turnStart($, 'STOP JUDGE — open the PR yourself.')
  await w.clock.advance(5_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  w.messages.push(wrote('notes/report.md'))
  await w.clock.advance(75_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  await w.clock.advance(30_000)
  expect(statuses(w)).toEqual(['running', 'ended', 'running'])
})

test('a running call still in flight when its turn ends earns the ended call, and the next turn still gets its first summary at firstSeconds', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  w.modelHoldMs = 20_000
  await w.clock.advance(90_000)
  await w.clock.advance(10_000)
  await complete($)
  w.messages.push(user('STOP JUDGE — open the PR yourself.'))
  await turnStart($, 'STOP JUDGE — open the PR yourself.')
  await w.clock.advance(10_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  w.messages.push(wrote('notes/report.md'))
  await w.clock.advance(70_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  await w.clock.advance(30_000)
  expect(statuses(w)).toEqual(['running', 'ended', 'running'])
})

test('a turn that starts in the same millisecond its predecessor was summarized and ended is first summarized at firstSeconds', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  await complete($)
  w.messages.push(user('STOP JUDGE — open the PR yourself.'))
  await turnStart($, 'STOP JUDGE — open the PR yourself.')
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running', 'ended'])
  w.messages.push(wrote('notes/report.md'))
  await w.clock.advance(60_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  await w.clock.advance(30_000)
  expect(statuses(w)).toEqual(['running', 'ended', 'running'])
})

test('a call that throws logs api-error with the same leading fields as a call', async ($, on) => {
  const w = world(on)
  w.messagesError = 'messages unavailable'
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  expect(logLines(w)).toEqual([expect.stringMatching(/ api-error session=synthetic-session ms=0 reason=source=messages variant=edit in=0 out=0 cached=0 usd=0\.0000 .*messages unavailable$/)])
  expect(w.requests).toEqual([])
})

test('session.end aborts the call in flight and empties the pane', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  expect((await paneTexts($))[1]).toBe('Building the summary plugin.')

  w.messages.push(wrote('notes/report.md'))
  w.replies.push(answer('Too late.', 'Too late.'))
  w.modelHoldMs = 15_000
  await w.clock.advance(600_000)
  expect(w.requests).toHaveLength(2)
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  await w.clock.settle()
  expect(outcomes(w)).toEqual(['summary', 'aborted'])
  await w.clock.advance(15_000)
  expect(outcomes(w)).toEqual(['summary', 'aborted'])
  expect(await paneTexts($)).toEqual(['So far', '(none yet)', 'Now', '(none yet)', 'no summary yet'])
})

test('a reply that lands after session.end writes nothing to the next conversation', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  w.replies.push(answer('Too late.', 'Too late.'))
  w.modelHoldMs = 15_000
  w.isAbortIgnored = true
  await w.clock.advance(90_000)
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  await w.clock.advance(15_000)
  expect(outcomes(w)).toEqual(['summary'])
  expect(await paneTexts($)).toEqual(['So far', '(none yet)', 'Now', '(none yet)', 'no summary yet'])
  expect((await run($, 'show')).text).toContain('this session: 0 calls')
})

test('switched off mid-turn, a summarized turn makes no ended call', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  expect((await run($, 'off')).text).toBe('session-summary off: no summary calls, in every session')
  await complete($)
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running'])
  expect((await run($, 'show')).text).toContain('this session: 1 calls · in 1200 · out 80 · cached 300')
})
