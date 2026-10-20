// The one "the operator typed this" check: a transcript row, or a bare text, that a person wrote
// in a top-level session. Judge and derivation both read rows through it.

export type TranscriptRow = Record<string, unknown>

// Texts that open a row no person typed: harness wrappers, `!` shell mode, and the messages the
// sibling plugins and the morning-report mod send as the user.
export const NOT_TYPED: readonly string[] = [
  '<command-name>',
  '<command-message>',
  '<local-command',
  '<system-reminder>',
  '<task-notification',
  '<agent-message',
  '[Request interrupted',
  'Caveat:',
  'This session is being continued',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  'keepalive ping',
  'Last keepalive ping',
  'automessage:',
  'Run my morning review.',
  'STOP JUDGE —',
]

// Another session's message, bare or pasted: "From the session …", "From the owning session",
// "Relayed by the orchestrating session". A pasted "From the docs: …" is the person's.
export const RELAY = /^(?:<pasted_content[^>]*>\s*)?(?:From|Relayed by) the (?:\S+ )?session\b/

// Message texts the sibling plugins send; scripts/sync-shared.ts asserts each appears in its
// plugin's hooks/register.ts.
export const SIBLING_TEXTS = {
  keepalivePing: 'keepalive ping',
  keepaliveLast: 'Last keepalive ping',
  afk: 'automessage:',
  nudge: 'STOP JUDGE —',
} as const

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function contentText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'text')
      .map(b => (typeof b.text === 'string' ? b.text : ''))
      .join('\n')
  }
  return typeof content === 'string' ? content : ''
}

// The text-level filters alone, for a text already taken from a row.
export function isTypedText(text: string): boolean {
  const t = text.trim()
  if (t === '') return false
  if (NOT_TYPED.some(prefix => t.startsWith(prefix))) return false
  if (RELAY.test(t)) return false
  return !t.slice(0, 30).includes('<system-reminder>') && !t.slice(0, 80).includes('UserPromptSubmit hook')
}

// A prompt the person typed while a turn ran; a peer session's relay has another origin.
function queuedPrompt(row: TranscriptRow): string | null {
  const queued = row.attachment
  if (!isRecord(queued) || queued.type !== 'queued_command') return null
  const origin = queued.origin
  if (queued.commandMode !== 'prompt' || !isRecord(origin) || origin.kind !== 'human') return null
  return contentText(queued.prompt)
}

// What a row's origin fields say about who wrote it. `sdk` admits a headless run's opening row,
// which has no origin and promptSource "sdk".
function isPersonRow(row: TranscriptRow, sdk: boolean): boolean {
  const origin = row.origin
  if (isRecord(origin) && origin.kind !== 'human') return false
  const source = row.promptSource
  if (source === undefined) return true
  if (source === 'typed' || source === 'queued') return true
  return source === 'sdk' && sdk
}

// The text the person typed in this row, or null when the row is not theirs. `sdk` counts a
// headless `claude -p` opening as theirs (the judge); the derivation passes false.
export function typedText(row: TranscriptRow, opts: { sdk: boolean }): string | null {
  if (row.isMeta || row.isSidechain) return null
  if (!opts.sdk && String(row.entrypoint ?? '').startsWith('sdk')) return null
  let content: string | null
  if (row.type === 'attachment') {
    content = queuedPrompt(row)
  } else if (row.type === 'user' && !row.isCompactSummary && !row.isVisibleInTranscriptOnly) {
    if (!isPersonRow(row, opts.sdk)) return null
    const message = row.message
    const raw = isRecord(message) ? message.content : undefined
    if (Array.isArray(raw) && raw.some(b => isRecord(b) && b.type === 'tool_result')) return null
    content = contentText(raw)
  } else {
    return null
  }
  const text = (content ?? '').trim()
  return isTypedText(text) ? text : null
}
