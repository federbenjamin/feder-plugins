import { framingAndPrior, minutesSinceOperator, parseRows, splitTurn } from './judge/judge.ts'
import { parseFiringLine } from './judge/shared/firing.ts'
import type { FiringLine } from './judge/shared/firing.ts'
import { typedText } from './judge/shared/typed.ts'
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

export function operatorRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  return rows.filter(row => typedText(row, { sdk: true }) !== null)
}

// Minutes from the operator's last typed row before `ts` to `ts`, as the judge would have read it then.
export function minutesBefore(rows: readonly TranscriptRow[], ts: string | null): number | null {
  const at = ts === null ? Number.NaN : Date.parse(ts)
  if (Number.isNaN(at)) return null
  return minutesSinceOperator(
    rows.filter(row => timeOf(row) < at),
    new Date(at),
  )
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
