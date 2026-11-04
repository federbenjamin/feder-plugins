// The judge's constants.

export const TAIL_BYTES = 8_000_000

// The judge's model request: the production path the eval measures. maxTokens is the reply's own
// room; a model that cannot turn thinking off gets 2048 more from the engine, thinking included.
export const JUDGE_REQUEST = { model: 'haiku', maxTokens: 1024, effort: 'low', timeoutMs: 20_000 } as const

// The end of every reminder: work goes on while a question waits, and the agent's context stays on the question.
export const NUDGE_SUBAGENT = 'If you left the operator a question or decision, do this in a subagent so you can take it up when they return.'

// Earlier messages that ask to be consulted.
export const FRAMING =
  /\bdiscuss|ask me|one by one|one at a time|confirm with me|check with me|show me (first|before)|i want to (approve|see|review)|before (you|we) (build|start|do|change)|do(n'?t| not) (build|start|do|change)|\bwait\b/i

// The message that opened the turn asks for a proposal or for thoughts. Matched against that one
// message: earlier messages would hit 28 of 93 tuning cases.
export const PROPOSAL_ASK = /\bpropos(e|al|als)\b|\bthoughts\s*\?|\bwhat do you think\b|\bany ideas\b/i
// Pasted text is not the operator's own words.
export const PASTED_BLOCK = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g

// What the user message holds.
export const INPUT_LIMITS = {
  window: 8, // exchanges of both sides before the opening
  operatorClip: 400,
  agentClip: 400,
  openingClip: 3000,
  finalChars: 4000,
  framingClip: 600,
  framingN: 3,
  maxActions: 30,
  alongTheWay: 2,
  alongClip: 300,
  actionChars: 100,
  otherToolChars: 80,
  jobChars: 80,
  errorChars: 90,
  backgroundWindowMs: 3 * 60 * 60 * 1000,
  maxDocs: 5,
  planChars: 3000,
} as const

// Named Markdown files that are never a plan to read, and what marks a path as a plan.
export const DOC_SKIP: readonly string[] = ['session-logs/', '/.claude/projects/']
export const PLAN_PATH = /plan|brief|handoff|spec|design/i
// A failed tool call whose text says it was refused rather than broken.
export const REFUSED = /denied|refused|blocked|not allowed|permission/i
