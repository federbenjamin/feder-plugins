import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteRequest, On } from 'claude-code'
import { pushMark, tailAt, tailFact } from '../hooks/extract'
import type { LineMark } from '../hooks/extract'
import { judgeRequest, minutesFact, minutesSinceOperator, parseRows, TAIL_BYTES } from '../hooks/judge/judge'
import type { MinutesGap } from '../hooks/judge/judge'

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

// `grep -a [-b] [-E <pattern>] <path>` over one file, as the host runs it: the offsets in bytes.
function grep(file: string, argv: readonly string[]): string {
  const isOffsets = argv.includes('-b')
  const e = argv.indexOf('-E')
  const pattern = new RegExp(e >= 0 ? argv[e + 1]! : argv[argv.length - 2]!)
  let offset = 0
  let out = ''
  for (const line of linesOf(file)) {
    if (pattern.test(line)) out += `${isOffsets ? `${offset}:` : ''}${line}\n`
    offset += bytesOf(line) + 1
  }
  return out
}

function marksOf(file: string): LineMark[] {
  const marks: LineMark[] = []
  for (const line of linesOf(grep(file, ['grep', '-a', '-b', '', 'f']))) pushMark(marks, line)
  return marks
}

// The oracle, written apart from the code under test: the file as the judge read it, its last
// `tailBytes` bytes as `tail -c` gives them, through the judge's own parser and minutesFact at
// the judge's clock. The judge read right after the turn's last agent row with text (timed no
// later than the firing stamp plus its 2 s lag), else the stamp is all there is: the file ends at
// the last line timed before it and the clock is the stamp.
const LAG_MS = 2000

function hasText(row: Record<string, unknown>): boolean {
  if (row.type !== 'assistant' || row.isSidechain) return false
  const content = (row.message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) && content.some(b => (b as { type?: string; text?: string }).type === 'text' && ((b as { text?: string }).text ?? '').trim() !== '')
}

function productionFact(file: string, ts: string, tailBytes: number): { gap: MinutesGap | null; cut: 'answer' | 'stamp' } {
  const stamp = Date.parse(ts)
  let answerEnd = -1
  let answerAt = 0
  let stampEnd = 0
  let offset = 0
  for (const line of linesOf(file)) {
    offset += bytesOf(line) + 1
    const row = JSON.parse(line) as Record<string, unknown>
    const at = Date.parse(String(row.timestamp))
    if (hasText(row) && at <= stamp + LAG_MS) {
      answerEnd = offset
      answerAt = at
    }
    if (at < stamp) stampEnd = offset
  }
  const end = answerEnd >= 0 ? answerEnd : stampEnd
  const tail = new TextDecoder().decode(encoder.encode(file).slice(Math.max(0, end - tailBytes), end))
  return { gap: minutesFact(parseRows(tail), new Date(answerEnd >= 0 ? answerAt : stamp)), cut: answerEnd >= 0 ? 'answer' : 'stamp' }
}

// Multi-byte text in the rows, a row with no time, a sidechain row, a typed row after the
// firing: every cut of the tail and every firing time must give the judge's own fact.
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

test('every cut of the tail and every firing time gives the minutes fact the judge sent, lower-bound flag and cut included', () => {
  const file = fileOf(ROWS)
  const marks = marksOf(file)
  // ago(299.5) has no agent row before it (stamp cut); the others end at 299 or 1 minutes back,
  // and 1 minute minus 2.5 s / plus exactly 2 s straddle the answer's lag window.
  const firings = [ago(0), ago(2), ago(96), ago(105), ago(119), ago(200), ago(299.5), ago(-10), at(1, -2500), at(1, -2000), at(1, -1500), at(299, -2000)]
  let lowerBounds = 0
  let exact = 0
  const cuts = new Set<string>()
  for (const ts of firings) {
    for (let tailBytes = 1; tailBytes <= bytesOf(file) + 1; tailBytes++) {
      const want = productionFact(file, ts, tailBytes)
      expect({ ts, tailBytes, fact: tailFact(marks, ts, tailBytes) }).toEqual({ ts, tailBytes, fact: want })
      cuts.add(want.cut)
      if (want.gap?.isLowerBound) lowerBounds++
      else if (want.gap) exact++
    }
  }
  expect([...cuts].sort()).toEqual(['answer', 'stamp'])
  expect(lowerBounds).toBeGreaterThan(0)
  expect(exact).toBeGreaterThan(0)
})

