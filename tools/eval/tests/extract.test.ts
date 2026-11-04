import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteRequest, On } from 'claude-code'
import { extractRecord, firingsOf, keyFrom, pushMark, tailAt, turnAtFiring } from '../hooks/extract'
import type { LineMark } from '../hooks/extract'
import { JUDGE_REQUEST, TAIL_BYTES } from '../hooks/judge/config'
import { parseRows } from '../hooks/judge/judge'
import { PROMPT } from '../hooks/judge/prompt'

const T0 = Date.parse('2026-10-15T05:10:46Z')
const ago = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString()
const typed = (text: string, minutes: number) => ({ type: 'user', timestamp: ago(minutes), message: { role: 'user', content: text }, origin: { kind: 'human' }, promptSource: 'typed' })
const agent = (text: string, minutes: number) => ({ type: 'assistant', timestamp: ago(minutes), message: { content: [{ type: 'text', text }] } })
const tool = (text: string, minutes: number) => ({ type: 'user', timestamp: ago(minutes), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } })
const nudge = (minutes: number) => ({ type: 'user', timestamp: ago(minutes), message: { role: 'user', content: 'STOP JUDGE — keep going' }, origin: { kind: 'plugin' } })
const system = (minutes: number) => ({ type: 'system', subtype: 'turn_duration', timestamp: ago(minutes) })

const encoder = new TextEncoder()
const bytesOf = (s: string) => encoder.encode(s).length
const fileOf = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const linesOf = (file: string) => file.split('\n').slice(0, -1)

// `grep -a -b '' <path>` over one file, as the host runs it: the offsets in bytes.
function grep(file: string): string {
  let offset = 0
  let out = ''
  for (const line of linesOf(file)) {
    out += `${offset}:${line}\n`
    offset += bytesOf(line) + 1
  }
  return out
}

function marksOf(file: string): LineMark[] {
  const marks: LineMark[] = []
  for (const line of linesOf(grep(file))) pushMark(marks, line)
  return marks
}

// The oracle, written apart from the code under test: the file as the judge read it, its last
// `tailBytes` bytes as `tail -c` gives them, through the judge's own parser. The judge read right
// after the turn's last agent row with text (timed no later than the firing stamp plus its 2 s
// lag), else the stamp is all there is: the file ends at the last line timed before it.
const LAG_MS = 2000

function hasText(row: Record<string, unknown>): boolean {
  if (row.type !== 'assistant' || row.isSidechain) return false
  const content = (row.message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) && content.some(b => (b as { type?: string; text?: string }).type === 'text' && ((b as { text?: string }).text ?? '').trim() !== '')
}

function productionTail(file: string, ts: string, tailBytes: number): { rows: unknown[]; cut: 'answer' | 'stamp' } {
  const stamp = Date.parse(ts)
  let answerEnd = -1
  let stampEnd = 0
  let offset = 0
  for (const line of linesOf(file)) {
    offset += bytesOf(line) + 1
    const row = JSON.parse(line) as Record<string, unknown>
    const at = Date.parse(String(row.timestamp))
    if (hasText(row) && at <= stamp + LAG_MS) answerEnd = offset
    if (at < stamp) stampEnd = offset
  }
  const end = answerEnd >= 0 ? answerEnd : stampEnd
  const tail = new TextDecoder().decode(encoder.encode(file).slice(Math.max(0, end - tailBytes), end))
  return { rows: parseRows(tail), cut: answerEnd >= 0 ? 'answer' : 'stamp' }
}

// Multi-byte text in the rows, a row with no time, a sidechain row, a typed row after the
// firing: every cut of the tail and every firing time must give the judge's own rows.
const ROWS = [
  typed('first ask, très bien', 300),
  agent('Working on it ✅', 299),
  tool('output é'.repeat(20), 250),
  { type: 'summary', summary: 'no time on this row' },
  typed('second ask 🚀 now', 120),
  { ...agent('a subagent row', 110), isSidechain: true },
  tool('more output'.repeat(10), 100),
  system(95),
  agent('Done. Want me to push? 👍', 1),
  typed('a later ask 🚀 é, after the firing', -5),
]

const at = (minutes: number, extraMs = 0) => new Date(T0 - minutes * 60_000 + extraMs).toISOString()

