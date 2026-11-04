import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult, On, SessionMessage } from 'claude-code'
import type { Summary } from '../types'
import { PLUGIN, RECENT_FILE_MS } from '../hooks/config'
import { VARIANTS } from '../hooks/prompts'
import { sessionLogPath } from '../hooks/shared/firing'
import { fileHref, fileLabel } from '../hooks/documents'
import { ageText, capturePath, paneView } from '../hooks/summary'

const T0 = Date.parse('2026-10-23T12:00:00Z')
const DIR = '/tmp/state'
const ID = 'synthetic-session'
const CAPTURE = capturePath(DIR, ID)
const LOG = `${DIR}/logs/${PLUGIN}.log`
const PLAN = 'notes/plan.md'
// A Text holding a Link reads back as the link's address, then its label.
const LINKED_PLAN = `file:///tmp/project/${PLAN}./${PLAN}`
const PLAN_PATH = `/tmp/project/${PLAN}`

const USAGE = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answer = (soFar: string, now: string): ModelCompleteResult => ({ isAnswered: true, text: `TITLE: Summary plugin\nLAST PROMPT: You asked for the plugin.\nSO FAR: ${soFar}\nNOW: ${now}`, usage: USAGE })
const ANSWER = answer('Building the summary plugin.', 'Writing its plan.')
const judged = (lines: string): ModelCompleteResult => ({ isAnswered: true, text: `TITLE: Summary plugin\nLAST PROMPT: You asked for the plugin.\nSO FAR: Building the summary plugin.\nNOW: Writing its plan.\n${lines}`, usage: USAGE })
const FAILURES: { outcome: string; reply: ModelCompleteResult }[] = [
  { outcome: 'api-error', reply: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO } },
  { outcome: 'aborted', reply: { isAnswered: false, reason: 'aborted', usage: ZERO } },
  { outcome: 'parse-failed', reply: { isAnswered: true, text: 'I am not sure what this session is doing.', usage: USAGE } },
]

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const wrote = (path: string): SessionMessage => ({ role: 'assistant', text: 'Writing it down.', toolUses: [{ tool_use_id: `w-${path}`, tool: 'Write', input: { file_path: path } }] })

const PANE = { title: 'Session summary', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

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
    completeHoldMs: 0, // holds the next turn.complete that long before it returns
    writeHoldMs: 0, // holds the next write of the summary that long before it lands
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
  on('session.cwd', async () => ({ value: '/tmp/project' }))
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
  on('state.set', async (_$, e, next) => {
    if (e.key !== 'summary') return next(e)
    const hold = w.writeHoldMs
    w.writeHoldMs = 0
    if (hold > 0) await clock.sleep(hold)
    return next(e)
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
  on('turn.complete', async (_$, e) => {
    const hold = w.completeHoldMs
    w.completeHoldMs = 0
    if (hold > 0) await clock.sleep(hold)
    return { text: e.answer }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return w
}

type World = ReturnType<typeof world>

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/tmp/project', surface: isInteractive ? 'terminal' : null, isInteractive })
const turnStart = ($: Engine, text = 'build the summary plugin', agentId?: string) => $.turn.start({ text, turnId: 't1', ...(agentId ? { agentId } : {}) })
const run = ($: Engine, args: string) => $.command.run({ command: PLUGIN, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const step = async ($: Engine, agentId?: string) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })) {
    // drain
  }
}
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
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => !/^[─█│•]+$/.test(t))
  await ui.unmount()
  return texts
}

const summary = (changes: Partial<Summary> = {}): Summary => ({
  title: 'Summary plugin',
  lastPrompt: '',
  soFar: 'Build the summary plugin',
  now: 'Pin its lifecycle contract',
  at: T0 - 2 * 60_000,
  status: 'running',
  source: 'messages',
  variant: 'edit',
  ...changes,
})

test('the pane view carries the status and the age, and is null before the first summary', async () => {
  expect(paneView(summary(), T0)).toMatchObject({ title: 'Summary plugin', isRunning: true, age: '2m ago', now: 'Pin its lifecycle contract' })
  expect(paneView(summary({ status: 'ended' }), T0)!.isRunning).toBe(false)
  expect(paneView(summary({ soFar: '', now: '', at: 0 }), T0)).toBe(null)
})

