// The log name, the command name, and the $.state plugin literal.
export const PLUGIN = 'session-summary'
export const SETTINGS_KEY = 'settings'
// The atom's shape tag; bump it when Summary's fields change.
export const SHAPE = 'summary-4'
// The documents atom's shape tag; bump it when Doc's fields change.
export const DOCUMENTS_SHAPE = 'documents-1'
export const PANE_TITLE = 'Session summary'
// The pane's fill, set apart from the transcript beside it.
export const PANE_BACKGROUND = '#262b36'
export const TICK_MS = 30_000
export const FIRST_SECONDS = 90
export const EVERY_SECONDS = 600
export const WINDOW_CHARS = 16_000
export const MESSAGE_CHARS = 1_500
export const TOOL_LINE_CHARS = 300
// Prompts the person sent mid-turn, kept to put back into the window (the engine's messages omit them).
export const QUEUED_MAX = 20
// The file rows the pane shows at once; the wheel over them reaches older ones.
export const FILES_ROWS = 3
// What a Write or an Edit puts on the documents list. A file sent to the person joins whatever its type.
export const DOCUMENT_EXTENSIONS = ['md', 'txt', 'html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] as const
// /session-summary links: the tailnet's https port, proxied to the local file server's.
export const LINKS_HTTPS_PORT = 8692
export const LINKS_LOCAL_PORT = 8693
export const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const LINKS_LABEL = 'com.session-summary.links'
// The server's access log, in the firing line's shape: <state dir>/logs/<this>.log.
export const LINKS_ACCESS_LOG = 'session-summary-links'
// The CLI inside the Tailscale app, for a Mac whose PATH has no tailscale.
export const TAILSCALE_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
export const TAILSCALE_TIMEOUT_MS = 20_000
// How long `links on` waits for the server to answer: tries, and the wait after a miss.
export const LINKS_READY_TRIES = 20
export const LINKS_READY_WAIT_MS = 250
// The judge's request has the same values; kept apart so tuning one never moves the other.
export const SUMMARY_REQUEST = { model: 'haiku', maxTokens: 300, effort: 'low', timeoutMs: 20_000 } as const