test('every cut of the tail and every firing time gives the rows the judge read', () => {
  const file = fileOf(ROWS)
  const marks = marksOf(file)
  // ago(299.5) has no agent row before it (stamp cut); the others end at 299 or 1 minutes back,
  // and 1 minute minus 2.5 s / plus exactly 2 s straddle the answer's lag window.
  const firings = [ago(0), ago(2), ago(96), ago(105), ago(119), ago(200), ago(299.5), ago(-10), at(1, -2500), at(1, -2000), at(1, -1500), at(299, -2000)]
  const cuts = new Set<string>()
  for (const ts of firings) {
    for (let tailBytes = 1; tailBytes <= bytesOf(file) + 1; tailBytes += 7) {
      const want = productionTail(file, ts, tailBytes)
      // A sidechain row is in the file and parses to nothing, in both.
      expect({ ts, tailBytes, tail: tailAt(marks, ts, tailBytes) }).toEqual({ ts, tailBytes, tail: want })
      cuts.add(want.cut)
    }
  }
  expect([...cuts].sort()).toEqual(['answer', 'stamp'])
})

test('a turn whose last agent row is before the firing ends there: the nudge and a prompt typed during the model call stay out', () => {
  // The judge read at the agent row (10 min back). The stamp is later (8.5): the nudge and the
  // prompt typed meanwhile are timed before it, and none was in the file the judge read.
  const rows = [typed('the ask', 200), agent('Done. Want me to push?', 10), nudge(9.5), typed('typed during the model call', 9.9)]
  const tail = tailAt(marksOf(fileOf(rows)), ago(8.5))!
  expect(tail.cut).toBe('answer')
  expect(tail.rows.map(r => r.timestamp)).toEqual([ago(200), ago(10)])
})

test('the agent row counts as the read when timed up to 2 s after the stamp, not past it', () => {
  const marks = marksOf(fileOf([typed('ask', 30), agent('Done.', 10)]))
  const agentAt = T0 - 10 * 60_000
  expect(tailAt(marks, new Date(agentAt - 2000).toISOString())!.cut).toBe('answer')
  expect(tailAt(marks, new Date(agentAt - 2001).toISOString())!.cut).toBe('stamp')
})

test('a firing with no agent row with text falls back to the stamp: the lines timed before it', () => {
  const toolUse = { type: 'assistant', timestamp: ago(35), message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }
  const blank = agent('  \n ', 34)
  const sidechain = { ...agent('a subagent answer', 33), isSidechain: true }
  const marks = marksOf(fileOf([typed('the ask', 50), toolUse, blank, sidechain, tool('out', 32), typed('after the stamp', 5)]))
  const tail = tailAt(marks, ago(30))!
  expect(tail.cut).toBe('stamp')
  expect(tail.rows.map(r => r.timestamp)).toEqual([ago(50), ago(35), ago(34), ago(32)])
})

test('only an agent row with text is an answer mark', () => {
  const marks = marksOf(
    fileOf([agent('says something', 9), { type: 'assistant', timestamp: ago(8), message: { content: [{ type: 'tool_use', id: 't' }] } }, agent('   ', 7), { ...agent('side', 6), isSidechain: true }, typed('ask', 5), tool('out', 4)]),
  )
  expect(marks.map(m => m.isAnswer)).toEqual([true, false, false, false, false, false])
})

test('a line ends where the host says the next begins, whatever its decoded text counts', () => {
  // One raw byte the host could not decode reads back as U+FFFD, three bytes as text.
  const first = JSON.stringify(typed('a byte � the host kept raw', 30))
  const next = bytesOf(first) + 1 - 2
  const marks: LineMark[] = []
  pushMark(marks, `0:${first}`)
  pushMark(marks, `${next}:${JSON.stringify(typed('after the firing', -5))}`)
  expect(tailAt(marks, ago(0), next)!.rows).toHaveLength(1)
  expect(tailAt(marks, ago(0), next - 1)!.rows).toHaveLength(0)
})

test('no line before the firing gives no rows; no usable firing time gives no tail', () => {
  expect(tailAt([], ago(0))).toEqual({ rows: [], cut: 'stamp' })
  const marks = marksOf(fileOf([typed('ask', 5)]))
  expect(tailAt(marks, ago(10))).toEqual({ rows: [], cut: 'stamp' })
  expect(tailAt(marks, null)).toBeNull()
  expect(tailAt(marks, 'not a time')).toBeNull()
})