test('the age reads just now, then minutes, then hours', async () => {
  expect([ageText(59_000), ageText(60_000), ageText(3_599_000), ageText(3_600_000)]).toEqual(['just now', '1m ago', '59m ago', '1h ago'])
  expect(fileLabel('notes/plan.md', '/repo/')).toBe('./notes/plan.md')
  expect(fileLabel('/repo/hooks/a b.ts', '/repo')).toBe('./hooks/a b.ts')
  expect(fileLabel('/other/deep/dir/c.md', '/repo')).toBe('…/dir/c.md')
  expect(fileHref('/repo/hooks/a b.ts')).toBe('file:///repo/hooks/a%20b.ts')
})

test('a non-interactive session registers /session-summary and makes no call', async ($, on) => {
  const w = world(on)
  await start($, false)
  expect(w.commands).toEqual([PLUGIN])
  expect(w.opened).toEqual([])
  await turnStart($)
  await w.clock.advance(120_000)
  expect(w.requests).toEqual([])
  expect(w.files.has(CAPTURE)).toBe(false)
})

test('an interactive session opens the pane, which says so while it has no summary, and bare /session-summary opens it again', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.opened).toEqual([PLUGIN])
  expect(await paneTexts($)).toEqual(['No summary yet.'])
  expect((await run($, '')).text).toBe('pane open')
  expect(w.opened).toEqual([PLUGIN, PLUGIN])
})

test('an interactive session restores its synthetic capture into the pane', async ($, on) => {
  const capture = `${JSON.stringify({ at: '2026-10-23T11:58:00.000Z', soFar: 'Earlier work', now: 'Resume it', files: [PLAN], status: 'running', source: 'messages', variant: 'edit' })}\n`
  const w = world(on, { capture })
  await start($)
  expect(w.reads).toEqual([CAPTURE])
  expect(w.commands).toEqual([PLUGIN])
  expect(await paneTexts($)).toEqual(['● NOW', '2m ago', 'Resume it', 'SO FAR', 'Earlier work', 'FILES', LINKED_PLAN])
})

test('a main turn gets its first summary 90 s in: one request, one firing line, one capture line, the pane filled', async ($, on) => {
  const w = world(on)
  w.files.set(PLAN_PATH, '')
  w.replies.push(judged(`ADD: ${PLAN_PATH}\nSUPERSEDED: none`))
  await start($)
  await turnStart($)
  await w.clock.advance(60_000)
  expect(w.requests).toEqual([])

  await w.clock.advance(30_000)
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]).toMatchObject({ model: 'haiku', system: VARIANTS.edit, maxTokens: 500, effort: 'low', timeoutMs: 20_000 })
  expect(String(w.requests[0]!.prompt)).toContain('Status: running')
  expect(logLines(w)).toHaveLength(1)
  expect(logLines(w)[0]).toMatch(/^\S+ summary session=synthetic-session ms=\d+ reason=source=messages variant=edit in=1200 out=80 cached=300 usd=\d+\.\d{4}$/)
  expect(captures(w)).toEqual([
    expect.objectContaining({ status: 'running', source: 'messages', variant: 'edit', task: null, outcome: 'summary', soFar: 'Building the summary plugin.', now: 'Writing its plan.', candidates: [PLAN_PATH], add: [PLAN_PATH], superseded: [], files: [{ path: PLAN_PATH, touchedAt: T0 + 90_000, touches: 1 }] }),
  ])
  expect(await paneTexts($)).toEqual(['Summary plugin', '● NOW', 'just now', 'Writing its plan.', 'SO FAR', 'Building the summary plugin.', 'YOU ASKED', 'You asked for the plugin.', 'FILES', LINKED_PLAN])
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

