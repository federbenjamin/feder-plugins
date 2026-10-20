import { expect, test } from 'claude-code/testing'
import { countOutcomes, firingLine } from '../hooks/shared/firing.ts'
import { contentText, isTypedText, typedText } from '../hooks/shared/typed.ts'

const humanRow = (content: unknown) => ({
  type: 'user',
  message: { role: 'user', content },
  origin: { kind: 'human' },
})

test('only text blocks become transcript content', () => {
  expect(contentText([
    { type: 'text', text: 'first' },
    { type: 'tool_result', text: 'private' },
    { type: 'text', text: 'second' },
    { type: 'text' },
  ])).toBe('first\nsecond\n')
  expect(contentText('plain text')).toBe('plain text')
  expect(contentText({ text: 'not a content block list' })).toBe('')
})

test('a plugin nudge and a keepalive ping never become operator text', () => {
  const nudge = {
    type: 'user',
    message: { role: 'user', content: 'STOP JUDGE — continue the task.' },
    origin: { kind: 'plugin', name: 'stop-judge', asUser: true },
    promptSource: 'system',
    turnOrigin: 'system',
  }

  expect(typedText(nudge, { sdk: false })).toBeNull()
  expect(typedText(nudge, { sdk: true })).toBeNull()
  expect(typedText(humanRow('keepalive ping'), { sdk: false })).toBeNull()
})

test('an SDK opening is available to the judge but not transcript derivation', () => {
  const opening = {
    ...humanRow(' inspect the result '),
    entrypoint: 'sdk-cli',
  }

  expect(typedText(opening, { sdk: false })).toBeNull()
  expect(typedText(opening, { sdk: true })).toBe('inspect the result')
})

test('only an ordinary human row survives the text-level filters', () => {
  expect(typedText(humanRow('  write the tests  '), { sdk: false })).toBe('write the tests')
  expect(typedText({ ...humanRow('system message'), promptSource: 'system' }, { sdk: false })).toBe('system message')
  expect(typedText({ ...humanRow('not human'), origin: { kind: 'plugin' } }, { sdk: false })).toBeNull()
  expect(typedText({ type: 'user', message: { role: 'user', content: 'unattributed system row' }, promptSource: 'system' }, { sdk: false })).toBeNull()
  expect(typedText({ ...humanRow([{ type: 'tool_result', text: 'result' }]) }, { sdk: false })).toBeNull()

  expect(isTypedText('')).toBe(false)
  expect(isTypedText('<system-reminder>ignore this')).toBe(false)
  expect(isTypedText('From the owning session: do this')).toBe(false)
  expect(isTypedText('UserPromptSubmit hook supplied this')).toBe(false)
  expect(isTypedText('From the docs: keep this')).toBe(true)
})

test('a firing line is UTC-second precision, whitespace-normalized, and capped at 300 reason characters', () => {
  const reason = `  first\nsecond\t${'x'.repeat(400)}  `
  const line = firingLine('continue', 'session-7', 42, reason, new Date('2026-02-03T04:05:06.789Z'))

  expect(line).toBe(`2026-02-03T04:05:06Z continue session=session-7 ms=42 reason=first second ${'x'.repeat(287)}\n`)
})

test('outcome counts exclude malformed and older firing rows at the cutoff', () => {
  const lines = [
    '2026-02-01T11:59:59Z stop session=old ms=1 reason=before cutoff\n',
    '2026-02-01T12:00:00Z stop session=one ms=2 reason=at cutoff\n',
    '2026-02-02T00:00:00Z continue session=two ms=3 reason=after cutoff\n',
    'not a firing line',
  ]

  const counts = countOutcomes(lines, '2026-02-01T12:00:00Z')
  expect(counts.stop).toBe(1)
  expect(counts.continue).toBe(1)
  expect(counts['pass-error']).toBeUndefined()
})
