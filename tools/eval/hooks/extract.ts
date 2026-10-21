import { assistantText, framingAndPrior, minutesFact, parseRows, splitTurn, TAIL_BYTES } from './judge/judge.ts'
import type { MinutesGap } from './judge/judge.ts'
import { parseFiringLine } from './judge/shared/firing.ts'
import type { FiringLine } from './judge/shared/firing.ts'
import { parseRow, typedText } from './judge/shared/typed.ts'
import type { TranscriptRow } from './judge/shared/typed.ts'

// Records of judged stops: what the judge saw at each firing, rebuilt from the session's
// transcript through the judge's own parser. Also the key the run reads them back from.

export type EvalRecord = {
  id: string
  ts: string | null
  session: string | null
  outcome: string
  judge_reason: string
  final: string | null
  opening: string
  context_users: string[]
}

export const JUDGED: readonly string[] = ['continue', 'stop', 'stop-lowconf']

// Pre-filter for `grep -a -E`: the rows splitTurn and typedText read. A tool result is a user row
// neither ever reads, and the bulk of a long transcript.
export const ROW_GREP = '"type":"(user|assistant)"|"queued_command"'
const TOOL_RESULT = '"type":"tool_result"'

// Within this of the firing time an assistant row is the one the judge read (the log line is
// written after the model call).
const FIRING_LAG_MS = 2000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const timeOf = (row: TranscriptRow): number => (typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN)

export function transcriptRows(grepped: string): TranscriptRow[] {
  return parseRows(
    grepped
      .split('\n')
      .filter(line => !line.includes(TOOL_RESULT))
      .join('\n'),
  )
}

// One transcript line as the judge's tail would hold it: its bytes in the file, its row's time,
// whether it is an agent row with text (the judge reads right after the turn's last one), and the
// row cut to what minutesFact reads (whole when the person typed it, else its time). A null row
// is a line parseRow drops (cut, not an object, a sidechain row).
export type LineMark = { start: number; end: number; at: number; isAnswer: boolean; row: TranscriptRow | null }

function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

// Adds one line of `grep -a -b ''` output, `<byte offset>:<line>`. The host counts the offsets,
// so a line ends where the next begins; only the last line's end is its own length.
export function pushMark(marks: LineMark[], grepLine: string): void {
  const colon = grepLine.indexOf(':')
  const start = colon > 0 ? Number(grepLine.slice(0, colon)) : Number.NaN
  if (!Number.isInteger(start)) return
  const text = grepLine.slice(colon + 1)
  const prev = marks.at(-1)
  if (prev) prev.end = start
  const row = parseRow(text)
  const kept = row === null || typedText(row, { sdk: true }) !== null ? row : 'timestamp' in row ? { timestamp: row.timestamp } : {}
  const isAnswer = row !== null && assistantText(row).trim() !== ''
  marks.push({ start, end: start + utf8Length(text) + 1, at: row === null ? lineTime(text) : timeOf(row), isAnswer, row: kept })
}

// The time of a line parseRow drops: a sidechain row was still in the file the judge read.
function lineTime(text: string): number {
  try {
    const v: unknown = JSON.parse(text)
    return isRecord(v) ? timeOf(v) : Number.NaN
  } catch {
    return Number.NaN
  }
}

// Where the rebuilt file ends. `answer`: at the turn's last agent row with text, the moment the
// judge read; its clock is that row's time. `stamp`: no such row, so at the firing log's stamp,
// which lies after the read by the model call and any rows written meanwhile.
export type Cut = 'answer' | 'stamp'

// The rows the judge's `tail -c tailBytes` read at the firing logged at `ts`, and its clock then:
// the file ended after the turn's last agent row (else after the last line timed before `ts`),
// and the line the tail's first byte cut into does not parse. null with no time.
export function tailAt(marks: readonly LineMark[], ts: string | null, tailBytes: number = TAIL_BYTES): { rows: TranscriptRow[]; now: number; cut: Cut } | null {
  const at = ts === null ? Number.NaN : Date.parse(ts)
  if (Number.isNaN(at)) return null
  let answer = -1
  let before = -1
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!
    if (m.at < at) before = i
    if (m.isAnswer && m.at <= at + FIRING_LAG_MS) answer = i
  }
  const cut: Cut = answer >= 0 ? 'answer' : 'stamp'
  const last = answer >= 0 ? answer : before
  const now = answer >= 0 ? marks[answer]!.at : at
  if (last < 0) return { rows: [], now, cut }
  const from = Math.max(0, marks[last]!.end - tailBytes)
  const rows: TranscriptRow[] = []
  for (let i = 0; i <= last; i++) {
    const m = marks[i]!
    if (m.start >= from && m.row !== null) rows.push(m.row)
  }
  return { rows, now, cut }
}

// The minutes fact the judge sent at the firing logged at `ts`: minutesFact over the tail it
// read then, at its clock then, lower-bound flag included; with where the rebuild cut the file.
export function tailFact(marks: readonly LineMark[], ts: string | null, tailBytes: number = TAIL_BYTES): { gap: MinutesGap | null; cut: Cut } | null {
  const tail = tailAt(marks, ts, tailBytes)
  return tail === null ? null : { gap: minutesFact(tail.rows, new Date(tail.now)), cut: tail.cut }
}

// The judged lines of a firing log; the id is the line's index, as the graded set's ids are.
export function firingsOf(log: string): { id: string; firing: FiringLine }[] {
  return log.split('\n').flatMap((line, i) => {
    const firing = parseFiringLine(line)
    return firing && JUDGED.includes(firing.outcome) ? [{ id: `F${String(i).padStart(4, '0')}`, firing }] : []
  })
}

// `rows` null: the session's transcript is gone; the record keeps its log fields with no final.
export function extractRecord(id: string, firing: FiringLine, rows: readonly TranscriptRow[] | null): EvalRecord {
  const base = { id, ts: firing.at, session: firing.session, outcome: firing.outcome, judge_reason: firing.reason }
  if (rows === null) return { ...base, final: null, opening: '', context_users: [] }
  const until = Date.parse(firing.at) + FIRING_LAG_MS
  const { final, opening, prior } = splitTurn(
    rows.filter(row => timeOf(row) <= until),
    undefined,
  )
  return { ...base, final: final === '' ? null : final, opening, context_users: final === '' ? [] : framingAndPrior(prior) }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

function recordOf(v: unknown): EvalRecord | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.outcome !== 'string') return null
  const text = (x: unknown) => (typeof x === 'string' ? x : null)
  return {
    id: v.id,
    ts: text(v.ts),
    session: text(v.session),
    outcome: v.outcome,
    judge_reason: text(v.judge_reason) ?? '',
    final: text(v.final),
    opening: text(v.opening) ?? '',
    context_users: strings(v.context_users),
  }
}

// The key by id, from either shape: a JSON object of records by id (a grading key), or the
// JSON lines /eval-extract writes.
export function keyFrom(text: string): Record<string, EvalRecord> {
  const key: Record<string, EvalRecord> = {}
  let whole: unknown
  try {
    whole = JSON.parse(text)
  } catch {
    whole = undefined
  }
  const values = isRecord(whole) ? Object.values(whole) : []
  const isById = values.length > 0 && values.every(v => recordOf(v) !== null)
  const candidates = isById
    ? values
    : text.split('\n').flatMap(line => {
        try {
          return line.trim() === '' ? [] : [JSON.parse(line) as unknown]
        } catch {
          return []
        }
      })
  for (const v of candidates) {
    const r = recordOf(v)
    if (r) key[r.id] = r
  }
  return key
}
