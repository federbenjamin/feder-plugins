// The log name, the command name, and the $.state plugin literal.
export const PLUGIN = 'session-summary'
export const SETTINGS_KEY = 'settings'
// The atom's shape tag; bump it when Summary's fields change.
export const SHAPE = 'summary-1'
export const TICK_MS = 30_000
export const FIRST_SECONDS = 90
export const EVERY_SECONDS = 600
export const WINDOW_CHARS = 16_000
export const MESSAGE_CHARS = 1_500
export const TOOL_LINE_CHARS = 300
export const CANDIDATE_MAX = 8
// The most paths the band shows: the prompt asks for one or two.
export const FILES_MAX = 2
// The judge's request has the same values; kept apart so tuning one never moves the other.
export const SUMMARY_REQUEST = { model: 'haiku', maxTokens: 300, effort: 'low', timeoutMs: 20_000 } as const
