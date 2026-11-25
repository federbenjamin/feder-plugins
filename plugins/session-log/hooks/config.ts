export const PLUGIN = 'session-log'

// A typed prompt is kept for the quote check only; a paste past this is kept as its two ends.
export const TYPED_CHARS_MAX = 8000

// The view names this many of the files the session wrote, newest first, and counts the rest.
export const FILES_SHOWN = 10

// A session id as a file name: no path separators, so a `session` argument stays in the folder.
export const SESSION_ID_RE = /^[\w.-]+$/
