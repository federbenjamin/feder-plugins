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
import type { Concise, ConciseEntry } from '../types'
import { CONCISE_ENTRIES_MAX, CONCISE_LABEL, CONCISE_MIN_ROWS, CONCISE_TEXT_INSET } from '../hooks/config'
import { addEntry, cells, conciseAction, conciseResult, conciseView, EMPTY_CONCISE, entryLabel, lastResponse, scrolledOffset, settleEntry, toggleEntry, wrapRows } from '../hooks/concise'
import type { ConciseRow } from '../hooks/concise'

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

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')
const entry = (changes: Partial<ConciseEntry> = {}): ConciseEntry => ({ id: 1, status: 'ready', text: lines(30), at: NOW, responses: 0, isOpen: true, ...changes })
const concise = (changes: Partial<ConciseEntry> = {}, c: Partial<Concise> = {}): Concise => ({ ...EMPTY_CONCISE, entries: [entry(changes)], nextId: 2, ...c })
// One row above the section ("No summary yet.") and no FILES, unless a test says otherwise.
const view = (c: Concise, bodyRows: number, rows: { aboveRows?: number; fileRows?: number } = {}) => conciseView({ concise: c, now: NOW, columns: 60, bodyRows, aboveRows: rows.aboveRows ?? 1, fileRows: rows.fileRows ?? 0 })!
const head = (id: number, label: string, age: string): ConciseRow => ({ kind: 'head', id, label, age })
const text = (t: string): ConciseRow => ({ kind: 'text', text: t })
const ageOf = (v: { rows: ConciseRow[] }) => (v.rows[0] as { age: string }).age

test('a header is cut to one row after its age, with room for the scrollbar only when there is one', () => {
  const at = (columns: number, bodyRows: number, c: Concise) => conciseView({ concise: c, now: NOW, columns, bodyRows, aboveRows: 1, fileRows: 0 })!.rows[0]
  const stale = concise({ text: 'x', at: NOW - 3 * 60_000 }, { responses: 2 })
  expect(at(36, 40, stale)).toEqual(head(1, '▾ SUMMARY · 2 RESPONSES OLD', '3m ago'))
  expect(at(36, 10, concise({ text: lines(30), at: NOW - 3 * 60_000 }, { responses: 2 }))).toEqual(head(1, '▾ SUMMARY · 2 RESPONSES …', '3m ago'))
})

test('no summaries adds no section', () => {
  expect(conciseView({ concise: EMPTY_CONCISE, now: NOW, columns: 60, bodyRows: 20, aboveRows: 1, fileRows: 0 })).toBeNull()
})

test('a section that fits is drawn whole, a header with its age then the text, and no window', () => {
  expect(view(concise({ text: 'alpha\nbeta', at: NOW - 3 * 60_000 }), 40)).toEqual({
    rows: [head(1, `▾ ${CONCISE_LABEL}`, '3m ago'), text('alpha'), text('beta')],
    bar: [],
    window: null,
  })
})

test('a collapsed summary is its header alone, marked closed', () => {
  expect(view(concise({ isOpen: false }), 40).rows).toEqual([head(1, `▸ ${CONCISE_LABEL}`, 'just now')])
})

test('the text wraps inside the indent and the scrollbar column', () => {
  const rows = view(concise({ text: 'word '.repeat(40) }), 40).rows.filter((r): r is Extract<ConciseRow, { kind: 'text' }> => r.kind === 'text')
  expect(rows.length).toBeGreaterThan(1)
  for (const row of rows) expect(cells(row.text)).toBeLessThanOrEqual(60 - CONCISE_TEXT_INSET)
})

test('summaries list newest first, a blank row between open ones, a collapsed one as its header alone', () => {
  const c: Concise = {
    ...EMPTY_CONCISE,
    responses: 2,
    entries: [entry({ id: 3, text: 'new', responses: 2 }), entry({ id: 2, text: 'mid', responses: 1, isOpen: false }), entry({ id: 1, text: 'old', responses: 0 })],
  }
  expect(view(c, 40).rows).toEqual([
    head(3, `▾ ${CONCISE_LABEL}`, 'just now'),
    text('new'),
    text(''),
    head(2, '▸ SUMMARY · 1 RESPONSE OLD', 'just now'),
    head(1, '▾ SUMMARY · 2 RESPONSES OLD', 'just now'),
    text('old'),
  ])
})

