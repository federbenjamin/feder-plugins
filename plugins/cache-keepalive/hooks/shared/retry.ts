// How a plugin retries a model call that came back unanswered, and when a run of many calls has
// failed as a whole: stop-judge's derive readers and morning-report's summaries share it.

export type CallFailure = { reason: string; status?: number | null; error?: string }

// Errors no wait will clear: retrying only repeats them, so the run stops at the first one.
const PERMANENT_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
  'invalid_request',
  'model_not_found',
])

export const RETRY_DELAYS_S = [30, 60, 120, 240] as const

export function isPermanent(f: CallFailure): boolean {
  return f.error !== undefined && PERMANENT_ERRORS.has(f.error)
}

// Seconds to wait before retry number `attempt` (0-based), or undefined to give up. Rate limits,
// overload, server errors and dropped connections back off and retry; a timed-out call gets one
// retry, since a second timeout costs another full wait.
export function retryDelayS(f: CallFailure, attempt: number): number | undefined {
  if (isPermanent(f)) return undefined
  if (f.reason === 'aborted') return attempt === 0 ? RETRY_DELAYS_S[0] : undefined
  return RETRY_DELAYS_S[attempt]
}

// A run of many calls is still worth finishing when at most half of them failed.
export function tooManyFailed(total: number, failed: number): boolean {
  return total > 0 && failed * 2 > total
}