test("a main turn that completes under another id than the running one's logs turn-id-mismatch; a subagent's, its own or an idle complete logs nothing", async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await $.turn.complete({ turnId: 'a1', agentId: 'agent-1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  await complete($)
  await complete($)
  await w.clock.settle()
  expect(logLines(w)).toEqual(['2026-10-23T12:00:00Z turn-id-mismatch session=synthetic-session ms=0 reason=running=t1 completed=t2'])
})

test("a stale completion that resumes after the replacement turn earned its summary leaves that turn's summary state alone and makes no ended call", async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  w.completeHoldMs = 100_000
  const stale = complete($)
  await $.turn.start({ text: 'and now the tests', turnId: 't2' })
  await w.clock.advance(90_000)
  expect(statuses(w)).toEqual(['running', 'running'])
  await w.clock.advance(10_000)
  await stale
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running', 'running'])
  expect(outcomes(w)).toEqual(['summary', 'summary', 'turn-id-mismatch'])
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running', 'running', 'ended'])
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
  w.replies.push(answer('Turn A so far.', 'Turn A now.'), answer('Turn A done.', 'Waiting on the person.'))
  await start($)
  await turnStart($)
  await w.clock.advance(100_000)
  w.messagesHoldMs = 5_000
  await complete($)
  w.messages.push(user('STOP JUDGE — open the PR yourself.'))
  await turnStart($, 'STOP JUDGE — open the PR yourself.')
  await w.clock.advance(5_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  expect((await paneTexts($)).slice(0, 7)).toEqual(['Summary plugin', '○ NOW', 'just now', 'Waiting on the person.', 'SO FAR', 'Turn A done.', 'YOU ASKED'])
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

const NUDGE = 'STOP JUDGE — open the PR yourself.'

test('an ended call that reads the next turn\'s nudge leaves that turn\'s unchanged window to its own first summary at firstSeconds', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  w.messagesHoldMs = 5_000
  await complete($)
  w.messages.push(user(NUDGE))
  await turnStart($, NUDGE)
  await w.clock.advance(5_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  await w.clock.advance(60_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  await w.clock.advance(30_000)
  expect(outcomes(w)).toEqual(['summary', 'summary', 'summary'])
  expect(statuses(w)).toEqual(['running', 'ended', 'running'])
  expect(String(w.requests[2]!.prompt)).toContain(`NOTE: ${NUDGE}`)
})

test('a running call that reads the next turn\'s nudge after its own turn ended leaves that turn\'s unchanged window to its own first summary at firstSeconds', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  w.messagesHoldMs = 40_000
  await w.clock.advance(90_000)
  await w.clock.advance(30_000)
  await complete($)
  w.messages.push(user(NUDGE))
  await turnStart($, NUDGE)
  await w.clock.advance(10_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  expect(String(w.requests[0]!.prompt)).toContain(`NOTE: ${NUDGE}`)
  await w.clock.advance(70_000)
  expect(statuses(w)).toEqual(['running', 'ended'])
  await w.clock.advance(10_000)
  expect(outcomes(w)).toEqual(['summary', 'summary', 'summary'])
  expect(statuses(w)).toEqual(['running', 'ended', 'running'])
})

// The turn before's call is still in flight at this turn's first deadline when firstSeconds is
// short or a read before the model call is slow (held here on session.messages).
test('a turn whose predecessor\'s ended call is still in flight at its firstSeconds deadline is summarized as soon as that call lands', async ($, on) => {
  const w = world(on, { settings: { firstSeconds: 10 } })
  await start($)
  await turnStart($)
  await w.clock.advance(30_000)
  await w.clock.advance(20_000)
  w.messagesHoldMs = 15_000
  await complete($)
  w.messages.push(user(NUDGE))
  await turnStart($, NUDGE)
  await w.clock.advance(10_000)
  expect(statuses(w)).toEqual(['running'])
  expect(outcomes(w)).toEqual(['summary'])
  await w.clock.advance(5_000)
  expect(statuses(w)).toEqual(['running', 'ended', 'running'])
  expect(outcomes(w)).toEqual(['summary', 'summary', 'summary'])
})

test('a turn whose predecessor\'s running call is still in flight at its firstSeconds deadline is summarized after that call and its ended call, and keeps its own summary in the pane', async ($, on) => {
  const w = world(on, { settings: { firstSeconds: 10 } })
  w.replies.push(answer('Turn A so far.', 'Turn A now.'), answer('Turn A done.', 'Waiting on the person.'), answer('Opening the PR.', 'Pushing the branch.'))
  await start($)
  await turnStart($)
  w.messagesHoldMs = 40_000
  await w.clock.advance(30_000)
  await w.clock.advance(15_000)
  w.messagesHoldMs = 10_000
  await complete($)
  w.messages.push(user(NUDGE))
  await turnStart($, NUDGE)
  await w.clock.advance(15_000)
  expect(statuses(w)).toEqual([])
  expect(outcomes(w)).toEqual([])
  await w.clock.advance(10_000)
  expect(statuses(w)).toEqual(['running'])
  await w.clock.advance(10_000)
  expect(statuses(w)).toEqual(['running', 'ended', 'running'])
  expect(outcomes(w)).toEqual(['summary', 'summary', 'summary'])
  expect((await paneTexts($)).slice(0, 7)).toEqual(['Summary plugin', '● NOW', 'just now', 'Pushing the branch.', 'SO FAR', 'Opening the PR.', 'YOU ASKED'])
})

test('a running call waiting behind the turn before\'s call is dropped when its own turn ends meanwhile, and that turn gets its ended call', async ($, on) => {
  const w = world(on, { settings: { firstSeconds: 10 } })
  await start($)
  await turnStart($)
  w.messagesHoldMs = 40_000
  await w.clock.advance(30_000)
  await w.clock.advance(15_000)
  await complete($)
  await turnStart($, NUDGE)
  await w.clock.advance(17_000)
  await complete($)
  await w.clock.advance(8_000)
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running', 'ended', 'ended'])
  expect([...outcomes(w)].sort()).toEqual(['skip-inflight', 'summary', 'summary', 'summary'])
})

test('a running call waiting behind an earlier turn\'s call is dropped when its turn ends and another starts meanwhile, which is first summarized at its own firstSeconds', async ($, on) => {
  const w = world(on, { settings: { firstSeconds: 10 } })
  await start($)
  await turnStart($)
  w.messagesHoldMs = 40_000
  await w.clock.advance(30_000)
  await w.clock.advance(15_000)
  await complete($)
  await turnStart($, NUDGE)
  await w.clock.advance(17_000)
  await complete($)
  w.messages.push(user('STOP JUDGE — merge it yourself.'))
  await turnStart($, 'STOP JUDGE — merge it yourself.')
  await w.clock.advance(8_000)
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running', 'ended', 'ended'])
  expect([...outcomes(w)].sort()).toEqual(['skip-inflight', 'summary', 'summary', 'summary'])
  await w.clock.advance(20_000)
  expect(statuses(w)).toEqual(['running', 'ended', 'ended', 'running'])
})

// A first/every below the 30 s tick lets every tick of a stall come due.
test('a turn whose first call waits behind the turn before\'s stalled call queues it once: later due ticks log skip-inflight until it is made', async ($, on) => {
  const w = world(on, { settings: { firstSeconds: 10, everySeconds: 10 } })
  await start($)
  await turnStart($)
  w.messagesHoldMs = 70_000
  await w.clock.advance(30_000)
  await complete($)
  w.messages.push(user(NUDGE))
  await turnStart($, NUDGE)
  await w.clock.advance(30_000)
  expect(outcomes(w)).toEqual([])
  await w.clock.advance(30_000)
  expect(outcomes(w)).toEqual(['skip-inflight'])
  await w.clock.advance(10_000)
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running', 'ended', 'running'])
  expect(outcomes(w)).toEqual(['skip-inflight', 'summary', 'summary', 'summary'])
  w.messages.push(wrote('notes/report.md'))
  await w.clock.advance(20_000)
  expect(statuses(w)).toEqual(['running', 'ended', 'running', 'running'])
  expect(outcomes(w)).toEqual(['skip-inflight', 'summary', 'summary', 'summary', 'summary'])
})

test('a turn\'s queued first call stays its only one after a turn before it, waiting too, is dropped', async ($, on) => {
  const w = world(on, { settings: { firstSeconds: 10, everySeconds: 10 } })
  await start($)
  await turnStart($)
  w.messagesHoldMs = 100_000
  await w.clock.advance(30_000)
  await complete($)
  await turnStart($, NUDGE)
  await w.clock.advance(30_000)
  await complete($)
  w.messages.push(user('STOP JUDGE — merge it yourself.'))
  await turnStart($, 'STOP JUDGE — merge it yourself.')
  w.messagesHoldMs = 40_000
  await w.clock.advance(60_000)
  expect(outcomes(w)).toEqual(['skip-inflight'])
  await w.clock.advance(30_000)
  w.messagesHoldMs = 25_000
  expect(outcomes(w)).toEqual(['skip-inflight', 'summary', 'skip-inflight'])
  await w.clock.advance(30_000)
  expect(outcomes(w)).toEqual(['skip-inflight', 'summary', 'skip-inflight', 'summary', 'skip-inflight', 'skip-inflight'])
  await w.clock.advance(20_000)
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running', 'ended', 'ended', 'running'])
  expect(outcomes(w)).toEqual(['skip-inflight', 'summary', 'skip-inflight', 'summary', 'skip-inflight', 'skip-inflight', 'summary', 'summary'])
})

test('a turn whose session log matches the last summary of the turn before is still summarized at firstSeconds', async ($, on) => {
  const w = world(on, { settings: { source: 'session-log' } })
  w.files.set(sessionLogPath(DIR, ID), '## 12:00 building the summary plugin\n')
  w.replies.push(ANSWER, FAILURES[0]!.reply)
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  await complete($)
  await turnStart($, NUDGE)
  await w.clock.settle()
  expect(outcomes(w)).toEqual(['summary', 'api-error'])
  await w.clock.advance(90_000)
  expect(outcomes(w)).toEqual(['summary', 'api-error', 'summary'])
  expect(statuses(w)).toEqual(['running', 'ended', 'running'])
})

test('a summary write still landing when session.end resets leaves the next conversation\'s pane and call count empty', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  w.replies.push(answer('Too late.', 'Too late.'))
  w.writeHoldMs = 10_000
  await w.clock.advance(90_000)
  expect(w.requests).toHaveLength(1)
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  await w.clock.advance(10_000)
  await w.clock.settle()
  expect(outcomes(w)).toEqual(['summary'])
  expect(await paneTexts($)).toEqual(['No summary yet.'])
  expect((await run($, 'show')).text).toContain('this session: 0 calls · in 0 · out 0 · cached 0')
})

test('/session-summary replies carry no name of their own: the engine prints it', async ($, on) => {
  world(on)
  await start($)
  const replies: [string, string][] = [
    ['first 120', 'first 120s after a turn starts'],
    ['every 300', 'every 300s after that'],
    ['source session-log', 'source session-log'],
    ['variant edit', 'variant edit'],
    ['off', 'off: no summary calls, in every session'],
    ['on', 'on: summary calls resume, in every session'],
  ]
  for (const [args, text] of replies) expect((await run($, args)).text).toBe(text)
  expect((await run($, 'show')).text).toMatch(/^Title: /)
})

test('the first prompt is summarized at its first model step with a provisional title, which the 90 s call may replace', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await step($, 'sub-1')
  expect(w.requests).toEqual([])

  await step($)
  await w.clock.settle()
  expect(w.requests).toHaveLength(1)
  expect(String(w.requests[0]!.prompt)).toContain('Previous TITLE: (none yet)\n')
  expect(logLines(w)[0]).toMatch(/ usd=\d+\.\d{4} first$/)
  expect(await paneTexts($)).toContain('Summary plugin')

  await step($)
  await w.clock.settle()
  expect(w.requests).toHaveLength(1)

  w.messages.push(user('and wire it into the pane'))
  await w.clock.advance(90_000)
  expect(w.requests).toHaveLength(2)
  expect(String(w.requests[1]!.prompt)).toContain('Previous TITLE: Summary plugin (provisional: written from the first prompt alone)\n')

  await complete($)
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running', 'running', 'ended'])
  expect(String(w.requests[2]!.prompt)).toContain('Previous TITLE: Summary plugin\n')

  await turnStart($, 'next request')
  await step($)
  await w.clock.settle()
  expect(w.requests).toHaveLength(3)
})

test('a prompt sent mid-turn reaches the window as the person\'s, where it arrived, and only once if it later starts its own turn', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  w.messages.push(wrote('notes/second.md'))
  await $.prompt.submit({ text: 'also estimate the cost', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
  await $.prompt.submit({ text: 'a peer relay', wait: false, origin: { kind: 'plugin', name: 'other' }, turnId: 't1' } as never)
  w.messages.push({ role: 'assistant', text: 'Estimating it now.', toolUses: [] })
  await w.clock.advance(90_000)
  const window = String(w.requests[0]!.prompt).split('Recent activity (oldest first, may start mid-way):\n')[1]!
  expect(window).toContain('→ Write: notes/second.md\nUSER: also estimate the cost\nASSISTANT: Estimating it now.')
  expect(window).not.toContain('a peer relay')

  await complete($)
  await w.clock.settle()
  w.messages.push(user('also estimate the cost'))
  await turnStart($, 'also estimate the cost')
  w.messages.push({ role: 'assistant', text: 'Here is the estimate.', toolUses: [] })
  await w.clock.advance(90_000)
  const last = String(w.requests.at(-1)!.prompt)
  expect(last.split('USER: also estimate the cost').length - 1).toBe(1)
})

test('a resumed session whose pane is seeded from its capture makes no first-prompt call', async ($, on) => {
  const capture = `${JSON.stringify({ at: '2026-10-23T11:58:00.000Z', title: 'Summary plugin', soFar: 'Earlier work', now: 'Resume it', files: [PLAN], status: 'running', source: 'messages', variant: 'edit' })}\n`
  const w = world(on, { capture })
  await start($)
  await turnStart($)
  await step($)
  await w.clock.settle()
  expect(w.requests).toEqual([])
})

test('/session-summary now makes one call at once, even switched off and outside a turn, and leaves the timer\'s schedule alone', async ($, on) => {
  const w = world(on, { settings: { isOff: true } })
  await start($)
  const reply = await run($, 'now')
  expect(w.requests).toHaveLength(1)
  expect(statuses(w)).toEqual(['ended'])
  expect(reply.text).toMatch(/^now: summary\nTitle: Summary plugin\nLast prompt: You asked for the plugin\.\nSo far: Building the summary plugin\./)
  expect(logLines(w)).toEqual([expect.stringMatching(/^\S+ summary session=synthetic-session ms=\d+ reason=source=messages variant=edit in=1200 out=80 cached=300 usd=\d+\.\d{4} manual$/)])
  expect(await paneTexts($)).toContain('Building the summary plugin.')

  expect((await run($, 'now')).text).toMatch(/^now: summary\n/)
  expect(w.requests).toHaveLength(2)

  expect((await run($, 'on')).text).toBe('on: summary calls resume, in every session')
  await turnStart($)
  w.replies.push(answer('Still building.', 'Testing now.'))
  expect((await run($, 'now')).text).toMatch(/^now: summary\n/)
  expect(statuses(w)).toEqual(['ended', 'ended', 'running'])
  w.messages.push(user('and test it'))
  await w.clock.advance(90_000)
  expect(statuses(w)).toEqual(['ended', 'ended', 'running', 'running'])
  expect(outcomes(w)).toEqual(['summary', 'summary', 'summary', 'summary'])
})

test('/session-summary now in a non-interactive session makes no call and says why', async ($, on) => {
  const w = world(on)
  await start($, false)
  expect((await run($, 'now')).text).toBe('now: no call; summaries run in interactive sessions only')
  expect(w.requests).toEqual([])
  expect(logLines(w)).toEqual([])
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
  expect((await paneTexts($))[5]).toBe('Building the summary plugin.')

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
  expect(await paneTexts($)).toEqual(['No summary yet.'])
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
  expect(await paneTexts($)).toEqual(['No summary yet.'])
  expect((await run($, 'show')).text).toContain('this session: 0 calls')
})

const sent = (...files: string[]): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `s-${files.join()}`, tool: 'SendUserFile', input: { files } }] })
const fileRows = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  const rows = (await ui.findAll({ type: 'Text' })).filter(t => t.text.startsWith('file:'))
  await ui.unmount()
  return rows
}

