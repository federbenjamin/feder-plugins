import type { KeepaliveTiming } from '../types'

// Caps sit below each model's break-even (pings that cost as much as one cold rebuild):
// Sonnet 5.5 19, Opus 5.5 39, Fable 5.1 79.
export const CAPS: ReadonlyArray<readonly [string, number]> = [
  ['fable', 12],
  ['opus', 12],
  ['sonnet', 6],
  ['haiku', 6],
]
const DEFAULT_CAP = 6
export const LEAD_MS = 2 * 60_000
export const HEADROOM_MS = 15_000 // the latest a bump may go: request latency before expiry
export const TICK_MS = 30_000
export const COLD_LIMIT = 2
export const COMMAND = 'keepalive'
export const OFF_TOOL = 'keepalive_off'
export const AUTH_STATUS = ['claude', 'auth', 'status', '--json'] as const

export function capFor(model: string): number {
  const m = model.toLowerCase()
  return CAPS.find(([family]) => m.includes(family))?.[1] ?? DEFAULT_CAP
}

export function bumpText(n: number, cap: number): string {
  return n < cap
    ? 'keepalive ping. Reply only: ok'
    : 'Last keepalive ping: the prompt cache expires after this. ' +
        'Close the session now, so a fresh session can pick up from it: run a session-closing ' +
        'skill with the Skill tool if one is installed, else a handoff skill, else write a ' +
        'handoff yourself. Do nothing else.'
}

// Whether a bump is due: idle, not stopped or off, and the last main request's cache inside the
// window from LEAD_MS to HEADROOM_MS before it expires (past that the bump would rebuild a cold
// cache), with no bump sent yet for that request (a bump's own request moves lastSend on).
export function isDue(s: Pick<KeepaliveTiming, 'lastSend' | 'bumpedFor' | 'isStopped' | 'isOff'> & { now: number; ttl: number; isBusy: boolean }): boolean {
  const expiresAt = s.lastSend + s.ttl
  return (
    !s.isBusy &&
    !s.isStopped &&
    !s.isOff &&
    s.lastSend > 0 &&
    s.bumpedFor !== s.lastSend &&
    s.now >= expiresAt - LEAD_MS &&
    s.now < expiresAt - HEADROOM_MS
  )
}

// A bump that wrote more of the prompt to the cache than it read found the cache cold.
export function wasCold(usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number }): boolean {
  return usage.cache_read_input_tokens < usage.cache_creation_input_tokens
}

// Whether the latest bump answered the conversation's first request, whose cache entry the bump
// cannot read whatever its age.
export function followsFirstRequest(t: Pick<KeepaliveTiming, 'bumpedFor' | 'firstSend'>): boolean {
  return t.firstSend > 0 && t.bumpedFor === t.firstSend
}

// Whether the account the session would send under now is another than the one the cache was
// written under. An unknown account on either side (logged out, a failed read) is no change.
export function isAccountChanged(cachedUnder: string, current: string): boolean {
  return cachedUnder !== '' && current !== '' && cachedUnder !== current
}

export function accountChangedText(from: string, to: string): string {
  return `keepalive: account changed (${from} → ${to}), cache cold; stopped until your next prompt`
}

// The logged-in account's email from `claude auth status --json`; '' when it says logged out,
// undefined when it says neither (not JSON, or logged in with no email).
export function accountOf(authStatus: string): string | undefined {
  try {
    const { loggedIn, email } = JSON.parse(authStatus) as { loggedIn?: unknown; email?: unknown }
    if (loggedIn === false) return ''
    return loggedIn === true && typeof email === 'string' && email !== '' ? email : undefined
  } catch {
    return undefined
  }
}
