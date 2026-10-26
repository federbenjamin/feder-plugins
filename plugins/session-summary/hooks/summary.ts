import type { ModelUsage, SessionMessage } from 'claude-code'
import type { Source, Summary, SummaryStatus } from '../types'
import { FILES_MAX, TOOL_LINE_CHARS } from './config.ts'
import { DEFAULT_VARIANT, isVariant, VARIANTS } from './prompts.ts'
import { isSource } from './settings.ts'
import { clip, toolInputHead } from './shared/text.ts'
import { isRecord, isTypedText, SIBLING_TEXTS } from './shared/typed.ts'

// The summary's pure side: when a tick calls, what the call reads, what it asks, how the reply
// is read, the capture line and the band's rows.

const EMPTY: Summary = { title: '', soFar: '', now: '', files: [], at: 0, status: 'running', source: 'messages', variant: DEFAULT_VARIANT }
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

function moveToEnd(list: string[], path: string): void {
  const i = list.indexOf(path)
  if (i !== -1) list.splice(i, 1)
  list.push(path)
}

// The paths a person might open: what the session wrote or sent, newest by their last mention
// in any tool input.
export function fileCandidates(messages: readonly SessionMessage[], limit: number): string[] {
  const uses = messages.flatMap(m => m.toolUses).map(u => ({ tool: u.tool, input: isRecord(u.input) ? u.input : {} }))
  const list: string[] = []
  for (const { tool, input } of uses) {
    if (tool === 'Write' || tool === 'Edit') {
      if (typeof input.file_path === 'string' && input.file_path !== '') moveToEnd(list, input.file_path)
    } else if (tool === 'SendUserFile' && Array.isArray(input.files)) {
      for (const f of input.files) if (typeof f === 'string' && f !== '') moveToEnd(list, f)
    }
  }
  for (const { input } of uses) {
    const text = JSON.stringify(input)
    for (const path of list.filter(p => text.includes(p))) moveToEnd(list, path)
  }
  return limit > 0 ? list.slice(-limit) : []
}

// The files the session sent to the person: the likeliest ones for them to open.
export function sentFiles(messages: readonly SessionMessage[]): string[] {
  const sent = new Set<string>()
  for (const u of messages.flatMap(m => m.toolUses)) {
    if (u.tool !== 'SendUserFile' || !isRecord(u.input) || !Array.isArray(u.input.files)) continue
    for (const f of u.input.files) if (typeof f === 'string' && f !== '') sent.add(f)
  }
  return [...sent]
}

// What FILES may name: this window's candidates, and the files already shown, so a file stays
// while it is still relevant and leaves only when the model drops it.
export function allowedFiles(candidates: readonly string[], previous: readonly string[]): string[] {
  return [...new Set([...previous, ...candidates])]
}

export type Previous = Pick<Summary, 'title' | 'soFar' | 'now' | 'files'>

