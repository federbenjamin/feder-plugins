import type { ModelUsage, SessionMessage } from 'claude-code'
import type { CollapsedTexts, Doc, Source, Summary, SummaryStatus } from '../types'
import { FILES_ROWS, TOOL_LINE_CHARS } from './config.ts'
import { documentsFrom } from './documents.ts'
import type { FileVerdict } from './documents.ts'
import { DEFAULT_VARIANT, isVariant, VARIANTS } from './prompts.ts'
import { isSource } from './settings.ts'
import { clip, toolInputHead } from './shared/text.ts'
import { isRecord, isTypedText, SIBLING_TEXTS } from './shared/typed.ts'

// The summary's pure side: when a tick calls, what the call reads, what it asks, how the reply
// is read, the capture line and the pane's rows.

const EMPTY: Summary = { title: '', lastPrompt: '', soFar: '', now: '', at: 0, status: 'running', source: 'messages', variant: DEFAULT_VARIANT }
export const EMPTY_SUMMARY: Summary = Object.freeze(EMPTY)

// A call is due while a main turn runs: the first `firstSeconds` after the turn started, then
// every `everySeconds` after the last call started.
export function isDue(s: { now: number; turnStartedAt: number; lastCallAt: number; isOff: boolean; firstSeconds: number; everySeconds: number }): boolean {
  if (s.isOff || s.turnStartedAt <= 0) return false
  if (s.lastCallAt < s.turnStartedAt) return s.now - s.turnStartedAt >= s.firstSeconds * 1000
  return s.now - s.lastCallAt >= s.everySeconds * 1000
}

// A turn cache-keepalive started with its ping: nothing of the session's own work.
export function isBumpTurn(text: string): boolean {
  return text.startsWith(SIBLING_TEXTS.keepalivePing) || text.startsWith(SIBLING_TEXTS.keepaliveLast)
}

// A tool use is one line of the input: a multi-line command, and clip's own elision marker,
// fold into it.
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

function messageBlock(m: SessionMessage, messageChars: number): string | null {
  const text = m.text.trim()
  if (m.role === 'user') {
    if (text === '') return null
    return `${isTypedText(text) ? 'USER' : 'NOTE'}: ${clip(text, messageChars)}`
  }
  const lines = text === '' ? [] : [`ASSISTANT: ${clip(text, messageChars)}`]
  for (const use of m.toolUses) lines.push(`  → ${use.tool}: ${oneLine(clip(toolInputHead(use.input), TOOL_LINE_CHARS))}${use.isError ? ' (error)' : ''}`)
  return lines.length > 0 ? lines.join('\n') : null
}

// The person's newest typed prompt in the whole session, clipped like a window message; '' before
// the first.
export function newestPrompt(messages: readonly SessionMessage[], messageChars: number): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const text = m.text.trim()
    if (m.role === 'user' && text !== '' && isTypedText(text)) return clip(text, messageChars)
  }
  return ''
}

// LAST PROMPT sums up one prompt: while that prompt is unchanged, the line stays as it was written.
export function keptLastPrompt(r: { newest: string; summarized: string; previous: string; replied: string }): string {
  return r.newest === r.summarized && r.previous !== '' ? r.previous : r.replied
}

// A prompt the person sent while a turn ran: the model reads it, but $.session.messages() leaves it
// out. `after` is how many messages the session held when it arrived.
export type Queued = { text: string; after: number }

// The messages with each mid-turn prompt put back as a user message where it arrived. Positions
// count from the start of the list, so they drift once the engine's 4096-message cap trims it.
export function withQueued(messages: readonly SessionMessage[], queued: readonly Queued[]): SessionMessage[] {
  const out = [...messages]
  for (const q of [...queued].sort((x, y) => y.after - x.after)) {
    out.splice(Math.min(Math.max(q.after, 0), out.length), 0, { role: 'user', text: q.text, toolUses: [] })
  }
  return out
}

export function formatMessages(messages: readonly SessionMessage[], caps: { windowChars: number; messageChars: number }): string {
  const blocks = messages.map(m => messageBlock(m, caps.messageChars)).filter((b): b is string => b !== null)
  const kept: string[] = []
  let length = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!
    const next = length + block.length + (kept.length > 0 ? 1 : 0)
    if (kept.length > 0 && next > caps.windowChars) break
    kept.push(block)
    length = next
  }
  return kept.reverse().join('\n')
}

export function formatLog(text: string, windowChars: number): string {
  if (text.length <= windowChars) return text
  const tail = text.slice(-windowChars)
  const cut = tail.indexOf('\n')
  return cut === -1 ? tail : tail.slice(cut + 1)
}

