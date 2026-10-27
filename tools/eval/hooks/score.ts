import { confidenceOf, judgeOutcome } from './judge/judge.ts'
import type { JudgeReply, MinutesGap } from './judge/judge.ts'
import { isRecord } from './judge/shared/typed.ts'

// One model call of a run, the graders' labels, and the command's arguments.

// `off`: the round-3 request alone. `on`: the same request with the minutes fact.
export type Arm = 'off' | 'on'
export const ARMS: readonly Arm[] = ['off', 'on']

export type Call = { id: string; arm: Arm; repeat: number }

export type RunRecord = Call & {
  live: string
  new: 'stop' | 'continue' | null
  new_outcome: string
  conf: number | null
  shape: string | null
  reason: string
  text: string
  ms: number
  error: string
  minutes_since_operator: number | null
  is_lower_bound: boolean
}

export type Grade = { id: string; verdict: 'stop' | 'continue'; case: string; confidence: string }

export type { JudgeReply }

// Every call of a run: each repeat of each record in each arm, a record's arms side by side so
// both meet the same API conditions.
export function callsOf(ids: readonly string[], arms: readonly Arm[], repeats: number): Call[] {
  const calls: Call[] = []
  for (let repeat = 1; repeat <= repeats; repeat++) for (const id of ids) for (const arm of arms) calls.push({ id, arm, repeat })
  return calls
}

// The production path's outcome for one reply (judge.ts's judgeOutcome): what the judge would
// have logged. `gap` is the record's minutes fact, kept on both arms' calls.
export function runRecordOf(call: Call, live: string, reply: JudgeReply, ms: number, gap: MinutesGap | null): RunRecord {
  const base = { ...call, live, ms, text: reply.isAnswered ? reply.text : '', minutes_since_operator: gap?.minutes ?? null, is_lower_bound: gap?.isLowerBound ?? false }
  const { outcome, reason, verdict } = judgeOutcome(reply)
  if (verdict === null) return { ...base, new: null, new_outcome: outcome, conf: null, shape: null, reason: '', error: reason }
  const shape = verdict.fields.shape
  return {
    ...base,
    new: verdict.verdict,
    new_outcome: outcome,
    conf: confidenceOf(verdict.fields),
    shape: typeof shape === 'string' ? shape : null,
    reason: verdict.reason,
    error: outcome === 'pass-error' ? reason : '',
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
