import type { ModelCompleteResult, SessionMessage } from 'claude-code'
import type { Concise, ConciseEntry, ConciseStatus } from '../types'
import { parseCommand } from './shared/settings.ts'
import type { Grammar } from './shared/settings.ts'
import { CONCISE_AGE_MARGIN, CONCISE_BAR_COLUMNS, CONCISE_ENTRIES_MAX, CONCISE_GAP_ROWS, CONCISE_LABEL, CONCISE_MIN_ROWS, CONCISE_TEXT_INSET } from './config.ts'
import { scrollbarMarks } from './documents.ts'
import { CONCISE_SYSTEM } from './prompts.ts'
import { ageText, isBumpTurn } from './summary.ts'

// /summarize's pure side: which response it reads, what it asks, what a reply leaves in the pane,
// the list of summaries, and its rows, windowed so the section scrolls between the texts and FILES.

export const EMPTY_CONCISE: Concise = Object.freeze({ entries: [], responses: 0, nextId: 1, isEvery: false, offset: 0 })

// A bare /summarize runs once and leaves `every` as it was: the failure text sends people back to it.
export type ConciseAction = 'once' | 'on' | 'every' | 'off' | 'usage'

const GRAMMAR: Grammar<ConciseAction> = { empty: 'once', usage: 'usage', words: { on: 'on', every: 'every', off: 'off' }, valued: {} }

export function conciseAction(args: string): ConciseAction {
  return parseCommand(args, GRAMMAR)
}

// A new summary is the open one and every older one collapses. One of the same response replaces it.
export function addEntry(c: Concise, status: ConciseStatus, text: string, at: number): Concise {
  const older = c.entries.filter(e => e.responses !== c.responses).map(e => ({ ...e, isOpen: false }))
  const entry: ConciseEntry = { id: c.nextId, status, text, at, responses: c.responses, isOpen: true }
  return { ...c, entries: [entry, ...older].slice(0, CONCISE_ENTRIES_MAX), nextId: c.nextId + 1, offset: 0 }
}

// A run whose entry was replaced or cleared finds nothing to write.
export function settleEntry(c: Concise, id: number, status: ConciseStatus, text: string, at: number): Concise {
  return { ...c, entries: c.entries.map(e => (e.id === id ? { ...e, status, text, at } : e)) }
}

export function toggleEntry(c: Concise, id: number): Concise {
  return { ...c, entries: c.entries.map(e => (e.id === id ? { ...e, isOpen: !e.isOpen } : e)) }
}

export function entryLabel(entry: ConciseEntry, responses: number): string {
  const age = responses - entry.responses
  if (age <= 0) return CONCISE_LABEL
  return `SUMMARY · ${age} ${age === 1 ? 'RESPONSE' : 'RESPONSES'} OLD`
}

// The agent's newest message with text. A cache-keepalive ping's answer is not a response to anyone.
export function lastResponse(messages: readonly SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const text = m.text.trim()
    if (m.role !== 'assistant' || text === '') continue
    const prompt = messages.slice(0, i).findLast(p => p.role === 'user' && p.text.trim() !== '')
    if (prompt !== undefined && isBumpTurn(prompt.text.trim())) continue
    return text
  }
  return ''
}

export function conciseRequest(response: string): { system: string; prompt: string } {
  return { system: CONCISE_SYSTEM, prompt: `<message>\n${response}\n</message>` }
}

export type ConciseOutcome = 'concise' | 'api-error' | 'aborted'
export type ConciseResult = { outcome: ConciseOutcome; failure: string; status: 'ready' | 'failed'; text: string }

// The pane draws plain text. Bold and heading marks are removed here rather than forbidden in the
// prompt, so the prompt stays free of rules.
export function plainText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '')
}

export function conciseResult(reply: ModelCompleteResult, maxTokens: number): ConciseResult {
  if (reply.isAnswered) {
    const text = plainText(reply.text.trim())
    const isCutOff = reply.usage.output_tokens >= maxTokens
    return { outcome: 'concise', failure: '', status: 'ready', text: isCutOff ? `${text}\n\n[Cut off at the length limit: the rest of the response is missing.]` : text }
  }
  if (reply.reason === 'aborted') return { outcome: 'aborted', failure: '', status: 'failed', text: 'The call was cut off. Run /summarize again.' }
  const failure = `${reply.reason} ${reply.reason === 'api-error' ? reply.error : ''}`.trimEnd()
  return { outcome: 'api-error', failure, status: 'failed', text: `The call failed (${failure}). Run /summarize again.` }
}

const isWide = (char: string): boolean => char.codePointAt(0)! >= 0x1100

// Cells a text takes. The module has no terminal measure, so a character that may be double width
// counts as double: a row wrapped early beats a row whose end is cut.
export function cells(text: string): number {
  let n = 0
  for (const char of text) n += isWide(char) ? 2 : 1
  return n
}