test('a turn whose last agent row is before the firing ends there: the nudge and a prompt typed during the model call stay out, and the clock is that row', () => {
  // The judge read at the agent row (10 min back). The stamp is later (8.5): the nudge and the
  // prompt typed meanwhile are timed before it, and none was in the file the judge read.
  const rows = [typed('the ask', 200), agent('Done. Want me to push?', 10), nudge(9.5), typed('typed during the model call', 9.9)]
  const marks = marksOf(fileOf(rows))
  const tail = tailAt(marks, ago(8.5))!
  expect(tail.cut).toBe('answer')
  expect(tail.now).toBe(T0 - 10 * 60_000)
  expect(tail.rows.map(r => r.timestamp)).toEqual([ago(200), ago(10)])
  // 200 - 10 at the row's clock; the stamp's clock would say 191, the late prompt 0.
  expect(tailFact(marks, ago(8.5))).toEqual({ gap: { minutes: 190, isLowerBound: false }, cut: 'answer' })
})

test('the agent row counts as the read when timed up to 2 s after the stamp, not past it', () => {
  const marks = marksOf(fileOf([typed('ask', 30), agent('Done.', 10)]))
  const agentAt = T0 - 10 * 60_000
  expect(tailFact(marks, new Date(agentAt - 2000).toISOString())).toEqual({ gap: { minutes: 20, isLowerBound: false }, cut: 'answer' })
  // 1 ms past the lag: the agent row is not the one the judge read; the file ends at the stamp
  // and its clock is the stamp's, 1 ms short of 20 minutes after the typed row.
  const late = tailFact(marks, new Date(agentAt - 2001).toISOString())
  expect(late).toEqual({ gap: { minutes: 19, isLowerBound: false }, cut: 'stamp' })
  expect(tailAt(marks, new Date(agentAt - 2001).toISOString())!.now).toBe(agentAt - 2001)
})

test('a firing with no agent row with text falls back to the stamp: its clock, the lines timed before it', () => {
  const toolUse = { type: 'assistant', timestamp: ago(35), message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }
  const blank = agent('  \n ', 34)
  const sidechain = { ...agent('a subagent answer', 33), isSidechain: true }
  const marks = marksOf(fileOf([typed('the ask', 50), toolUse, blank, sidechain, tool('out', 32), typed('after the stamp', 5)]))
  expect(tailAt(marks, ago(30))!.cut).toBe('stamp')
  expect(tailAt(marks, ago(30))!.now).toBe(T0 - 30 * 60_000)
  expect(tailFact(marks, ago(30))).toEqual({ gap: { minutes: 20, isLowerBound: false }, cut: 'stamp' })
})

test('only an agent row with text is an answer mark', () => {
  const marks = marksOf(
    fileOf([agent('says something', 9), { type: 'assistant', timestamp: ago(8), message: { content: [{ type: 'tool_use', id: 't' }] } }, agent('   ', 7), { ...agent('side', 6), isSidechain: true }, typed('ask', 5), tool('out', 4)]),
  )
  expect(marks.map(m => m.isAnswer)).toEqual([true, false, false, false, false, false])
})

test('a firing whose typed rows fell before the tail gets the lower bound, where the whole file would give the exact gap', () => {
  const file = fileOf(ROWS.slice(0, -1))
  const marks = marksOf(file)
  const fromSystemRow = bytesOf(linesOf(file).slice(7).join('\n') + '\n')
  // The read was at the agent row (1 min back), so the oldest row, 95 back, is 94 behind its clock.
  expect(tailFact(marks, ago(0), fromSystemRow)).toEqual({ gap: { minutes: 94, isLowerBound: true }, cut: 'answer' })
  expect(minutesSinceOperator(parseRows(file), new Date(T0))).toBe(120)
  // One byte less cuts into the system row, so the agent's own row is the oldest whole one.
  expect(tailFact(marks, ago(0), fromSystemRow - 1)).toEqual({ gap: { minutes: 0, isLowerBound: true }, cut: 'answer' })
  // With the typed row inside the tail the gap is exact.
  expect(tailFact(marks, ago(0), bytesOf(file))).toEqual({ gap: { minutes: 119, isLowerBound: false }, cut: 'answer' })
})

