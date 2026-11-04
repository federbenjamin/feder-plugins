// The log name, the command name, and the $.state plugin literal.
export const PLUGIN = 'session-summary'
export const SETTINGS_KEY = 'settings'
// The atom's shape tag; bump it when Summary's fields change.
export const SHAPE = 'summary-3'
export const PANE_TITLE = 'Session summary'
// The pane's fill, set apart from the transcript beside it.
export const PANE_BACKGROUND = '#262b36'
export const TICK_MS = 30_000
export const FIRST_SECONDS = 90
export const EVERY_SECONDS = 600
export const WINDOW_CHARS = 16_000
export const MESSAGE_CHARS = 1_500
export const TOOL_LINE_CHARS = 300
export const CANDIDATE_MAX = 8
// Prompts the person sent mid-turn, kept to put back into the window (the engine's messages omit them).
export const QUEUED_MAX = 20
// The most paths the pane shows: the prompt asks for one or two.
export const FILES_MAX = 2
// The judge's request has the same values; kept apart so tuning one never moves the other.
export const SUMMARY_REQUEST = { model: 'haiku', maxTokens: 300, effort: 'low', timeoutMs: 20_000 } as const

// /summarize: the shorter copy of the agent's last response, in the pane's bottom section.
export const CONCISE_COMMAND = 'summarize'
export const CONCISE_SHAPE = 'concise-1'
// The prompt-variant field of its firing line, so the README's read-back counts these calls apart.
export const CONCISE_VARIANT = 'concise'
// A rewrite can run as long as the response: a reply that reaches maxTokens is marked as cut off.
export const CONCISE_REQUEST = { model: 'sonnet', maxTokens: 8_000, effort: 'low', timeoutMs: 120_000 } as const
// Below this many rows for the section, the pinned layout gives way and the whole pane scrolls.
export const CONCISE_MIN_ROWS = 8