test('a sent file shows at the next tick with no model call, before the first summary too; a written one does not', async ($, on) => {
  const w = world(on, { settings: { isOff: true } })
  w.messages = [user('write the plan')]
  await start($)
  await turnStart($)
  await w.clock.advance(30_000)
  expect(await paneTexts($)).toEqual(['No summary yet.'])

  w.messages.push(wrote(PLAN))
  await step($)
  await w.clock.advance(30_000)
  expect(await paneTexts($)).toEqual(['No summary yet.'])

  w.messages.push(sent(PLAN))
  await step($)
  await w.clock.advance(30_000)
  expect(w.requests).toEqual([])
  expect(await paneTexts($)).toEqual(['No summary yet.', 'FILES', LINKED_PLAN])
})

test('the list follows a Write, Edit or send while switched off, and not a Read or text naming a listed file', async ($, on) => {
  const w = world(on, { settings: { isOff: true } })
  w.messages = [sent('a.md'), sent('b.md')]
  await start($)
  await turnStart($)
  await step($)
  await w.clock.advance(30_000)
  expect((await run($, 'show')).text).toContain('Files: /tmp/project/b.md, /tmp/project/a.md\n')

  w.messages.push({ role: 'assistant', text: 'See a.md', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: { file_path: 'a.md' } }] })
  await step($)
  await w.clock.advance(30_000)
  expect((await run($, 'show')).text).toContain('Files: /tmp/project/b.md, /tmp/project/a.md\n')

  w.messages.push(wrote('a.md'))
  await step($)
  await w.clock.advance(30_000)
  expect((await run($, 'show')).text).toContain('Files: /tmp/project/a.md, /tmp/project/b.md\n')

  w.messages.push(sent('b.md'))
  await step($)
  await w.clock.advance(30_000)
  expect((await run($, 'show')).text).toContain('Files: /tmp/project/b.md, /tmp/project/a.md\n')
  expect(w.requests).toEqual([])
})

