// What an engine event means for the plugins that read it: who wrote a prompt, whether a
// compaction replaced the conversation, and which main turn is running.

// The origins of a prompt the person wrote: typed, from a bridge, or a Slack ping.
export const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'slack-ping'])

// Whether a compaction replaced the main conversation: not a subagent's own, not a skipped one,
// and not a `precompute`, which only keeps its summary for later.
export function isConversationReplaced(e: { trigger: string; agentId?: string }, result: { skip?: string }): boolean {
  return e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined
}

// The main loop's running turn; undefined while it is idle. `startedAt` is there only when the
// caller passed a clock reading: a caller that must flip before its first await passes none.
export type MainTurn = { turnId: string; startedAt?: number }

// A subagent's turn.start leaves the main turn as it was.
export function mainTurnStarted(current: MainTurn | undefined, e: { turnId: string; agentId?: string }, startedAt?: number): MainTurn | undefined {
  if (e.agentId) return current
  return startedAt === undefined ? { turnId: e.turnId } : { turnId: e.turnId, startedAt }
}

// Only the running turn's own main turn.complete ends it.
export function mainTurnEnded(current: MainTurn | undefined, e: { turnId: string; agentId?: string }): MainTurn | undefined {
  return !e.agentId && current?.turnId === e.turnId ? undefined : current
}