test('a line ends where the host says the next begins, whatever its decoded text counts', () => {
  // One raw byte the host could not decode reads back as U+FFFD, three bytes as text.
  const first = JSON.stringify(typed('a byte � the host kept raw', 30))
  const next = bytesOf(first) + 1 - 2
  const marks: LineMark[] = []
  pushMark(marks, `0:${first}`)
  pushMark(marks, `${next}:${JSON.stringify(typed('after the firing', -5))}`)
  expect(tailFact(marks, ago(0), next)).toEqual({ gap: { minutes: 30, isLowerBound: false }, cut: 'stamp' })
  expect(tailFact(marks, ago(0), next - 1)).toEqual({ gap: null, cut: 'stamp' })
})

test('no transcript lines or no line before the firing give no gap; no usable firing time gives no tail', () => {
  expect(tailFact([], ago(0))).toEqual({ gap: null, cut: 'stamp' })
  const marks = marksOf(fileOf([typed('ask', 5)]))
  expect(tailAt(marks, ago(10))).toEqual({ rows: [], now: T0 - 10 * 60_000, cut: 'stamp' })
  expect(tailFact(marks, ago(10))).toEqual({ gap: null, cut: 'stamp' })
  expect(tailFact(marks, null)).toBeNull()
  expect(tailFact(marks, 'not a time')).toBeNull()
  expect(tailAt(marks, null)).toBeNull()
})

const done = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const PATH = '/home/u/.claude/projects/-work-app/s1.jsonl'
const RECORD = { id: 'F0001', ts: ago(0), session: 's1', outcome: 'stop', judge_reason: 'x', final: 'Done. Want me to push?', opening: 'second ask', context_users: ['first ask'] }
const RUN_ARGS = '--key /in/key.jsonl --ids /in/ids.txt --graders /in/grades.jsonl --out /out/run.jsonl'
const COMMAND = { command: 'eval-judge', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

function evalWorld(on: On, transcript: string, piece: number) {
  mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u' })
  const files: Record<string, string> = {
    '/in/key.jsonl': `${JSON.stringify(RECORD)}\n`,
    '/in/ids.txt': 'F0001\n',
    '/in/grades.jsonl': '{"id":"F0001","verdict":"continue","case":"offer","confidence":"high"}\n',
  }
  const w = { requests: [] as ModelCompleteRequest[], written: [] as string[] }
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: T0, isLink: false } }))
  on('fs.write', async () => ({ value: undefined }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'tee') w.written.push(e.init?.stdin ?? '')
    return { value: { ...done, stdout: e.argv[0] === 'find' && e.argv.at(-1) === 's1.jsonl' ? `${PATH}\n` : '' } }
  })
  // `cat` of an input, or `grep` of the transcript, in pieces that cut lines anywhere.
  on('process.spawn', async function* (_$, e) {
    const out = e.argv[0] === 'cat' ? (files[e.argv[1]!] ?? '') : grep(transcript, e.argv)
    for (let i = 0; i < out.length; i += piece) yield { stream: 'stdout' as const, text: out.slice(i, i + piece) }
    return { value: { code: e.argv[0] === 'cat' && files[e.argv[1]!] === undefined ? 1 : 0, signal: null } }
  })
  on('model.complete', async (_$, e) => {
    w.requests.push(e)
    return { value: { isAnswered: true, text: '{"verdict":"stop","confidence":0.9,"reason":"fine"}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never }
  })
  return w
}


const lines = (w: { written: string[] }) =>
  w.written[0]!
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as Record<string, unknown>)

test('/eval-judge sends and records the fact the judge read from its 8 MB tail, not the whole transcript', async ($, on) => {
  // The typed rows are older than a tool output longer than the tail, so the judge's tail starts
  // at the system row 95 minutes back; the whole file says 120. The read was at the agent row.
  const transcript = fileOf([typed('first ask', 300), typed('second ask', 120), tool('x'.repeat(TAIL_BYTES), 100), system(95), agent('Done. Want me to push?', 1)])
  const gap = { minutes: 94, isLowerBound: true }
  expect(productionFact(transcript, RECORD.ts, TAIL_BYTES).gap).toEqual(gap)
  const w = evalWorld(on, transcript, 65_536)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  const result = await $.command.run({ ...COMMAND, args: `${RUN_ARGS} --repeats 1` })
  expect(result.text).toContain('no transcript: 0')
  expect(w.requests).toHaveLength(2)
  expect(w.requests).toContainEqual(judgeRequest(RECORD.final, RECORD.opening, RECORD.context_users, gap, false))
  expect(w.requests).toContainEqual(judgeRequest(RECORD.final, RECORD.opening, RECORD.context_users, gap, true))
  for (const line of lines(w)) {
    expect(line.minutes_since_operator).toBe(94)
    expect(line.is_lower_bound).toBe(true)
  }
})

