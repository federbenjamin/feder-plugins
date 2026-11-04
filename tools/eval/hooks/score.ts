import { judgeOutcome } from './judge/decide.ts'
import type { JudgeReply, Said } from './judge/decide.ts'
import { isRecord } from './judge/shared/typed.ts'

// One model call of a run, the graders' labels, and the command's arguments.

// `base`: the shipped prompt. `candidate`: the prompt under test, on the same inputs.
export type Arm = 'base' | 'candidate'
export const ARMS: readonly Arm[] = ['base', 'candidate']

export type Call = { id: string; arm: Arm; repeat: number }

export type RunRecord = Call & {
  live: string
  new: 'stop' | 'continue' | null
  new_outcome: string
  reason: string
  text: string
  ms: number
  error: string
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

// The production path's outcome for one reply (decide.ts's judgeOutcome): what the judge would
// have logged, before the gates that need a live session (the prompt box, a newer turn).
export function runRecordOf(call: Call, live: string, reply: JudgeReply, ms: number, said: Said): RunRecord {
  const base = { ...call, live, ms, text: reply.isAnswered ? reply.text : '' }
  const { outcome, reason, decision } = judgeOutcome(reply, said)
  if (decision === null) return { ...base, new: null, new_outcome: outcome, reason: '', error: reason }
  return { ...base, new: decision.decision, new_outcome: outcome, reason, error: '' }
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