export type Previous = Pick<Summary, 'title' | 'lastPrompt' | 'soFar' | 'now'>

const pathLines = (paths: readonly string[]): string => paths.map(p => `- ${p}`).join('\n') || '(none)'

// `candidates` and `judgeable` are what the reply's ADD and SUPERSEDED may name. A candidate marked
// superseded tells the model it already said a newer file replaced that one.
export function buildRequest(r: { variant: string; source: Source; previous: Previous; newestPrompt: string; input: string; status: SummaryStatus; isTitleProvisional: boolean; candidates: readonly string[]; superseded: ReadonlySet<string>; judgeable: readonly string[] }): { system: string; prompt: string } {
  const system = VARIANTS[r.variant] ?? VARIANTS[DEFAULT_VARIANT]!
  const header = r.source === 'session-log' ? "The session's own log (tail):" : 'Recent activity (oldest first, may start mid-way):'
  const prompt = [
    `Status: ${r.status}`,
    [
      `Previous TITLE: ${r.previous.title || '(none yet)'}${r.isTitleProvisional && r.previous.title ? ' (provisional: written from the first prompt alone)' : ''}`,
      `Previous LAST PROMPT: ${r.previous.lastPrompt || '(none yet)'}`,
      `Previous SO FAR: ${r.previous.soFar || '(none yet)'}`,
      `Previous NOW: ${r.previous.now || '(none yet)'}`,
    ].join('\n'),
    `Newest prompt:\n${r.newestPrompt || '(none yet)'}`,
    `${header}\n${r.input}`,
    `File candidates:\n${pathLines(r.candidates.map(p => (r.superseded.has(p) ? `${p} (superseded)` : p)))}`,
    `Current file list:\n${pathLines(r.judgeable)}`,
  ].join('\n\n')
  return { system, prompt }
}

// The TASK verdict that opens a reply: whether the person moved the session to a new task. Null
// when the reply has none; the texts are read the same either way.
export type TaskVerdict = 'same' | 'new' | null

export function parseTask(text: string): TaskVerdict {
  const verdict = /^TASK:[^\S\r\n]*(same|new)\b/im.exec(text)?.[1]?.toLowerCase()
  return verdict === 'same' || verdict === 'new' ? verdict : null
}

export type Parsed = { title: string; lastPrompt: string; soFar: string; now: string; outcome: 'summary' | 'parse-partial' | 'parse-failed' }

// A label's value is the rest of its own line; a label with nothing after it counts as absent.
const lineValue = (text: string, re: RegExp): string | undefined => re.exec(text)?.[1]?.trim()
// The request shows an empty text as "(none yet)"; a reply that copies it back means empty.
const textValue = (text: string, re: RegExp): string | undefined => {
  const value = lineValue(text, re)
  return value !== undefined && /^\(?none yet\)?\.?$/i.test(value) ? '' : value
}

export function parseReply(text: string, previous: Previous): Parsed {
  const title = textValue(text, /^TITLE:[^\S\r\n]*(\S.*)$/m)
  const lastPrompt = textValue(text, /^LAST PROMPT:[^\S\r\n]*(\S.*)$/m)
  const soFar = textValue(text, /^SO FAR:[^\S\r\n]*(\S.*)$/m)
  const now = textValue(text, /^NOW:[^\S\r\n]*(\S.*)$/m)
  const found = [title, lastPrompt, soFar, now].filter(v => v !== undefined).length
  if (found === 0) return { title: previous.title, lastPrompt: previous.lastPrompt, soFar: previous.soFar, now: previous.now, outcome: 'parse-failed' }
  return { title: title ?? previous.title, lastPrompt: lastPrompt ?? previous.lastPrompt, soFar: soFar ?? previous.soFar, now: now ?? previous.now, outcome: found === 4 ? 'summary' : 'parse-partial' }
}

const ADD_LINE = /^ADD:[^\S\r\n]*(\S.*)$/m
const SUPERSEDED_LINE = /^SUPERSEDED:[^\S\r\n]*(\S.*)$/m