const FIRING = { at: ago(0), outcome: 'stop', session: 's1', ms: 1, reason: 'x' }

test('a record holds the message the judge builds at the firing and the words its quotes are checked against', () => {
  const marks = marksOf(fileOf([typed('first ask', 300), agent('First answer.', 299), typed('second ask', 7), agent('Done. Want me to push?', 1), nudge(0.7), typed('typed during the model call', 0.5)]))
  const held = turnAtFiring(FIRING, marks)
  const r = extractRecord('F0001', FIRING, held, null)
  expect(r).toMatchObject({ id: 'F0001', final: 'Done. Want me to push?', opening: 'second ask', operator_text: 'first ask\nsecond ask', outcome: 'stop', judge_reason: 'x' })
  expect(r.input).toContain('## Recent conversation, oldest first\n\nOperator: first ask\n\nAgent: First answer.')
  expect(r.input).toContain('## Operator message that opened the turn\n\nsecond ask')
  expect(r.input).not.toContain('typed during the model call')
  expect(extractRecord('F0001', FIRING, held, { path: '~/plan.md', body: 'The plan.' }).input).toContain('## Plan document ~/plan.md, its opening\n\nThe plan.')
})

test('a firing whose transcript is gone keeps its log fields with no final', () => {
  expect(turnAtFiring(FIRING, null)).toBeNull()
  expect(extractRecord('F0001', FIRING, null, null)).toEqual({ id: 'F0001', ts: FIRING.at, session: 's1', outcome: 'stop', judge_reason: 'x', final: null, opening: '', operator_text: '', input: '' })
})

test('the judged lines of a log are the ones that reached a decision, an old stop-lowconf among them', () => {
  const line = (outcome: string) => `2026-10-15T05:10:46Z ${outcome} session=s ms=1 reason=r`
  const log = [line('stop'), line('pass-off'), line('continue'), line('stop-lowconf'), line('pass-scripted'), 'not a firing'].join('\n')
  expect(firingsOf(log).map(f => [f.id, f.firing.outcome])).toEqual([
    ['F0000', 'stop'],
    ['F0002', 'continue'],
    ['F0003', 'stop-lowconf'],
  ])
})

const done = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const PATH = '/home/u/.claude/projects/-work-app/s1.jsonl'
const RECORD = { id: 'F0001', ts: ago(0), session: 's1', outcome: 'stop', judge_reason: 'x', final: 'Done. Want me to push?', opening: 'second ask', operator_text: 'first ask\nsecond ask', input: 'THE INPUT' }
const RUN_ARGS = '--key /in/key.jsonl --ids /in/ids.txt --graders /in/grades.jsonl --out /out/run.jsonl'
const COMMAND = { command: 'eval-judge', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const ANSWERS = '{"step":"Run it","blocker":"none","why":"an offer"}'

function evalWorld(on: On, transcript: string, piece: number) {
  mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u' })
  const files: Record<string, string> = {
    '/in/key.jsonl': `${JSON.stringify(RECORD)}\n`,
    '/in/ids.txt': 'F0001\n',
    '/in/grades.jsonl': '{"id":"F0001","verdict":"continue","case":"offer","confidence":"high"}\n',
    '/in/candidate.txt': 'A CANDIDATE PROMPT',
    '/in/log': `${ago(0).slice(0, 19)}Z stop session=s1 ms=1 reason=x\n`,
  }
  const w = { requests: [] as ModelCompleteRequest[], written: [] as string[] }
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: T0, isLink: false } }))
  on('fs.write', async () => ({ value: undefined }))
  on('fs.exists', async () => ({ value: false }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'tee') w.written.push(e.init?.stdin ?? '')
    return { value: { ...done, stdout: e.argv[0] === 'find' && e.argv.at(-1) === 's1.jsonl' ? `${PATH}\n` : '' } }
  })
  // `cat` of an input, or `grep -b` of the transcript, in pieces that cut lines anywhere.
  on('process.spawn', async function* (_$, e) {
    const out = e.argv[0] === 'cat' ? (files[e.argv[1]!] ?? '') : grep(transcript)
    for (let i = 0; i < out.length; i += piece) yield { stream: 'stdout' as const, text: out.slice(i, i + piece) }
    return { value: { code: e.argv[0] === 'cat' && files[e.argv[1]!] === undefined ? 1 : 0, signal: null } }
  })
  on('model.complete', async (_$, e) => {
    w.requests.push(e)
    return { value: { isAnswered: true, text: ANSWERS, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never }
  })
  return w
}