test('a call captures the list without its shares, a resume seeds it with its flags, and /clear empties it', async ($, on) => {
  const w = world(on)
  w.files.set(PLAN_PATH, '')
  w.files.set('/tmp/project/old.md', '')
  w.messages.push(sent('old.md'))
  w.replies.push(judged(`ADD: ${PLAN_PATH}\nSUPERSEDED: /tmp/project/old.md`))
  await start($)
  await turnStart($)
  await step($)
  await w.clock.settle()
  const line = JSON.parse(w.files.get(CAPTURE)!.trim())
  expect(line.files).toEqual([{ path: PLAN_PATH, touchedAt: T0, touches: 1 }, { path: '/tmp/project/old.md', touchedAt: T0, touches: 1, isSuperseded: true }])
  expect([line.candidates, line.add, line.superseded]).toEqual([[PLAN_PATH], [PLAN_PATH], ['/tmp/project/old.md']])

  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  await w.clock.settle()
  expect(await paneTexts($)).toEqual(['No summary yet.'])
  expect((await run($, 'show')).text).toContain('Files: none\n')

  await start($)
  const rows = await fileRows($)
  expect(rows.map(r => r.text)).toEqual([LINKED_PLAN, 'file:///tmp/project/old.md./old.md'])
  expect(rows.map(r => r.props.strikethrough)).toEqual([undefined, true])
})