function namedPaths(text: string, line: RegExp, allowed: readonly string[]): string[] {
  const names = (lineValue(text, line) ?? '').split(',').map(n => n.trim().replace(/^[`"']+|[`"']+$/g, ''))
  return [...new Set(names)].filter(n => allowed.includes(n))
}

// ADD and SUPERSEDED, each held to what the request let it name, so `none`, a missing line and an
// invented path all come to nothing. They never decide a call's outcome: the four texts do.
export function parseFileVerdict(text: string, allowed: { candidates: readonly string[]; judgeable: readonly string[] }): FileVerdict {
  return { add: namedPaths(text, ADD_LINE, allowed.candidates), superseded: namedPaths(text, SUPERSEDED_LINE, allowed.judgeable) }
}

export function capturePath(dir: string, sessionId: string): string {
  return `${dir}/session-summaries/${sessionId}.jsonl`
}

export type Capture = {
  at: string
  status: SummaryStatus
  source: Source
  variant: string
  previous: Previous
  task: TaskVerdict
  input: string
  inputChars: number
  newestPrompt: string
  title: string
  lastPrompt: string
  soFar: string
  now: string
  files: Doc[] // the documents list as it stood, without its shares: a capture holds no token
  candidates: readonly string[] // what the request offered ADD
  add: readonly string[] // what the reply's ADD and SUPERSEDED came to
  superseded: readonly string[]
  outcome: string
  ms: number
  usage: ModelUsage
  usd: number
}

export function captureLine(c: Capture): string {
  return `${JSON.stringify(c)}\n`
}

// The session's last capture line, or null when it cannot seed anything.
function lastCapture(text: string): Record<string, unknown> | null {
  const last = text
    .split('\n')
    .filter(l => l.trim() !== '')
    .at(-1)
  if (last === undefined) return null
  let c: unknown
  try {
    c = JSON.parse(last)
  } catch {
    return null
  }
  return isRecord(c) && typeof c.soFar === 'string' && typeof c.now === 'string' ? c : null
}

const captureAt = (c: Record<string, unknown>): number => {
  const at = typeof c.at === 'string' ? Date.parse(c.at) : NaN
  return Number.isNaN(at) ? 0 : at
}

// The texts the session's last call left, so a resumed session's pane continues them.
export function seedFromCapture(text: string): Summary | null {
  const c = lastCapture(text)
  if (c === null) return null
  return {
    title: typeof c.title === 'string' ? c.title : '',
    lastPrompt: typeof c.lastPrompt === 'string' ? c.lastPrompt : '',
    soFar: c.soFar as string,
    now: c.now as string,
    at: captureAt(c),
    status: c.status === 'running' || c.status === 'ended' ? c.status : EMPTY_SUMMARY.status,
    source: isSource(c.source) ? c.source : EMPTY_SUMMARY.source,
    variant: typeof c.variant === 'string' && isVariant(c.variant) ? c.variant : EMPTY_SUMMARY.variant,
  }
}

// The documents list the session's last call left.
export function seedDocuments(text: string): Doc[] {
  const c = lastCapture(text)
  return c === null ? [] : documentsFrom(c.files, captureAt(c))
}

// What the pane draws, newest first: where the session is now, how it got there, what was asked.
// Null before the first summary. The source and variant stay in `/session-summary show`.
export type PaneView = {
  title: string
  isRunning: boolean
  age: string
  now: string
  soFar: string
  asked: string
}

export function ageText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

export function paneView(summary: Summary, now: number): PaneView | null {
  if (summary.at === 0 && summary.soFar === '' && summary.now === '') return null
  return {
    title: summary.title,
    isRunning: summary.status === 'running',
    age: ageText(now - summary.at),
    now: summary.now || '(none yet)',
    soFar: summary.soFar || '(none yet)',
    asked: summary.lastPrompt,
  }
}

const wrappedRows = (text: string, columns: number): number => Math.ceil((text.length * 1.15) / Math.max(1, columns)) || 1

// The rows FILES takes: its gap, its header and its shown files.
export function filesRows(fileCount: number): number {
  return fileCount === 0 ? 0 : 2 + Math.min(fileCount, FILES_ROWS)
}

// About how many rows the pane's tree takes, wrapped words included: a guess on the high side.
export const NONE_COLLAPSED: CollapsedTexts = Object.freeze({ soFar: false, asked: false })

export function estimatedRows(view: PaneView | null, columns: number, fileCount: number, collapsed: CollapsedTexts = NONE_COLLAPSED): number {
  const files = filesRows(fileCount)
  if (view === null) return 1 + files
  const section = (text: string, isCollapsed: boolean) => {
    if (text === '') return 0
    return isCollapsed ? 2 : 2 + wrappedRows(text, columns - 2)
  }
  return (view.title === '' ? 0 : 3) + 1 + wrappedRows(view.now, columns) + section(view.soFar, collapsed.soFar) + section(view.asked, collapsed.asked) + files
}

// A dock has its whole height to pin FILES to the bottom of. An inline frame fits its tree, so the
// tree takes only what it needs, and is held to the room only when it would outgrow it: the engine
// would scroll a taller one, FILES with it.
export function paneHeight(r: { placement: 'dock' | 'inline'; bodyRows: number; estimated: number }): number | undefined {
  if (r.placement === 'dock') return r.bodyRows
  return r.estimated > r.bodyRows ? r.bodyRows : undefined
}
