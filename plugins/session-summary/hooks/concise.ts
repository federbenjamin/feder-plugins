import type { ModelCompleteResult, SessionMessage } from 'claude-code'
import type { Concise, Summary } from '../types'
import { CONCISE_MIN_ROWS } from './config.ts'
import { CONCISE_SYSTEM } from './prompts.ts'
import { isBumpTurn, paneLines } from './summary.ts'

// /summarize's pure side: which response it reads, what it asks, what a reply leaves in the pane,
// and the pane's rows with its bottom section scrolling under the pinned texts.

export const EMPTY_CONCISE: Concise = Object.freeze({ status: 'empty', text: '', at: 0, offset: 0 })

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

export type Row = { text: string; bold?: boolean; dim?: boolean }

const BLANK: Row = { text: '' }

// The existing texts as rows, one blank row between blocks.
export function topRows(summary: Summary, now: number, columns: number): Row[] {
  const lines = paneLines(summary, now)
  if (lines.length === 0) return [{ text: 'No summary yet.', dim: true }]
  return lines.flatMap((line, i) => [
    ...(i > 0 ? [BLANK] : []),
    ...(line.label !== '' ? wrapRows(line.label, columns).map(text => ({ text, bold: true, dim: line.dim })) : []),
    ...wrapRows(line.text, columns).map(text => ({ text, bold: line.bold ?? false, dim: line.dim })),
  ])
}

export function conciseAge(concise: Concise, now: number): string {
  if (concise.status === 'working') return 'working'
  if (concise.status === 'failed') return 'failed'
  return `from ${Math.max(Math.floor((now - concise.at) / 60_000), 0)} min ago`
}

// Where the rows go: `window` keeps the top in place and scrolls the section in `rows` rows; null
// leaves every row drawn, for when the section fits, or when so little room is left under the top
// that the whole pane scrolling (the engine's own) reads better.
export type PaneLayout = { rows: Row[]; window: { rows: number; maxOffset: number } | null }

const HEADER_ROWS = 3 // a blank row, the label, the age row

export function paneLayout(p: { summary: Summary; concise: Concise; now: number; columns: number; bodyRows: number }): PaneLayout {
  const top = topRows(p.summary, p.now, p.columns)
  if (p.concise.status === 'empty') return { rows: top, window: null }
  const section = wrapRows(p.concise.text, p.columns)
  const room = p.bodyRows - top.length - HEADER_ROWS
  const isPinned = section.length > room && room >= CONCISE_MIN_ROWS
  const maxOffset = isPinned ? section.length - room : 0
  const offset = Math.min(Math.max(p.concise.offset, 0), maxOffset)
  const shown = isPinned ? section.slice(offset, offset + room) : section
  const place = isPinned ? ` · rows ${offset + 1}-${offset + room} of ${section.length}` : ''
  return {
    rows: [
      ...top,
      BLANK,
      { text: 'SUMMARY OF LAST RESPONSE:', bold: true },
      { text: `${conciseAge(p.concise, p.now)}${place}`, dim: true },
      ...shown.map(text => ({ text })),
    ],
    window: isPinned ? { rows: room, maxOffset } : null,
  }
}

// A page key asks for the pane's rows; the section's window is what a page means here.
export function scrolledOffset(s: { offset: number; by: number; bodyRows: number; window: { rows: number; maxOffset: number } }): number {
  const by = Math.abs(s.by) === s.bodyRows ? Math.sign(s.by) * s.window.rows : s.by
  return Math.min(Math.max(s.offset + by, 0), s.window.maxOffset)
}