// Read at the agent row (1 min back); a prompt typed during the model call (0.5 back) is after it.
const TURN = fileOf([typed('first ask', 300), tool('x'.repeat(1000), 100), typed('second ask', 7), agent('Done. Want me to push?', 1), nudge(0.7), typed('typed during the model call', 0.5)])

test('/eval-judge with default flags sends an off and an on request for each of two repeats, with the rebuilt gap', async ($, on) => {
  const w = evalWorld(on, TURN, 37)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  const result = await $.command.run({ ...COMMAND, args: RUN_ARGS })
  expect(result.exitCode ?? 0).toBe(0)
  // Typed 7 min back, read at the agent row 1 back: 6 (the stamp's clock says 7, the late prompt 0).
  const gap = { minutes: 6, isLowerBound: false }
  const off = judgeRequest(RECORD.final, RECORD.opening, RECORD.context_users, gap, false)
  const onRequest = judgeRequest(RECORD.final, RECORD.opening, RECORD.context_users, gap, true)
  expect(off).not.toEqual(onRequest)
  expect(w.requests).toHaveLength(4)
  expect(w.requests.filter(r => r.system === off.system && r.prompt === off.prompt)).toHaveLength(2)
  expect(w.requests.filter(r => r.system === onRequest.system && r.prompt === onRequest.prompt)).toHaveLength(2)
  for (const r of w.requests) expect(r).toEqual(r.system === off.system ? off : onRequest)
  expect(onRequest.prompt).toContain("Minutes since the operator's last typed message: 6")

  const written = lines(w)
  expect(written.map(l => `${String(l.arm)}${String(l.repeat)}`).sort()).toEqual(['off1', 'off2', 'on1', 'on2'])
  for (const line of written) {
    expect(line.id).toBe('F0001')
    expect(line.prompt).toBe(line.arm === 'on' ? onRequest.prompt : off.prompt)
    expect(line.text).toBe('{"verdict":"stop","confidence":0.9,"reason":"fine"}')
    expect(line.minutes_since_operator).toBe(6)
    expect(line.is_lower_bound).toBe(false)
    expect(line.usage).toEqual({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  }
  expect(result.text).toContain("minutes cut at the judge's read: 1 | at the log stamp: 0 | no transcript: 0")
  expect(result.text).toContain('calls 4: 1 records × 2 arms × 2 repeats')
})

test('/eval-judge --arms on --repeats 1 sends exactly one request, the on arm', async ($, on) => {
  const w = evalWorld(on, TURN, 37)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.command.run({ ...COMMAND, args: `${RUN_ARGS} --arms on --repeats 1` })
  expect(w.requests).toEqual([judgeRequest(RECORD.final, RECORD.opening, RECORD.context_users, { minutes: 6, isLowerBound: false }, true)])
  expect(lines(w).map(l => [l.arm, l.repeat])).toEqual([['on', 1]])
})

test('/eval-judge falls back to the stamp when the transcript has no agent row with text', async ($, on) => {
  const w = evalWorld(on, fileOf([typed('first ask', 300), typed('second ask', 7), tool('out', 3)]), 37)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  const result = await $.command.run({ ...COMMAND, args: `${RUN_ARGS} --arms on --repeats 1` })
  expect(w.requests).toEqual([judgeRequest(RECORD.final, RECORD.opening, RECORD.context_users, { minutes: 7, isLowerBound: false }, true)])
  expect(result.text).toContain("minutes cut at the judge's read: 0 | at the log stamp: 1 | no transcript: 0")
})

test('/eval-judge answers a bad --arms or --repeats with its usage and exit code 2, before any call', async ($, on) => {
  const w = evalWorld(on, TURN, 37)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  for (const flags of ['--arms bogus', '--arms off,bogus', '--repeats 0', '--repeats 1.5', '--repeats x']) {
    const result = await $.command.run({ ...COMMAND, args: `${RUN_ARGS} ${flags}` })
    expect({ flags, code: result.exitCode, usage: (result.text ?? '').startsWith('/eval-judge --key') }).toEqual({ flags, code: 2, usage: true })
  }
  expect(w.requests).toEqual([])
  expect(w.written).toEqual([])
})