test('a section exactly as tall as the room is not windowed', () => {
  // bodyRows 20 - 1 above - 1 gap = 18 rows of room: the header and 17 lines
  const v = view(concise({ text: lines(17) }), 20)
  expect(v.window).toBeNull()
  expect(v.rows).toHaveLength(18)
})

test('an overlong section shows exactly the room\'s rows, one scrollbar mark per row, and no position text', () => {
  const v = view(concise(), 20)
  expect(v.window).toEqual({ rows: 18, maxOffset: 13 })
  expect(v.rows[0]).toEqual(head(1, `▾ ${CONCISE_LABEL}`, 'just now'))
  expect(v.rows.slice(1)).toEqual(Array.from({ length: 17 }, (_, i) => text(`line ${i + 1}`)))
  expect(v.bar).toHaveLength(18)
  expect(v.bar[0]).toBe('█')
  expect(v.bar.at(-1)).toBe('│')
})

test('scrolling moves the window over the one flattened list: the header scrolls out with the top', () => {
  const v = view(concise({}, { offset: 13 }), 20)
  expect(v.rows[0]).toEqual(text('line 13'))
  expect(v.rows.at(-1)).toEqual(text('line 30'))
  expect(v.bar[0]).toBe('│')
  expect(v.bar.at(-1)).toBe('█')
})

test('the window runs across a summary boundary into the next summary\'s header', () => {
  const c: Concise = { ...EMPTY_CONCISE, responses: 1, entries: [entry({ id: 2, text: lines(10), responses: 1 }), entry({ id: 1, text: lines(10), responses: 0, isOpen: false })] }
  // section: head, 10 lines, blank, head = 13 rows; room = 12 - 1 above - 1 gap = 10, which is over CONCISE_MIN_ROWS
  const v = view({ ...c, offset: 3 }, 12)
  expect(v.window).toEqual({ rows: 10, maxOffset: 3 })
  expect(v.rows[0]).toEqual(text('line 3'))
  expect(v.rows.at(-2)).toEqual(text(''))
  expect(v.rows.at(-1)).toEqual(head(1, '▸ SUMMARY · 1 RESPONSE OLD', 'just now'))
})

test('an offset past the end clamps to the last full window, and a negative one to the first', () => {
  const end = view(concise({}, { offset: 999 }), 20)
  expect(end.rows[0]).toEqual(text('line 13'))
  expect(end.rows.at(-1)).toEqual(text('line 30'))
  expect(view(concise({}, { offset: -4 }), 20).rows[0]!.kind).toBe('head')
})

test('with little room left by the texts, the section still keeps CONCISE_MIN_ROWS', () => {
  const v = view(concise(), 20, { aboveRows: 18 })
  expect(v.window).toEqual({ rows: CONCISE_MIN_ROWS, maxOffset: 31 - CONCISE_MIN_ROWS })
  expect(v.rows).toHaveLength(CONCISE_MIN_ROWS)
})

test('FILES keeps its rows however short the pane: the section gives way, to one row at least', () => {
  expect(view(concise(), 12, { aboveRows: 12, fileRows: 7 }).rows).toHaveLength(4)
  expect(view(concise(), 6, { aboveRows: 12, fileRows: 7 }).rows).toHaveLength(1)
})

test('the header says working or failed instead of an age', () => {
  expect(ageOf(view(concise({ status: 'working', text: 'Shortening the last response.' }), 40))).toBe('working')
  expect(ageOf(view(concise({ status: 'failed', text: 'The call failed.' }), 40))).toBe('failed')
})

test('the age counts from the entry\'s last write and is never negative', () => {
  expect(ageOf(view(concise({ text: 'x', at: NOW - 125_000 }), 40))).toBe('2m ago')
  expect(ageOf(view(concise({ text: 'x', at: NOW + 60_000 }), 40))).toBe('just now')
})

