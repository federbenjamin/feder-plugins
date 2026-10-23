import type { ModelUsage, SessionMessage } from 'claude-code'
import type { Source, Summary, SummaryStatus } from '../types'
import { TOOL_LINE_CHARS } from './config.ts'
import { DEFAULT_VARIANT, isVariant, VARIANTS } from './prompts.ts'
import { clip, toolInputHead } from './shared/text.ts'
import { isTypedText, SIBLING_TEXTS } from './shared/typed.ts'

// The summary's pure side: when a tick calls, what the call reads, what it asks, how the reply
// is read, the capture line and the pane's lines.

const EMPTY: Summary = { soFar: '', now: '', files: [], at: 0, status: 'running', source: 'messages', variant: DEFAULT_VARIANT }
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

function messageBlock(m: SessionMessage, messageChars: number): string | null {
  const text = m.text.trim()
  if (m.role === 'user') {
    if (text === '') return null
    return `${isTypedText(text) ? 'USER' : 'NOTE'}: ${clip(text, messageChars)}`
  }
  const lines = text === '' ? [] : [`ASSISTANT: ${clip(text, messageChars)}`]
  for (const use of m.toolUses) lines.push(`  → ${use.tool}: ${clip(toolInputHead(use.input), TOOL_LINE_CHARS)}${use.isError ? ' (error)' : ''}`)
  return lines.length > 0 ? lines.join('\n') : null
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

const isString = (v: unknown): v is string => typeof v === 'string'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

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
      if (isString(input.file_path) && input.file_path !== '') moveToEnd(list, input.file_path)
    } else if (tool === 'SendUserFile' && Array.isArray(input.files)) {
      for (const f of input.files) if (isString(f) && f !== '') moveToEnd(list, f)
    }
  }
  for (const { input } of uses) {
    const text = JSON.stringify(input)
    for (const path of list.filter(p => text.includes(p))) moveToEnd(list, path)
  }
  return limit > 0 ? list.slice(-limit) : []
}

export type Previous = Pick<Summary, 'soFar' | 'now' | 'files'>

export function buildRequest(r: { variant: string; source: Source; previous: Previous; input: string; candidates: readonly string[]; status: SummaryStatus }): { system: string; prompt: string } {
  const system = VARIANTS[r.variant] ?? VARIANTS[DEFAULT_VARIANT]!
  const candidates = r.candidates.length > 0 ? r.candidates.map(p => `- ${p}`).join('\n') : '(none)'
  const header = r.source === 'session-log' ? "The session's own log (tail):" : 'Recent activity (oldest first, may start mid-way):'
  const prompt = [
    `Status: ${r.status}`,
    [
      `Previous SO FAR: ${r.previous.soFar || '(none yet)'}`,
      `Previous NOW: ${r.previous.now || '(none yet)'}`,
      `Previous FILES: ${r.previous.files.join(', ') || 'none'}`,
    ].join('\n'),
    `Candidate files (newest last):\n${candidates}`,
    `${header}\n${r.input}`,
  ].join('\n\n')
  return { system, prompt }
}

export type Parsed = { soFar: string; now: string; files: string[]; outcome: 'summary' | 'parse-partial' | 'parse-failed' }

const lineValue = (text: string, re: RegExp): string | undefined => re.exec(text)?.[1]?.trim()

export function parseReply(text: string, previous: Previous, candidates: readonly string[], status: SummaryStatus): Parsed {
  const soFar = lineValue(text, /^SO FAR:\s*(.*)$/m)
  const now = lineValue(text, /^NOW:\s*(.*)$/m)
  const filesText = lineValue(text, /^FILES:\s*(.*)$/m)
  const found = [soFar, now, filesText].filter(v => v !== undefined).length
  if (found === 0) return { soFar: previous.soFar, now: previous.now, files: [...previous.files], outcome: 'parse-failed' }
  let files: string[]
  if (candidates.length === 0) files = status === 'running' ? [...previous.files] : []
  else if (filesText === undefined) files = [...previous.files]
  else if (filesText.toLowerCase() === 'none') files = []
  else files = [...new Set(filesText.split(',').map(p => p.trim()))].filter(p => candidates.includes(p))
  return { soFar: soFar ?? previous.soFar, now: now ?? previous.now, files, outcome: found === 3 ? 'summary' : 'parse-partial' }
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
  input: string
  inputChars: number
  candidates: string[]
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

// The texts the session's last call left, so a resumed session's pane continues them.
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
  if (!isRecord(c) || !isString(c.soFar) || !isString(c.now)) return null
  const at = isString(c.at) ? Date.parse(c.at) : NaN
  return {
    soFar: c.soFar,
    now: c.now,
    files: Array.isArray(c.files) ? c.files.filter(isString) : [],
    at: Number.isNaN(at) ? 0 : at,
    status: c.status === 'running' || c.status === 'ended' ? c.status : EMPTY_SUMMARY.status,
    source: c.source === 'messages' || c.source === 'session-log' ? c.source : EMPTY_SUMMARY.source,
    variant: isString(c.variant) && isVariant(c.variant) ? c.variant : EMPTY_SUMMARY.variant,
  }
}

export function paneLines(summary: Summary, now: number): { text: string; dim: boolean }[] {
  const updated = summary.at === 0 ? 'no summary yet' : `updated ${Math.floor((now - summary.at) / 60_000)} min ago · ${summary.source} · ${summary.variant}`
  return [
    { text: 'So far', dim: true },
    { text: summary.soFar || '(none yet)', dim: false },
    { text: 'Now', dim: true },
    { text: summary.now || '(none yet)', dim: false },
    ...summary.files.map(f => ({ text: f, dim: true })),
    { text: updated, dim: true },
  ]
}
