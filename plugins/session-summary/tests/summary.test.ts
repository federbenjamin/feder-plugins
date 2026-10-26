import { expect, test } from 'claude-code/testing'
import { formatLog, formatMessages, isBumpTurn, isDue } from '../hooks/summary.ts'

const STARTED = 1_000_000

test('the first summary waits for its shorter delay, then later summaries wait for the recurring delay', () => {
  const base = { turnStartedAt: STARTED, lastCallAt: 0, isOff: false, firstSeconds: 90, everySeconds: 600 }

  expect(isDue({ ...base, now: STARTED + 89_999 })).toBe(false)
  expect(isDue({ ...base, now: STARTED + 90_000 })).toBe(true)
  expect(isDue({ ...base, now: STARTED + 90_000, lastCallAt: STARTED + 90_000 })).toBe(false)
  expect(isDue({ ...base, now: STARTED + 690_000, lastCallAt: STARTED + 90_000 })).toBe(true)
  expect(isDue({ ...base, now: STARTED + 9_000_000, isOff: true })).toBe(false)
})

test('only the two keepalive prompts identify a bump turn', () => {
  expect(isBumpTurn('keepalive ping. Reply only: ok')).toBe(true)
  expect(isBumpTurn('Last keepalive ping. Write a handoff.')).toBe(true)
  expect(isBumpTurn('reply to the keepalive ping')).toBe(false)
  expect(isBumpTurn('automessage: user is away')).toBe(false)
})

test('message formatting distinguishes typed requests, machine notes, assistant work, and tool failures', () => {
  const messages = [
    { role: 'user', text: '  add the edge case  ', toolUses: [] },
    { role: 'user', text: '  <system-reminder> tool finished  ', toolUses: [] },
    {
      role: 'assistant',
      text: '  I am checking the result.  ',
      toolUses: [
        { tool: 'Read', input: { file_path: 'docs/brief.md' }, isError: false },
        { tool: 'Bash', input: { command: 'run-check' }, isError: true },
      ],
    },
    { role: 'user', text: '   ', toolUses: [] },
  ] as never

  expect(formatMessages(messages, { windowChars: 2_000, messageChars: 200, userChars: 200 })).toBe([
    'USER: add the edge case',
    'NOTE: <system-reminder> tool finished',
    'ASSISTANT: I am checking the result.\n  → Read: docs/brief.md\n  → Bash: run-check (error)',
  ].join('\n'))
})

test('the activity window keeps the newest block even when earlier blocks would fit alone', () => {
  const messages = [
    { role: 'user', text: 'first request', toolUses: [] },
    { role: 'assistant', text: 'middle response', toolUses: [] },
    { role: 'user', text: 'last request', toolUses: [] },
  ] as never

  expect(formatMessages(messages, { windowChars: 20, messageChars: 200, userChars: 200 })).toBe('USER: last request')
})

test('a typed request keeps its own larger cap, start and end, while agent text keeps the message cap', () => {
  const messages = [
    { role: 'user', text: '0123456789abcdef', toolUses: [] },
    { role: 'assistant', text: '0123456789abcdef', toolUses: [] },
  ] as never

  expect(formatMessages(messages, { windowChars: 200, messageChars: 10, userChars: 14 })).toBe('USER: 0123456\n…\n9abcdef\nASSISTANT: 01234\n…\nbcdef')
})

test('a long session log loses its partial first line while an exact window stays untouched', () => {
  expect(formatLog('alpha\nbeta', 10)).toBe('alpha\nbeta')
  expect(formatLog('first line\nlatest work', 13)).toBe('latest work')
})

test('a multi-line tool input is one tool line', () => {
  const messages = [
    { role: 'assistant', text: 'Running it.', toolUses: [{ tool: 'Bash', input: { command: 'cd app &&\n  pnpm test\r\n\techo done\n' } }] },
  ] as never

  expect(formatMessages(messages, { windowChars: 2_000, messageChars: 200, userChars: 200 })).toBe('ASSISTANT: Running it.\n  → Bash: cd app && pnpm test echo done')
})

test('a tool input over the line cap is still one line, its elision folded in', () => {
  const command = `${'a'.repeat(200)}\n${'b'.repeat(200)}`
  const messages = [{ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command } }, { tool: 'Read', input: { file_path: 'x.md' } }] }] as never

  expect(formatMessages(messages, { windowChars: 2_000, messageChars: 200, userChars: 200 }).split('\n')).toEqual([`  → Bash: ${'a'.repeat(150)} … ${'b'.repeat(150)}`, '  → Read: x.md'])
})