function breakWord(word: string, columns: number): string[] {
  const parts: string[] = []
  let part = ''
  let width = 0
  for (const char of word) {
    const w = isWide(char) ? 2 : 1
    if (width + w > columns && part !== '') {
      parts.push(part)
      part = ''
      width = 0
    }
    part += char
    width += w
  }
  if (part !== '') parts.push(part)
  return parts
}

// A text as the rows it takes at this width, so the pane can count and window them.
export function wrapRows(text: string, columns: number): string[] {
  const width = Math.max(columns, 1)
  const rows: string[] = []
  for (const line of text.split('\n')) {
    const indent = /^\s*/.exec(line)![0].slice(0, Math.max(width - 1, 0))
    let row = indent
    let hasWord = false
    for (const word of line.trim().split(/\s+/).filter(Boolean)) {
      const candidate = hasWord ? `${row} ${word}` : `${row}${word}`
      if (cells(candidate) <= width) {
        row = candidate
        hasWord = true
        continue
      }
      if (hasWord) rows.push(row)
      const parts = breakWord(word, width - cells(indent))
      for (const part of parts.slice(0, -1)) rows.push(`${indent}${part}`)
      row = `${indent}${parts.at(-1)!}`
      hasWord = true
    }
    rows.push(row)
  }
  return rows
}

function entryAge(entry: ConciseEntry, now: number): string {
  if (entry.status === 'working') return 'working'
  if (entry.status === 'failed') return 'failed'
  return ageText(now - entry.at)
}

// A summary's header, which a click opens or collapses, or one wrapped line of its text.
export type ConciseRow = { kind: 'head'; id: number; label: string; age: string } | { kind: 'text'; text: string }

function conciseRows(c: Concise, now: number, columns: number): ConciseRow[] {
  return c.entries.flatMap((entry, i) => {
    const head: ConciseRow = { kind: 'head', id: entry.id, label: `${entry.isOpen ? '▾' : '▸'} ${entryLabel(entry, c.responses)}`, age: entryAge(entry, now) }
    if (!entry.isOpen) return [head]
    const body = wrapRows(entry.text, columns - CONCISE_TEXT_INSET).map((text): ConciseRow => ({ kind: 'text', text }))
    return [head, ...body, ...(i < c.entries.length - 1 ? [{ kind: 'text', text: '' } as const] : [])]
  })
}

// A Button wraps its label and has no truncate, so a header is cut to its one row here: what is left
// after the indent, the age and its margin, and the scrollbar when there is one.
function fittedRows(rows: ConciseRow[], columns: number, isWindowed: boolean): ConciseRow[] {
  const inset = isWindowed ? CONCISE_TEXT_INSET : CONCISE_TEXT_INSET - CONCISE_BAR_COLUMNS
  return rows.map(row => {
    if (row.kind !== 'head') return row
    // Every character of a label and an age takes one cell, ▾ and ▸ among them, which `cells` would count as two.
    const width = Math.max(columns - inset - CONCISE_AGE_MARGIN - row.age.length, 1)
    return row.label.length <= width ? row : { ...row, label: `${row.label.slice(0, Math.max(width - 1, 0))}…` }
  })
}

// The section as drawn: one row per header or line, with FILES's scrollbar marks. `window` is set
// when it is taller than its room and scrolls. Null with no summaries.
export type ConciseView = { rows: ConciseRow[]; bar: string[]; window: { rows: number; maxOffset: number } | null }

// `aboveRows` is what the texts and FILES take, and `fileRows` what FILES alone takes. The section
// gets what the texts leave, at least CONCISE_MIN_ROWS: past that the texts are cut from the bottom
// to give it room, as the pane's tree cuts them for FILES. FILES always stays on screen.
export function conciseView(p: { concise: Concise; now: number; columns: number; bodyRows: number; aboveRows: number; fileRows: number }): ConciseView | null {
  if (p.concise.entries.length === 0) return null
  const section = conciseRows(p.concise, p.now, p.columns)
  const wanted = Math.max(p.bodyRows - p.aboveRows - CONCISE_GAP_ROWS, CONCISE_MIN_ROWS)
  const room = Math.max(Math.min(wanted, p.bodyRows - p.fileRows - CONCISE_GAP_ROWS), 1)
  if (section.length <= room) return { rows: fittedRows(section, p.columns, false), bar: [], window: null }
  const maxOffset = section.length - room
  const offset = Math.min(Math.max(p.concise.offset, 0), maxOffset)
  return {
    rows: fittedRows(section.slice(offset, offset + room), p.columns, true),
    bar: scrollbarMarks(offset, section.length, room),
    window: { rows: room, maxOffset },
  }
}

// A page key asks for the pane's rows; the section's window is what a page means here.
export function scrolledOffset(s: { offset: number; by: number; bodyRows: number; window: { rows: number; maxOffset: number } }): number {
  const by = Math.abs(s.by) === s.bodyRows ? Math.sign(s.by) * s.window.rows : s.by
  return Math.min(Math.max(s.offset + by, 0), s.window.maxOffset)
}