test('the section shows the newest five, and its header says where it stands only past five', async ($, on) => {
  const w = world(on, { settings: { isOff: true } })
  w.messages = ['one.md', 'two.md', 'three.md', 'four.md', 'five.md'].map(n => sent(n))
  await start($)
  await turnStart($)
  await step($)
  await w.clock.advance(30_000)
  const rows = (name: string) => `file:///tmp/project/${name}./${name}`
  expect(await paneTexts($)).toEqual(['No summary yet.', 'FILES', rows('five.md'), rows('four.md'), rows('three.md'), rows('two.md'), rows('one.md')])

  w.messages.push(sent('six.md'))
  await step($)
  await w.clock.advance(30_000)
  expect(await paneTexts($)).toEqual(['No summary yet.', 'FILES 1–5 of 6', rows('six.md'), rows('five.md'), rows('four.md'), rows('three.md'), rows('two.md')])
})

test('the request offers existing files as candidates and the list to judge, and nothing a secret filter or the session log holds back', async ($, on) => {
  const w = world(on)
  const log = sessionLogPath('/h/.claude/stopstopping', ID)
  for (const f of [PLAN_PATH, '/tmp/project/.env', '/tmp/project/sent.md', log]) w.files.set(f, '')
  w.messages.push(wrote('/tmp/project/.env'), sent('sent.md'), sent('/tmp/project/secret-notes.md'), { role: 'assistant', text: `Log is ${log}, and /tmp/project/no-such.md`, toolUses: [] })
  await start($)
  await turnStart($)
  await step($)
  await w.clock.settle()
  const files = String(w.requests[0]!.prompt).split('File candidates:\n')[1]!
  expect(files).toBe(`- ${PLAN_PATH}\n\nCurrent file list:\n- /tmp/project/sent.md`)
  expect((await run($, 'show')).text).toContain('Files: /tmp/project/secret-notes.md, /tmp/project/sent.md\n')
})