test('conciseAction: bare is once, the three words are themselves in any case and padding, anything else is usage', () => {
  expect(conciseAction('')).toBe('once')
  expect(conciseAction('   ')).toBe('once')
  expect(conciseAction('on')).toBe('on')
  expect(conciseAction(' EVERY ')).toBe('every')
  expect(conciseAction('Off')).toBe('off')
  expect(conciseAction('onn')).toBe('usage')
  expect(conciseAction('every other')).toBe('usage')
})

test('addEntry puts the new summary first and open, and collapses every older one', () => {
  const c1 = addEntry({ ...EMPTY_CONCISE, responses: 1, nextId: 5, offset: 7 }, 'working', 'w', 100)
  expect(c1.entries).toEqual([{ id: 5, status: 'working', text: 'w', at: 100, responses: 1, isOpen: true }])
  expect(c1.nextId).toBe(6)
  expect(c1.offset).toBe(0)
  const c2 = addEntry({ ...c1, responses: 2 }, 'working', 'x', 200)
  expect(c2.entries.map(e => [e.id, e.isOpen])).toEqual([[6, true], [5, false]])
})

test('addEntry for the same response replaces the earlier entry instead of stacking', () => {
  const c1 = addEntry({ ...EMPTY_CONCISE, responses: 3 }, 'ready', 'first', 1)
  const c2 = addEntry(c1, 'working', 'second', 2)
  expect(c2.entries).toHaveLength(1)
  expect(c2.entries[0]).toMatchObject({ id: 2, text: 'second' })
})

test('a summary with no newer one stays open however stale', () => {
  const c = addEntry(EMPTY_CONCISE, 'ready', 'a', 1)
  expect(entryLabel(c.entries[0]!, 9)).toBe('SUMMARY · 9 RESPONSES OLD')
  expect(c.entries[0]!.isOpen).toBe(true)
})

test('addEntry drops the oldest past CONCISE_ENTRIES_MAX', () => {
  let c: Concise = EMPTY_CONCISE
  for (let i = 0; i < CONCISE_ENTRIES_MAX + 3; i++) c = addEntry({ ...c, responses: i }, 'ready', `t${i}`, i)
  expect(c.entries).toHaveLength(CONCISE_ENTRIES_MAX)
  expect(c.entries[0]!.text).toBe(`t${CONCISE_ENTRIES_MAX + 2}`)
  expect(c.entries.at(-1)!.text).toBe('t3')
  expect(c.nextId).toBe(CONCISE_ENTRIES_MAX + 4)
})

test('settleEntry writes only the named entry, and nothing when it is gone', () => {
  const c: Concise = { ...EMPTY_CONCISE, entries: [entry({ id: 2, status: 'working', text: 'w' }), entry({ id: 1, text: 'keep' })] }
  const settled = settleEntry(c, 2, 'ready', 'done', 55)
  expect(settled.entries[0]).toMatchObject({ id: 2, status: 'ready', text: 'done', at: 55, isOpen: true })
  expect(settled.entries[1]).toEqual(c.entries[1])
  expect(settleEntry(c, 99, 'ready', 'ghost', 1)).toEqual(c)
})

test('toggleEntry flips only the named entry and keeps its text', () => {
  const c: Concise = { ...EMPTY_CONCISE, entries: [entry({ id: 2 }), entry({ id: 1 })] }
  const once = toggleEntry(c, 1)
  expect(once.entries.map(e => e.isOpen)).toEqual([true, false])
  expect(toggleEntry(once, 1)).toEqual(c)
  expect(toggleEntry(c, 99)).toEqual(c)
})

test('entryLabel names the last response until one finishes, then counts responses', () => {
  expect(entryLabel(entry({ responses: 4 }), 4)).toBe(CONCISE_LABEL)
  expect(entryLabel(entry({ responses: 4 }), 5)).toBe('SUMMARY · 1 RESPONSE OLD')
  expect(entryLabel(entry({ responses: 4 }), 6)).toBe('SUMMARY · 2 RESPONSES OLD')
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