const lines = (w: { written: string[] }) =>
  w.written[0]!
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as Record<string, unknown>)

const TURN = fileOf([typed('first ask', 300), tool('x'.repeat(1000), 100), typed('second ask', 7), agent('Done. Want me to push?', 1), nudge(0.7), typed('typed during the model call', 0.5)])

test('/eval-judge with default flags sends the record\'s input through the shipped prompt, twice', async ($, on) => {
  const w = evalWorld(on, TURN, 37)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  const result = await $.command.run({ ...COMMAND, args: RUN_ARGS })
  expect(result.exitCode ?? 0).toBe(0)
  expect(w.requests.map(r => [r.prompt, r.system])).toEqual([['THE INPUT', PROMPT], ['THE INPUT', PROMPT]])
  expect(w.requests[0]).toMatchObject({ ...JUDGE_REQUEST, systemBlocks: [{ text: PROMPT, cache: true }] })
  const written = lines(w)
  expect(written.map(l => `${String(l.arm)}${String(l.repeat)}`).sort()).toEqual(['base1', 'base2'])
  for (const line of written) {
    expect(line.id).toBe('F0001')
    expect(line.prompt).toBe('THE INPUT')
    expect(line.text).toBe(ANSWERS)
    expect(line.new_outcome).toBe('continue')
    expect(line.usage).toEqual({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  }
  expect(result.text).toContain('calls 2: 1 records × 1 arm × 2 repeats')
})

test('/eval-judge --candidate pairs the prompt file against the shipped prompt on the same input', async ($, on) => {
  const w = evalWorld(on, TURN, 37)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  const result = await $.command.run({ ...COMMAND, args: `${RUN_ARGS} --candidate /in/candidate.txt --repeats 1` })
  expect(w.requests.map(r => [r.prompt, r.system])).toEqual([['THE INPUT', PROMPT], ['THE INPUT', 'A CANDIDATE PROMPT']])
  expect(lines(w).map(l => [l.arm, l.repeat])).toEqual([['base', 1], ['candidate', 1]])
  expect(result.text).toContain('calls 2: 1 records × 2 arms × 1 repeat')
  expect(result.text).toContain('candidate: /in/candidate.txt')
})

test('/eval-judge answers a bad flag with its usage and exit code 2, before any call', async ($, on) => {
  const w = evalWorld(on, TURN, 37)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  for (const flags of ['--candidate', '--repeats 0', '--repeats 1.5', '--repeats x']) {
    const result = await $.command.run({ ...COMMAND, args: `${RUN_ARGS} ${flags}` })
    expect({ flags, code: result.exitCode, usage: (result.text ?? '').startsWith('/eval-judge --key') }).toEqual({ flags, code: 2, usage: true })
  }
  expect(w.requests).toEqual([])
  expect(w.written).toEqual([])
})

test('/eval-extract rebuilds the record from the transcript with no model call, and the key reads it back', async ($, on) => {
  const w = evalWorld(on, TURN, 37)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  const result = await $.command.run({ ...COMMAND, command: 'eval-extract', args: '--log /in/log --out /out/records.jsonl' })
  expect(result.text).toContain('records 1, no transcript or final 0')
  expect(w.requests).toEqual([])
  const key = keyFrom(w.written[0]!)
  expect(key.F0000).toMatchObject({ final: 'Done. Want me to push?', opening: 'second ask', operator_text: 'first ask\nsecond ask' })
  expect(key.F0000!.input).toContain('## Operator message that opened the turn\n\nsecond ask')
})

test('the tail reaches past a long tool output no further than the judge\'s read', () => {
  const file = fileOf([typed('first ask', 300), tool('x'.repeat(TAIL_BYTES), 100), system(95), agent('Done. Want me to push?', 1)])
  const rows = tailAt(marksOf(file), ago(0))!.rows
  expect(rows.map(r => r.timestamp)).toEqual([ago(95), ago(1)])
})