test('a named path outside its set changes nothing, and a parse-partial reply still applies its verdict', async ($, on) => {
  const w = world(on)
  w.files.set(PLAN_PATH, '')
  w.replies.push({ isAnswered: true, text: `NOW: Writing.\nADD: /invented.md, ${PLAN_PATH}`, usage: USAGE })
  await start($)
  await turnStart($)
  await step($)
  await w.clock.settle()
  expect(outcomes(w)).toEqual(['parse-partial'])
  expect((await run($, 'show')).text).toContain(`Files: ${PLAN_PATH}\n`)
})

for (const failure of [...FAILURES, { outcome: 'parse-failed', reply: { isAnswered: true, text: `ADD: ${PLAN_PATH}`, usage: USAGE } as ModelCompleteResult }]) {
  test(`a call that ends ${failure.outcome} (${failure.reply.isAnswered ? failure.reply.text.slice(0, 3) : 'unanswered'}) leaves the list as it is`, async ($, on) => {
    const w = world(on)
    w.files.set(PLAN_PATH, '')
    w.messages.push(sent('kept.md'))
    w.replies.push(failure.reply)
    await start($)
    await turnStart($)
    await step($)
    await w.clock.settle()
    expect(outcomes(w)).toEqual([failure.outcome])
    expect((await run($, 'show')).text).toContain('Files: /tmp/project/kept.md\n')
  })
}

test('switched off, nothing joins but a sent file; /session-summary now is a call, so its ADD joins', async ($, on) => {
  const w = world(on, { settings: { isOff: true } })
  w.files.set(PLAN_PATH, '')
  w.messages.push({ role: 'assistant', text: `The plan is ${PLAN_PATH}.`, toolUses: [] })
  await start($)
  await turnStart($)
  await step($)
  await w.clock.advance(120_000)
  expect((await run($, 'show')).text).toContain('Files: none\n')

  w.replies.push(judged(`ADD: ${PLAN_PATH}`))
  await run($, 'now')
  expect((await run($, 'show')).text).toContain(`Files: ${PLAN_PATH}\n`)
})

