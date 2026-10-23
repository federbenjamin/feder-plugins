// What an engine event means for the plugins that read it: who wrote a prompt, and whether a
// compaction replaced the conversation.

// The origins of a prompt the person wrote: typed, from a bridge, or a Slack ping.
export const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'slack-ping'])

// Whether a compaction replaced the main conversation: not a subagent's own, not a skipped one,
// and not a `precompute`, which only keeps its summary for later.
export function isConversationReplaced(e: { trigger: string; agentId?: string }, result: { skip?: string }): boolean {
  return e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined
}
