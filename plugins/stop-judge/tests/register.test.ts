import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteRequest, On } from 'claude-code'
import { buildSystem, judgeRequest, TAIL_BYTES, transcriptFindArgv } from '../hooks/judge'

const T0 = Date.parse('2026-10-20T12:00:00Z')
const TRANSCRIPT = '/home/u/.claude/projects/-work-app/sess-1.jsonl'
const OFFER = 'Tests pass.\n\nWant me to open the PR?'
const CONTINUE = '{"mode":"instructing","shape":"offer","confidence":0.9,"verdict":"continue","reason":"Open the PR yourself"}'
const done = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

const at = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString()
const user = (text: string, minutesAgo = 5, extra: Record<string, unknown> = {}) => ({ type: 'user', timestamp: at(minutesAgo), message: { role: 'user', content: text }, ...extra })
const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const pluginRow = (text: string) => user(text, 5, { origin: { kind: 'plugin', name: 'keepalive', asUser: true }, promptSource: 'system' })

type Reply =
  | { isAnswered: true; text: string }
  | { isAnswered: false; reason: 'aborted' | 'empty-reply' }

function world(on: On, rows: unknown[] = [user('ship the fix'), assistant(OFFER)], env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u', STOPSTOPPING_DIR: '/tmp/ss', ...env })
  mock.store(on)
  const w = {
    clock,
    rows,
    transcript: TRANSCRIPT,
    reply: { isAnswered: true, text: CONTINUE } as Reply,
    box: '',
    awk: '',
    logged: [] as string[],
    submitted: [] as string[],
    asUser: [] as boolean[],
    requests: [] as ModelCompleteRequest[],
    commands: [] as string[],
    tailArgv: [] as string[][],
    awkArgv: [] as string[][],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
  }
  // Only the firing log exists: no DECISIONS.md, no context-off flag.
  on('fs.exists', async (_$, e) => ({ value: e.path.endsWith('.log') }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('process.run', async (_$, e) => {
    const stdout = e.argv[0] === 'find' ? (w.transcript ? `${w.transcript}\n` : '') : e.argv[0] === 'awk' ? w.awk : ''
    if (e.argv[0] === 'tee') w.logged.push(e.init?.stdin ?? '')
    if (e.argv[0] === 'awk') w.awkArgv.push([...e.argv])
    return { value: { ...done, stdout } }
  })
  on('process.spawn', async function* (_$, e) {
    w.tailArgv.push([...e.argv])
    yield { stream: 'stdout' as const, text: w.rows.map(r => JSON.stringify(r)).join('\n') + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('model.complete', async (_$, e) => {
    w.requests.push(e)
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { ...w.reply, usage } as never }
  })
  on('prompt.read', async () => ({ value: { text: w.box, cursor: w.box.length } }))
  on('prompt.submit', async (_$, e) => {
    if (e.origin.kind === 'plugin') {
      w.submitted.push(e.text)
      w.asUser.push(e.origin.asUser === true)
    }
    return { text: e.text }
  })
  on('ui.status', async (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', async (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  return w
}

const complete = ($: Engine, extra: { agentId?: string; reason?: 'answer' | 'aborted'; answer?: string } = {}) =>
  $.turn.complete({ turnId: 't1', reason: 'answer', answer: OFFER, durationMs: 1, isAborted: false, ...extra })
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const run = (args: string) => ({ command: 'stop-judge', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })
const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/tmp', surface: isInteractive ? 'terminal' : null, isInteractive })
const outcomes = (logged: string[]) => logged.map(l => l.split(' ')[1])

test('a continue verdict at 0.9 nudges once as the user and logs it', async ($, on) => {
  const w = world(on)
  await start($)
  await complete($)
  expect(w.submitted).toEqual(['STOP JUDGE — Open the PR yourself.'])
  expect(w.asUser).toEqual([true])
  expect(outcomes(w.logged)).toEqual(['continue'])
  expect(w.logged[0]).toMatch(/^\S+ continue session=sess-1 ms=\d+ reason=Open the PR yourself\n$/)
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]).toMatchObject({ model: 'haiku', system: buildSystem(), maxTokens: 300, effort: 'low', timeoutMs: 20_000 })
  expect(w.tailArgv).toEqual([['tail', '-c', String(TAIL_BYTES), TRANSCRIPT]])
})

test('the request carries the final message, the opening, and the minutes since the operator wrote', async ($, on) => {
  const w = world(on, [user('earlier ask', 90), assistant('Earlier answer.'), user('ask me one by one before you push', 7), assistant(OFFER)])
  await start($)
  await complete($)
  const prompt = String(w.requests[0]?.prompt)
  expect(prompt).toContain('## Earlier operator messages, oldest first\n\nearlier ask')
  expect(prompt).toContain('## Operator message that opened the turn\n\nask me one by one before you push')
  expect(prompt).toContain("## Agent's final message\n\nTests pass.")
  // The gap goes in whole; the shipped switch leaves it out of the text (judge-decide pins both).
  expect(w.requests[0]).toEqual({ ...judgeRequest(OFFER, 'ask me one by one before you push', ['earlier ask'], { minutes: 7, isLowerBound: false }) })
  expect(prompt).not.toContain('Minutes since')
})

test('confidence 0.5 logs stop-lowconf and submits nothing', async ($, on) => {
  const w = world(on)
  w.reply = { isAnswered: true, text: CONTINUE.replace('0.9', '0.5') }
  await start($)
  await complete($)
  expect(w.submitted).toEqual([])
  expect(outcomes(w.logged)).toEqual(['stop-lowconf'])
  expect(w.logged[0]).toContain('conf=0.5 Open the PR yourself')
})

test('a stop verdict logs stop; prose around the JSON line still parses', async ($, on) => {
  const w = world(on)
  w.reply = { isAnswered: true, text: 'Sure:\n```json\n{"verdict":"stop","reason":"answers the question"}\n```' }
  await start($)
  await complete($)
  expect(w.submitted).toEqual([])
  expect(outcomes(w.logged)).toEqual(['stop'])
})

test('a second turn before the person writes logs pass-nudged; a person prompt re-arms the judge', async ($, on) => {
  const w = world(on)
  await start($)
  await complete($)
  await complete($)
  expect(outcomes(w.logged)).toEqual(['continue', 'pass-nudged'])
  expect(w.requests).toHaveLength(1)
  await $.prompt.submit(typed('go on'))
  await complete($)
  expect(outcomes(w.logged)).toEqual(['continue', 'pass-nudged', 'continue'])
  expect(w.submitted).toHaveLength(2)
})

test('text in the prompt box means the person is answering: pass-typing, no nudge, and the next turn may still nudge', async ($, on) => {
  const w = world(on)
  w.box = 'actually, wait'
  await start($)
  await complete($)
  expect(w.submitted).toEqual([])
  expect(outcomes(w.logged)).toEqual(['pass-typing'])
  w.box = ''
  await complete($)
  expect(w.submitted).toHaveLength(1)
})

test('a subagent turn, an interrupted turn, and a nested judge each pass without a model call', async ($, on) => {
  const w = world(on)
  await start($)
  await complete($, { agentId: 'a7' })
  await complete($, { reason: 'aborted' })
  expect(outcomes(w.logged)).toEqual(['pass-subagent', 'pass-aborted'])
  expect(w.requests).toHaveLength(0)
  expect(w.tailArgv).toHaveLength(0)
})

test('STOP_JUDGE_NESTED opts a run out', async ($, on) => {
  const w = world(on, undefined, { STOP_JUDGE_NESTED: '1' })
  await start($)
  await complete($)
  expect(outcomes(w.logged)).toEqual(['pass-nested'])
  expect(w.requests).toHaveLength(0)
})

test('an unanswered model call is pass-timeout when cut and pass-error otherwise, never a nudge', async ($, on) => {
  const w = world(on)
  await start($)
  w.reply = { isAnswered: false, reason: 'aborted' }
  await complete($)
  w.reply = { isAnswered: false, reason: 'empty-reply' }
  await complete($)
  w.reply = { isAnswered: true, text: 'no json here' }
  await complete($)
  w.reply = { isAnswered: true, text: CONTINUE.replace('Open the PR yourself', '') }
  await complete($)
  expect(outcomes(w.logged)).toEqual(['pass-timeout', 'pass-error', 'pass-error', 'pass-error'])
  expect(w.logged[3]).toContain('continue with an empty reason')
  expect(w.submitted).toEqual([])
})

test('a keepalive ping turn is passed without a model call; an /afk automessage turn is judged', async ($, on) => {
  const w = world(on, [user('ship the fix', 70), assistant('Done.'), pluginRow('keepalive ping. Reply only: ok'), assistant('ok')])
  await start($)
  await complete($, { answer: 'ok' })
  expect(outcomes(w.logged)).toEqual(['pass-keepalive'])
  expect(w.requests).toHaveLength(0)
  w.rows = [user('ship the fix', 70), assistant('Done.'), pluginRow('automessage: user is /afk'), assistant(OFFER)]
  await complete($)
  expect(String(w.requests[0]?.prompt)).toContain('## Operator message that opened the turn\n\nautomessage: user is /afk')
})

test('no transcript for the session is pass-notext; the lookup goes by session id', async ($, on) => {
  const w = world(on)
  w.transcript = ''
  await start($)
  await complete($)
  expect(outcomes(w.logged)).toEqual(['pass-notext'])
  expect(w.requests).toHaveLength(0)
  expect(transcriptFindArgv('/home/u', 'sess-1')).toEqual(['find', '/home/u/.claude/projects', '-maxdepth', '2', '-name', 'sess-1.jsonl'])
})

test('an empty answer falls back to the last assistant row of the transcript', async ($, on) => {
  const w = world(on)
  await start($)
  await complete($, { answer: '' })
  expect(String(w.requests[0]?.prompt)).toContain("## Agent's final message\n\nTests pass.")
})

test('/stop-judge off logs pass-off without a model call, on judges again, and the setting persists in the store', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await $.command.run(run('off'))).text).toContain('judge off')
  await complete($)
  expect(outcomes(w.logged)).toEqual(['pass-off'])
  expect(w.requests).toHaveLength(0)
  expect((await $.command.run(run(''))).text).toMatch(/^off · context: on · last 7 days: none · DECISIONS\.md: /)
  expect((await $.command.run(run('on'))).text).toContain('judge on')
  await complete($)
  expect(outcomes(w.logged)).toEqual(['pass-off', 'continue'])
})

test('the status line counts the last seven days from the log through countOutcomes', async ($, on) => {
  const w = world(on)
  const line = (minutesAgo: number, outcome: string) => `${at(minutesAgo).slice(0, 19)}Z ${outcome} session=s ms=0 reason=r`
  // awk keeps the lines from the cutoff on; one older line it let through is still not counted.
  w.awk = [line(10, 'continue'), line(20, 'stop'), line(30, 'stop'), line(40, 'pass-off'), line(8 * 24 * 60, 'stop'), 'not a firing line', ''].join('\n')
  await start($)
  const text = (await $.command.run(run(''))).text
  expect(text).toContain('last 7 days: continue 1, stop 2, pass-off 1 · ')
  const since = `${new Date(T0 - 7 * 86_400_000).toISOString().slice(0, 19)}Z`
  expect(w.awkArgv).toEqual([['awk', '-v', `since=${since}`, '$1 >= since', '/tmp/ss/logs/stop-judge.log']])
})

test('a transcript tail with no typed row still states the gap, as more than the minutes since its oldest row', async ($, on) => {
  const w = world(on, [{ type: 'system', timestamp: at(95), subtype: 'turn_duration' }, pluginRow('automessage: user is /afk'), assistant(OFFER)])
  await start($)
  await complete($)
  expect(w.requests[0]).toEqual({ ...judgeRequest(OFFER, 'automessage: user is /afk', [], { minutes: 95, isLowerBound: true }) })
})

test('/stop-judge off mid-session shows the marker; on clears it, from the stored setting', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run(run('off'))
  expect(w.statuses.at(-1)).toBe('stop-judge off')
  await $.command.run(run('on'))
  expect(w.statuses.at(-1)).toBe(undefined)
})

test('the command registers once in a non-interactive session too, and an unknown argument prints usage', async ($, on) => {
  const w = world(on)
  await start($, false)
  expect(w.commands).toEqual(['stop-judge'])
  expect((await $.command.run(run('nonsense'))).text).toBe('/stop-judge [off|on|context off|context on|derive [all]]')
})