test('a superseded row is dim and struck through and keeps its link; a later touch clears it', async ($, on) => {
  const w = world(on)
  w.messages = [user('go'), sent('old.md'), sent('new.md')]
  w.replies.push(judged('SUPERSEDED: /tmp/project/new.md'))
  await start($)
  await turnStart($)
  await step($)
  await w.clock.settle()
  const rows = await fileRows($)
  expect(rows.map(r => r.text)).toEqual(['file:///tmp/project/old.md./old.md', 'file:///tmp/project/new.md./new.md'])
  expect(rows.map(r => [r.props.dimColor, r.props.strikethrough])).toEqual([[undefined, undefined], [true, true]])

  w.messages.push(wrote('new.md'))
  await step($)
  await w.clock.advance(30_000)
  const after = await fileRows($)
  expect(after.map(r => r.text)).toEqual(['file:///tmp/project/new.md./new.md', 'file:///tmp/project/old.md./old.md'])
  expect(after.map(r => r.props.strikethrough)).toEqual([undefined, undefined])
})

test('a recent file has a dot in a column of its own, which the redraw drops once it ages out; every row keeps the column', async ($, on) => {
  const w = world(on)
  w.messages = [user('go'), sent('a.md')]
  w.replies.push(judged('SUPERSEDED: none'))
  await start($)
  await turnStart($)
  await step($)
  await w.clock.settle()
  const dots = async () => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
    const found = (await ui.findAll({ type: 'Text' })).filter(t => t.text === '•').length
    const columns = (await ui.findAll({ type: 'Box' })).filter(b => b.props.width === 1).length
    await ui.unmount()
    return { found, columns }
  }
  expect(await dots()).toEqual({ found: 1, columns: 1 })
  await w.clock.advance(RECENT_FILE_MS + 1)
  expect(await dots()).toEqual({ found: 0, columns: 1 })
})

test('an added file gets its dot at the call that added it', async ($, on) => {
  const w = world(on)
  w.files.set(PLAN_PATH, '')
  w.replies.push(judged(`ADD: ${PLAN_PATH}`))
  await start($)
  await turnStart($)
  await step($)
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  expect((await ui.findAll({ type: 'Text' })).filter(t => t.text === '•')).toHaveLength(1)
  await ui.unmount()
})

test('switched off mid-turn, a summarized turn makes no ended call', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(90_000)
  expect((await run($, 'off')).text).toBe('off: no summary calls, in every session')
  await complete($)
  await w.clock.settle()
  expect(statuses(w)).toEqual(['running'])
  expect((await run($, 'show')).text).toContain('this session: 1 calls · in 1200 · out 80 · cached 300')
})

test('a prompt the person sends is summarized at the next model step, even in a turn under 90 s, and earns its ended call', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await step($)
  await w.clock.settle()
  await complete($)
  await w.clock.settle()
  const before = w.requests.length
  w.messages.push(user('a short question'))
  await $.prompt.submit({ text: 'a short question', wait: false, origin: { kind: 'composer' } })
  await turnStart($, 'a short question')
  await step($, 'sub-1')
  await w.clock.settle()
  expect(w.requests).toHaveLength(before)
  await step($)
  await w.clock.settle()
  expect(w.requests).toHaveLength(before + 1)
  expect(logLines(w).at(-1)).toMatch(/ prompt$/)
  await step($)
  await w.clock.settle()
  expect(w.requests).toHaveLength(before + 1)
  await complete($)
  await w.clock.settle()
  expect(statuses(w).at(-1)).toBe('ended')
  expect(w.requests).toHaveLength(before + 2)
})

test('a prompt from a plugin makes no prompt call', async ($, on) => {
  const w = world(on, { capture: `${JSON.stringify({ at: '2026-10-23T11:58:00.000Z', title: 'T', soFar: 'S', now: 'N', files: [], status: 'running', source: 'messages', variant: 'edit' })}\n` })
  await start($)
  await $.prompt.submit({ text: 'keepalive ping. Reply only: ok', wait: false, origin: { kind: 'plugin', name: 'other' } } as never)
  await turnStart($, 'keepalive ping. Reply only: ok')
  await step($)
  await w.clock.settle()
  expect(w.requests).toEqual([])
})
