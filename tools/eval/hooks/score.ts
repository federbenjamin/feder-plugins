import { confidenceOf, decide, parseVerdict } from './judge/judge.ts'

// One judged record of a run, and the score of a run against the graders' labels.

export type RunRecord = {
  id: string
  live: string
  new: 'stop' | 'continue' | null
  new_outcome: string
  conf: number | null
  shape: string | null
  reason: string
  ms: number
  error: string
  minutes_since_operator: number | null
}

export type Grade = { id: string; verdict: 'stop' | 'continue'; case: string; confidence: string }

// What the record needs of a `$.model.complete` result.
export type JudgeReply = { isAnswered: true; text: string } | { isAnswered: false; reason: string; error?: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// The production path's outcome for one reply: what the judge would have logged.
export function runRecordOf(id: string, live: string, reply: JudgeReply, ms: number, minutes: number | null): RunRecord {
  const base = { id, live, ms, minutes_since_operator: minutes }
  const failed = (outcome: string, error: string): RunRecord => ({ ...base, new: null, new_outcome: outcome, conf: null, shape: null, reason: '', error })
  if (!reply.isAnswered) return failed(reply.reason === 'aborted' ? 'pass-timeout' : 'pass-error', reply.error ? `${reply.reason} ${reply.error}` : reply.reason)
  const verdict = parseVerdict(reply.text)
  if (!verdict) return failed('pass-error', `no verdict in: ${reply.text.slice(0, 160)}`)
  const decision = decide(verdict)
  const shape = verdict.fields.shape
  return {
    ...base,
    new: verdict.verdict,
    new_outcome: decision.outcome,
    conf: confidenceOf(verdict.fields),
    shape: typeof shape === 'string' ? shape : null,
    reason: verdict.reason,
    error: decision.outcome === 'pass-error' ? decision.reason : '',
  }
}

// grade-out-*.jsonl texts in order; a later file's line for an id wins.
export function gradesFrom(texts: readonly string[]): Record<string, Grade> {
  const grades: Record<string, Grade> = {}
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let g: unknown
      try {
        g = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(g) || typeof g.id !== 'string' || (g.verdict !== 'stop' && g.verdict !== 'continue')) continue
      grades[g.id] = { id: g.id, verdict: g.verdict, case: String(g.case ?? ''), confidence: String(g.confidence ?? '') }
    }
  }
  return grades
}

const isBlock = (outcome: string) => outcome === 'continue'
const ratio = (n: number, of: number) => `${n}/${of} = ${of === 0 ? 'n/a' : `${((100 * n) / of).toFixed(1)}%`}`

export function scoreRun(run: readonly RunRecord[], key: Record<string, { outcome: string }>, grades: Record<string, Grade>): string {
  const errors = run.filter(r => r.error !== '').length
  const scored = run.filter(r => r.error === '' && grades[r.id] !== undefined && key[r.id] !== undefined)
  const ungraded = run.filter(r => r.error === '').length - scored.length
  const gradeOf = (r: RunRecord) => grades[r.id]!
  const liveOf = (r: RunRecord) => key[r.id]!.outcome
  const lines: string[] = []
  for (const arm of ['live', 'new'] as const) {
    const outcome = (r: RunRecord) => (arm === 'live' ? liveOf(r) : r.new_outcome)
    const stops = scored.filter(r => gradeOf(r).verdict === 'stop')
    const continues = scored.filter(r => gradeOf(r).verdict === 'continue')
    const falseBlocks = stops.filter(r => isBlock(outcome(r))).length
    const caught = continues.filter(r => isBlock(outcome(r))).length
    lines.push(`${arm}: false-block ${ratio(falseBlocks, stops.length)} | catch ${ratio(caught, continues.length)}`)
  }
  const high = scored.filter(r => gradeOf(r).verdict === 'continue' && gradeOf(r).confidence === 'high')
  lines.push(
    `high-confidence continue caught: live ${high.filter(r => isBlock(liveOf(r))).length} new ${high.filter(r => isBlock(r.new_outcome)).length} of ${high.length}`,
  )
  const falseBlocks = scored.filter(r => gradeOf(r).verdict === 'stop' && isBlock(r.new_outcome)).map(r => `${r.id} ${gradeOf(r).case} ${r.conf}`)
  const misses = scored.filter(r => gradeOf(r).verdict === 'continue' && !isBlock(r.new_outcome)).map(r => `${r.id} ${gradeOf(r).confidence} ${gradeOf(r).case}`)
  lines.push(`new false blocks: [${falseBlocks.join(', ')}]`, `new misses: [${misses.join(', ')}]`, `errors ${errors}`)
  if (ungraded > 0) lines.push(`ungraded (not scored): ${ungraded}`)
  return lines.join('\n')
}

// `--key x --ids "a b"` → { key: 'x', ids: 'a b' }; a flag with no value is 'true', a bare word goes to `_`.
export function parseArgs(args: string): Record<string, string> {
  const out: Record<string, string> = {}
  const words = [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => ({ text: m[1] ?? m[2] ?? m[3]!, isQuoted: m[3] === undefined }))
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!w.isQuoted && w.text.startsWith('--') && w.text.length > 2) {
      const value = words[i + 1]
      const isValue = value !== undefined && (value.isQuoted || !value.text.startsWith('--'))
      out[w.text.slice(2)] = isValue ? value.text : 'true'
      if (isValue) i++
    } else {
      out._ = out._ === undefined ? w.text : `${out._} ${w.text}`
    }
  }
  return out
}
