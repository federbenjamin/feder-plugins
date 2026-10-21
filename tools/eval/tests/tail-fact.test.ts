import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteRequest, On } from 'claude-code'
import { pushMark, tailMinutesFact, tailRowsAt } from '../hooks/extract'
import type { LineMark } from '../hooks/extract'
import { judgeRequest, minutesFact, minutesSinceOperator, parseRows, TAIL_BYTES } from '../hooks/judge/judge'

const T0 = Date.parse('2026-10-15T05:10:46Z')
const ago = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString()
const typed = (text: string, minutes: number) => ({ type: 'user', timestamp: ago(minutes), message: { role: 'user', content: text }, origin: { kind: 'human' }, promptSource: 'typed' })
const agent = (text: string, minutes: number) => ({ type: 'assistant', timestamp: ago(minutes), message: { content: [{ type: 'text', text }] } })
const tool = (text: string, minutes: number) => ({ type: 'user', timestamp: ago(minutes), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } })
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

// What the judge read at `ts`: the file as it stood (every line timed before `ts`), its last
// `tailBytes` bytes as `tail -c` gives them, through the judge's own parser and minutesFact.
function productionFact(file: string, ts: string, tailBytes: number) {
  let end = 0
  let offset = 0
  for (const line of linesOf(file)) {
    offset += bytesOf(line) + 1
    if (Date.parse(String((JSON.parse(line) as { timestamp?: unknown }).timestamp)) < Date.parse(ts)) end = offset
  }
  const tail = new TextDecoder().decode(encoder.encode(file).slice(Math.max(0, end - tailBytes), end))
  return minutesFact(parseRows(tail), new Date(ts))
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

test('every cut of the tail and every firing time gives the minutes fact the judge sent, lower-bound flag included', () => {
  const file = fileOf(ROWS)
  const marks = marksOf(file)
  const firings = [ago(0), ago(2), ago(96), ago(105), ago(119), ago(200), ago(299.5), ago(-10)]
  let lowerBounds = 0
  let exact = 0
  for (const ts of firings) {
    for (let tailBytes = 1; tailBytes <= bytesOf(file) + 1; tailBytes++) {
      const want = productionFact(file, ts, tailBytes)
      expect({ ts, tailBytes, fact: tailMinutesFact(marks, ts, tailBytes) }).toEqual({ ts, tailBytes, fact: want })
      if (want?.isLowerBound) lowerBounds++
      else if (want) exact++
    }
  }
  expect(lowerBounds).toBeGreaterThan(0)
  expect(exact).toBeGreaterThan(0)
})

test('a firing whose typed rows fell before the tail gets the lower bound, where the whole file would give the exact gap', () => {
  const file = fileOf(ROWS.slice(0, -1))
  const marks = marksOf(file)
  const fromSystemRow = bytesOf(linesOf(file).slice(7).join('\n') + '\n')
  expect(tailMinutesFact(marks, ago(0), fromSystemRow)).toEqual({ minutes: 95, isLowerBound: true })
  expect(minutesSinceOperator(parseRows(file), new Date(T0))).toBe(120)
  // One byte less cuts into the system row, so the agent's final row is the oldest whole one.
  expect(tailMinutesFact(marks, ago(0), fromSystemRow - 1)).toEqual({ minutes: 1, isLowerBound: true })
  // With the typed row inside the tail the gap is exact.
  expect(tailMinutesFact(marks, ago(0), bytesOf(file))).toEqual({ minutes: 120, isLowerBound: false })
})

test('a line ends where the host says the next begins, whatever its decoded text counts', () => {
  // One raw byte the host could not decode reads back as U+FFFD, three bytes as text.
  const first = JSON.stringify(typed('a byte � the host kept raw', 30))
  const next = bytesOf(first) + 1 - 2
  const marks: LineMark[] = []
  pushMark(marks, `0:${first}`)
  pushMark(marks, `${next}:${JSON.stringify(typed('after the firing', -5))}`)
  expect(tailMinutesFact(marks, ago(0), next)).toEqual({ minutes: 30, isLowerBound: false })
  expect(tailMinutesFact(marks, ago(0), next - 1)).toBeNull()
})

test('no transcript lines, no line before the firing, or no firing time give no fact', () => {
  expect(tailMinutesFact([], ago(0))).toBeNull()
  const marks = marksOf(fileOf([typed('ask', 5)]))
  expect(tailRowsAt(marks, ago(10))).toEqual([])
  expect(tailMinutesFact(marks, ago(10))).toBeNull()
  expect(tailMinutesFact(marks, null)).toBeNull()
  expect(tailMinutesFact(marks, 'not a time')).toBeNull()
})

const done = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const PATH = '/home/u/.claude/projects/-work-app/s1.jsonl'
const RECORD = { id: 'F0001', ts: ago(0), session: 's1', outcome: 'stop', judge_reason: 'x', final: 'Done. Want me to push?', opening: 'second ask', context_users: ['first ask'] }

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

test('/eval-judge sends and records the fact the judge read from its 8 MB tail, not the whole transcript', async ($, on) => {
  // The typed rows are older than a tool output longer than the tail, so the judge's tail starts
  // at the system row 95 minutes back; the whole file says 120.
  const transcript = fileOf([typed('first ask', 300), typed('second ask', 120), tool('x'.repeat(TAIL_BYTES), 100), system(95), agent('Done. Want me to push?', 1)])
  expect(productionFact(transcript, RECORD.ts, TAIL_BYTES)).toEqual({ minutes: 95, isLowerBound: true })
  const w = evalWorld(on, transcript, 65_536)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  const result = await $.command.run({ command: 'eval-judge', args: '--key /in/key.jsonl --ids /in/ids.txt --graders /in/grades.jsonl --out /out/run.jsonl', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(result.text).toContain('no transcript: 0')
  expect(w.requests).toEqual([judgeRequest(RECORD.final, RECORD.opening, RECORD.context_users, { minutes: 95, isLowerBound: true })])
  expect(JSON.parse(w.written[0]!.trim()).minutes_since_operator).toBe(95)
})

test('/eval-judge gives the exact gap when the typed row is inside the tail, read in pieces of any size', async ($, on) => {
  const transcript = fileOf([typed('first ask', 300), tool('x'.repeat(1000), 100), typed('second ask', 7), agent('Done. Want me to push?', 1)])
  const w = evalWorld(on, transcript, 37)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.command.run({ command: 'eval-judge', args: '--key /in/key.jsonl --ids /in/ids.txt --graders /in/grades.jsonl --out /out/run.jsonl', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(w.requests).toEqual([judgeRequest(RECORD.final, RECORD.opening, RECORD.context_users, { minutes: 7, isLowerBound: false })])
  expect(JSON.parse(w.written[0]!.trim()).minutes_since_operator).toBe(7)
})