export function buildRequest(r: { variant: string; source: Source; previous: Previous; input: string; candidates: readonly string[]; sent: readonly string[]; status: SummaryStatus; isTitleProvisional: boolean }): { system: string; prompt: string } {
  const system = VARIANTS[r.variant] ?? VARIANTS[DEFAULT_VARIANT]!
  const allowed = allowedFiles(r.candidates, r.previous.files)
  const candidates = allowed.length > 0 ? allowed.map(p => `- ${p}${r.sent.includes(p) ? ' (sent to the person)' : ''}`).join('\n') : '(none)'
  const header = r.source === 'session-log' ? "The session's own log (tail):" : 'Recent activity (oldest first, may start mid-way):'
  const prompt = [
    `Status: ${r.status}`,
    [
      `Previous TITLE: ${r.previous.title || '(none yet)'}${r.isTitleProvisional && r.previous.title ? ' (provisional: written from the first prompt alone)' : ''}`,
      `Previous SO FAR: ${r.previous.soFar || '(none yet)'}`,
      `Previous NOW: ${r.previous.now || '(none yet)'}`,
      `Previous FILES: ${r.previous.files.join(', ') || 'none'}`,
    ].join('\n'),
    `Candidate files (newest last):\n${candidates}`,
    `${header}\n${r.input}`,
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

export type Parsed = { title: string; soFar: string; now: string; files: string[]; outcome: 'summary' | 'parse-partial' | 'parse-failed' }

// A label's value is the rest of its own line; a label with nothing after it counts as absent.
const lineValue = (text: string, re: RegExp): string | undefined => re.exec(text)?.[1]?.trim()
// The request shows an empty text as "(none yet)"; a reply that copies it back means empty.
const textValue = (text: string, re: RegExp): string | undefined => {
  const value = lineValue(text, re)
  return value !== undefined && /^\(?none yet\)?\.?$/i.test(value) ? '' : value
}

export function parseReply(text: string, previous: Previous, candidates: readonly string[]): Parsed {
  const title = textValue(text, /^TITLE:[^\S\r\n]*(\S.*)$/m)
  const soFar = textValue(text, /^SO FAR:[^\S\r\n]*(\S.*)$/m)
  const now = textValue(text, /^NOW:[^\S\r\n]*(\S.*)$/m)
  const filesText = lineValue(text, /^FILES:[^\S\r\n]*(\S.*)$/m)
  const found = [title, soFar, now, filesText].filter(v => v !== undefined).length
  if (found === 0) return { title: previous.title, soFar: previous.soFar, now: previous.now, files: [...previous.files], outcome: 'parse-failed' }
  const allowed = allowedFiles(candidates, previous.files)
  let files: string[]
  if (filesText === undefined) files = [...previous.files]
  else if (filesText.toLowerCase() === 'none') files = []
  else files = [...new Set(filesText.split(',').map(p => p.trim()))].filter(p => allowed.includes(p)).slice(0, FILES_MAX)
  return { title: title ?? previous.title, soFar: soFar ?? previous.soFar, now: now ?? previous.now, files, outcome: found === 4 ? 'summary' : 'parse-partial' }
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
  candidates: string[]
  title: string
  soFar: string
  now: string
  files: string[]
  outcome: string
  ms: number
  usage: ModelUsage
  usd: number
}

export function captureLine(c: Capture): string {
  return `${JSON.stringify(c)}\n`
}

// The texts the session's last call left, so a resumed session's band continues them.
export function seedFromCapture(text: string): Summary | null {
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
  if (!isRecord(c) || typeof c.soFar !== 'string' || typeof c.now !== 'string') return null
  const at = typeof c.at === 'string' ? Date.parse(c.at) : NaN
  return {
    title: typeof c.title === 'string' ? c.title : '',
    soFar: c.soFar,
    now: c.now,
    files: Array.isArray(c.files) ? c.files.filter((f): f is string => typeof f === 'string') : [],
    at: Number.isNaN(at) ? 0 : at,
    status: c.status === 'running' || c.status === 'ended' ? c.status : EMPTY_SUMMARY.status,
    source: isSource(c.source) ? c.source : EMPTY_SUMMARY.source,
    variant: typeof c.variant === 'string' && isVariant(c.variant) ? c.variant : EMPTY_SUMMARY.variant,
  }
}

// The band's rows: the title, SO FAR and NOW with their texts starting in one column, then the recent files,
// then how fresh the texts are. No rows before the first summary, so the band takes no space
// until there is something to say. The source and variant stay in `/session-summary show`.
export const BAND_LABEL_WIDTH = 'SO FAR:'.length

export function bandLines(summary: Summary, now: number): { label: string; text: string; dim: boolean; bold?: true }[] {
  if (summary.at === 0 && summary.soFar === '' && summary.now === '') return []
  return [
    ...(summary.title !== '' ? [{ label: '', text: summary.title, dim: false, bold: true as const }] : []),
    { label: 'SO FAR:', text: summary.soFar || '(none yet)', dim: false },
    { label: 'NOW:', text: summary.now || '(none yet)', dim: false },
    ...(summary.files.length > 0 ? [{ label: 'RECENT FILES:', text: summary.files.join(', '), dim: true }] : []),
    { label: '', text: `updated ${Math.floor((now - summary.at) / 60_000)} min ago`, dim: true },
  ]
}
