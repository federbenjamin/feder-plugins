import type { ModelCompleteResult, ModelUsage } from 'claude-code'
import type { Source } from '../types'
import type { Calls } from './settings.ts'
import { parseReply } from './summary.ts'
import type { Previous } from './summary.ts'

// The summary call's decisions, apart from its I/O in register.ts: what a reply leaves, the
// session's running totals, and the firing line's reason.

export type CallOutcome = 'summary' | 'parse-partial' | 'parse-failed' | 'api-error' | 'aborted'

// `texts` is what the capture records; `isTaken` says the band takes them, and only then does the
// call count as having summarized its window. judge.ts's mapping: an unanswered reply cut by its
// signal or timeout is `aborted`, any other unanswered one an `api-error` naming why.
export type ReplyResult = { outcome: CallOutcome; failure: string; texts: Previous; isTaken: boolean }

export function replyResult(reply: ModelCompleteResult, previous: Previous, candidates: readonly string[]): ReplyResult {
  if (!reply.isAnswered) {
    if (reply.reason === 'aborted') return { outcome: 'aborted', failure: '', texts: previous, isTaken: false }
    const failure = `${reply.reason} ${reply.reason === 'api-error' ? reply.error : ''}`.trimEnd()
    return { outcome: 'api-error', failure, texts: previous, isTaken: false }
  }
  const parsed = parseReply(reply.text, previous, candidates)
  return {
    outcome: parsed.outcome,
    failure: '',
    texts: { title: parsed.title, soFar: parsed.soFar, now: parsed.now, files: parsed.files },
    isTaken: parsed.outcome !== 'parse-failed',
  }
}

export function addCall(calls: Calls, usage: ModelUsage, usd: number): Calls {
  return {
    count: calls.count + 1,
    input: calls.input + usage.input_tokens,
    output: calls.output + usage.output_tokens,
    cached: calls.cached + usage.cache_read_input_tokens,
    usd: calls.usd + usd,
  }
}

// Every firing line's reason leads with these six fields in this order, zeros where no call was
// made: the README's read-back splits the line by position.
export function firingReason(r: { source: Source; variant: string; usage?: ModelUsage; usd?: number; failure?: string }): string {
  const u = r.usage
  const fields = `source=${r.source} variant=${r.variant} in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} cached=${u?.cache_read_input_tokens ?? 0} usd=${(r.usd ?? 0).toFixed(4)}`
  return r.failure ? `${fields} ${r.failure}` : fields
}
