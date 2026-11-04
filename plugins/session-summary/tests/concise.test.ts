import { expect, test } from 'claude-code/testing'
import { conciseRequest, plainText } from '../hooks/concise'
import { CONCISE_SYSTEM } from '../hooks/prompts'

test('the request sends the chosen prompt and holds the whole response', () => {
  const response = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ')
  const request = conciseRequest(response)
  expect(request.system).toBe(CONCISE_SYSTEM)
  expect(request.prompt).toBe(`<message>\n${response}\n</message>`)
})

test('plainText removes bold and heading marks and leaves code spans and lists', () => {
  expect(plainText('## Done\n**Built:** `a**b` and\n- item')).toBe('Done\nBuilt: `a**b` and\n- item')
})

import type { ModelCompleteResult, SessionMessage } from 'claude-code'
import type { Concise } from '../types'
import { CONCISE_MIN_ROWS } from '../hooks/config'
import { cells, conciseResult, EMPTY_CONCISE, lastResponse, paneLayout, scrolledOffset, wrapRows } from '../hooks/concise'
import { EMPTY_SUMMARY } from '../hooks/summary'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const agent = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
const toolOnly = (): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' } }] })

test('lastResponse returns the newest assistant text, not an older one', () => {
  expect(lastResponse([user('a'), agent('first answer'), user('b'), agent('second answer')])).toBe('second answer')
})

test('lastResponse skips an assistant message that only calls tools', () => {
  expect(lastResponse([user('a'), agent('the real answer'), toolOnly(), toolOnly()])).toBe('the real answer')
})

test('lastResponse returns the response before a keepalive ping, not the ping answer', () => {
  const messages = [user('do the work'), agent('Work is done.'), user('keepalive ping. Reply only: ok'), agent('ok')]
  expect(lastResponse(messages)).toBe('Work is done.')
  const last = [...messages, user('Last keepalive ping, reply ok'), agent('ok')]
  expect(lastResponse(last)).toBe('Work is done.')
})

test('lastResponse reads an answer that follows a real prompt after an earlier ping', () => {
  const messages = [user('keepalive ping. Reply only: ok'), agent('ok'), user('now explain it'), agent('Here is the explanation.')]
  expect(lastResponse(messages)).toBe('Here is the explanation.')
})

test('lastResponse is empty with no messages, no assistant text, or only blank text', () => {
  expect(lastResponse([])).toBe('')
  expect(lastResponse([user('hello')])).toBe('')
  expect(lastResponse([user('hello'), toolOnly(), agent('  \n ')])).toBe('')
})

test('lastResponse returns the whole text, trimmed, with nothing clipped', () => {
  const long = `${'word '.repeat(2000)}END`
  expect(lastResponse([user('x'), agent(`\n${long}\n`)])).toBe(long)
})

test('an answered reply becomes a ready text', () => {
  const reply: ModelCompleteResult = { isAnswered: true, text: '  Shorter.  \n', usage: { ...ZERO, output_tokens: 10 } }
  expect(conciseResult(reply, 8000)).toEqual({ outcome: 'concise', failure: '', status: 'ready', text: 'Shorter.' })
})

test('a reply at the token limit is marked cut off, and one token under it is not', () => {
  const at: ModelCompleteResult = { isAnswered: true, text: 'Partial', usage: { ...ZERO, output_tokens: 8000 } }
  const under: ModelCompleteResult = { isAnswered: true, text: 'Partial', usage: { ...ZERO, output_tokens: 7999 } }
  const cut = conciseResult(at, 8000)
  expect(cut.status).toBe('ready')
  expect(cut.text).toMatch(/^Partial\n\n\[Cut off at the length limit/)
  expect(conciseResult(under, 8000).text).toBe('Partial')
})

test('an aborted call fails with a retry hint and no failure field', () => {
  expect(conciseResult({ isAnswered: false, reason: 'aborted', usage: ZERO }, 8000)).toEqual({
    outcome: 'aborted',
    failure: '',
    status: 'failed',
    text: 'The call was cut off. Run /summarize again.',
  })
})

test('an api error fails with its reason and message in both the failure and the text', () => {
  const result = conciseResult({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }, 8000)
  expect(result).toEqual({
    outcome: 'api-error',
    failure: 'api-error overloaded',
    status: 'failed',
    text: 'The call failed (api-error overloaded). Run /summarize again.',
  })
})

test('wrapRows breaks at word boundaries within the width', () => {
  expect(wrapRows('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps'])
})

test('wrapRows keeps blank lines and short lines as their own rows', () => {
  expect(wrapRows('one\n\ntwo\n', 20)).toEqual(['one', '', 'two', ''])
})

test('wrapRows keeps a line\'s indent on every row it wraps to', () => {
  const rows = wrapRows('    indented words that wrap onto more rows', 14)
  expect(rows.length).toBeGreaterThan(2)
  for (const row of rows) {
    expect(row.startsWith('    ')).toBe(true)
    expect(cells(row)).toBeLessThanOrEqual(14)
  }
  expect(rows.map(r => r.trim()).join(' ')).toBe('indented words that wrap onto more rows')
})

test('a word longer than the width breaks across rows without losing a character', () => {
  const word = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const rows = wrapRows(`ab ${word} cd`, 10)
  for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(10)
  expect(rows.join('').replace(/ /g, '')).toBe(`ab${word}cd`)
  expect(rows).toContain('abcdefghij'.slice(0, 10))
})

test('no row exceeds the width in cells, wide characters included', () => {
  const texts = ['日本語のテキストを折り返す日本語のテキスト', 'mixed 日本語 and ascii 日本語日本語日本語 words', '😀😀😀😀😀😀😀😀', `  - a list item with ${'x'.repeat(40)} inside`]
  for (const width of [2, 3, 5, 8, 13, 40]) {
    for (const text of texts) {
      for (const row of wrapRows(text, width)) expect(cells(row)).toBeLessThanOrEqual(width)
    }
  }
})

test('wrapping wide text loses no characters', () => {
  const text = '日本語のテキストを折り返す'
  expect(wrapRows(text, 6).join('')).toBe(text)
})

test('cells counts a wide character as two', () => {
  expect(cells('abc')).toBe(3)
  expect(cells('日本')).toBe(4)
})

const summary = EMPTY_SUMMARY
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')
const concise = (changes: Partial<Concise> = {}): Concise => ({ status: 'ready', text: lines(30), at: NOW, offset: 0, ...changes })
const layout = (c: Concise, bodyRows: number) => paneLayout({ summary, concise: c, now: NOW, columns: 60, bodyRows })
// The empty summary draws one top row: "No summary yet."
const TOP = [{ text: 'No summary yet.', dim: true }]

test('an empty concise status adds no section', () => {
  expect(paneLayout({ summary, concise: EMPTY_CONCISE, now: NOW, columns: 60, bodyRows: 20 })).toEqual({ rows: TOP, window: null })
})

test('a section that fits is drawn whole under a label and age, with no window', () => {
  const l = layout(concise({ text: 'alpha\nbeta', at: NOW - 3 * 60_000 }), 40)
  expect(l.window).toBeNull()
  expect(l.rows).toEqual([...TOP, { text: '' }, { text: 'SUMMARY OF LAST RESPONSE:', bold: true }, { text: 'from 3 min ago', dim: true }, { text: 'alpha' }, { text: 'beta' }])
})

test('a section exactly as tall as the room is not windowed', () => {
  // bodyRows 20 - 1 top - 3 header = 16 rows of room
  const l = layout(concise({ text: lines(16) }), 20)
  expect(l.window).toBeNull()
  expect(l.rows).toHaveLength(1 + 3 + 16)
})

test('an overlong section keeps every top row and shows exactly the room\'s rows, with the position in the age row', () => {
  const l = layout(concise(), 20)
  expect(l.window).toEqual({ rows: 16, maxOffset: 14 })
  expect(l.rows.slice(0, 3)).toEqual([...TOP, { text: '' }, { text: 'SUMMARY OF LAST RESPONSE:', bold: true }])
  expect(l.rows[3]).toEqual({ text: 'from 0 min ago · rows 1-16 of 30', dim: true })
  expect(l.rows.slice(4).map(r => r.text)).toEqual(Array.from({ length: 16 }, (_, i) => `line ${i + 1}`))
  expect(l.rows).toHaveLength(20)
})

test('scrolling the window moves the section rows and the position, never the top rows', () => {
  const top = layout(concise(), 20).rows.slice(0, 3)
  const l = layout(concise({ offset: 5 }), 20)
  expect(l.rows.slice(0, 3)).toEqual(top)
  expect(l.rows[3]!.text).toBe('from 0 min ago · rows 6-21 of 30')
  expect(l.rows[4]!.text).toBe('line 6')
  expect(l.rows.at(-1)!.text).toBe('line 21')
})

test('an offset past the end clamps to the last full window, and a negative one to the first', () => {
  const end = layout(concise({ offset: 999 }), 20)
  expect(end.rows[3]!.text).toBe('from 0 min ago · rows 15-30 of 30')
  expect(end.rows.at(-1)!.text).toBe('line 30')
  expect(layout(concise({ offset: -4 }), 20).rows[3]!.text).toBe('from 0 min ago · rows 1-16 of 30')
})

test('with fewer than CONCISE_MIN_ROWS of room there is no window and every row is drawn', () => {
  const bodyRows = 1 + 3 + (CONCISE_MIN_ROWS - 1)
  const l = layout(concise({ offset: 4 }), bodyRows)
  expect(l.window).toBeNull()
  expect(l.rows).toHaveLength(1 + 3 + 30)
  expect(l.rows[3]!.text).toBe('from 0 min ago')
  expect(l.rows[4]!.text).toBe('line 1')
})

test('with exactly CONCISE_MIN_ROWS of room the section is windowed', () => {
  const l = layout(concise(), 1 + 3 + CONCISE_MIN_ROWS)
  expect(l.window).toEqual({ rows: CONCISE_MIN_ROWS, maxOffset: 30 - CONCISE_MIN_ROWS })
})

test('the age row says working or failed instead of an age', () => {
  expect(layout(concise({ status: 'working', text: 'Shortening the last response.' }), 40).rows[3]!.text).toBe('working')
  expect(layout(concise({ status: 'failed', text: 'The call failed.' }), 40).rows[3]!.text).toBe('failed')
})

test('the age is whole minutes since the command last wrote, never negative', () => {
  expect(layout(concise({ text: 'x', at: NOW - 125_000 }), 40).rows[3]!.text).toBe('from 2 min ago')
  expect(layout(concise({ text: 'x', at: NOW + 60_000 }), 40).rows[3]!.text).toBe('from 0 min ago')
})

const WINDOW = { rows: 16, maxOffset: 14 }

test('a wheel step moves the section by its rows in either direction', () => {
  expect(scrolledOffset({ offset: 3, by: 1, bodyRows: 20, window: WINDOW })).toBe(4)
  expect(scrolledOffset({ offset: 3, by: -1, bodyRows: 20, window: WINDOW })).toBe(2)
  expect(scrolledOffset({ offset: 3, by: 3, bodyRows: 20, window: WINDOW })).toBe(6)
})

test('a page key moves by the section\'s rows, not the pane\'s', () => {
  expect(scrolledOffset({ offset: 0, by: 20, bodyRows: 20, window: { rows: 12, maxOffset: 40 } })).toBe(12)
  expect(scrolledOffset({ offset: 30, by: -20, bodyRows: 20, window: { rows: 12, maxOffset: 40 } })).toBe(18)
})

test('scrolling clamps at the first row and at the last window', () => {
  expect(scrolledOffset({ offset: 0, by: -1, bodyRows: 20, window: WINDOW })).toBe(0)
  expect(scrolledOffset({ offset: 2, by: -20, bodyRows: 20, window: WINDOW })).toBe(0)
  expect(scrolledOffset({ offset: 14, by: 1, bodyRows: 20, window: WINDOW })).toBe(14)
  expect(scrolledOffset({ offset: 10, by: 20, bodyRows: 20, window: WINDOW })).toBe(14)
  expect(scrolledOffset({ offset: 0, by: 500, bodyRows: 20, window: WINDOW })).toBe(14)
})
