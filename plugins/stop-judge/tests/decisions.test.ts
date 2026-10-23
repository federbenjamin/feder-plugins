import { expect, test } from 'claude-code/testing'
import { fitContext, keepVerifiedBullets, quoteKey, rulesOnly, validateDecisions } from '../hooks/decisions.ts'
import { verifyReaderLines } from '../hooks/derive.ts'
import type { ReaderLine } from '../hooks/derive.ts'

const DEFAULT_LINE = 'Decide everything you can yourself. Bring only what is listed under "Bring to me" to the operator.'

function decisions(bringBullets: readonly string[], howBullets: readonly string[]): string {
  return [
    '# Decisions (derived 2026-10-20, 3 sessions, latest 2,000 turns)',
    '',
    DEFAULT_LINE,
    '',
    '## Bring to me',
    ...bringBullets,
    '## How to decide',
    '### Delivery',
    ...howBullets,
  ].join('\n')
}

const bring = '- Ask before changing the agreed scope. -- "ask before changing scope" (2026-10-20)'
const how = '- Prefer the smallest useful change. -- "keep it focused" "avoid speculative layers" (2026-10-19)'

test('a decisions file accepts bullets with one or two dated, quote-safe sources', () => {
  const oneQuote = decisions([bring], [])
  const twoQuotes = decisions([], [how])

  expect(validateDecisions(oneQuote)).toEqual({ ok: true })
  expect(validateDecisions(twoQuotes)).toEqual({ ok: true })
})

test('a decisions bullet without its required date is rejected', () => {
  const text = decisions(['- Ask before changing the agreed scope. -- "ask before changing scope"'], [])

  expect(validateDecisions(text).ok).toBe(false)
})

test('a decisions bullet rejects overlong quotes and inner double quotes', () => {
  const overlong = decisions([`- Keep the scope visible. -- "${'x'.repeat(201)}" (2026-10-20)`], [])
  const innerQuote = decisions(['- Keep the scope visible. -- "say "yes" first" (2026-10-20)'], [])

  expect(validateDecisions(overlong).ok).toBe(false)
  expect(validateDecisions(innerQuote).ok).toBe(false)
})

test('context fitting removes the newest How-to-decide bullets before losing a Bring-to-me rule', () => {
  const earlyHow = '- Prefer the direct fix. -- "fix the cause" (2026-10-19)'
  const lateHow = `- Verify the result before reporting it. -- "${'verify before reporting '.repeat(12)}" (2026-10-20)`
  const source = decisions([bring], [earlyHow, lateHow])
  const beforeLateBullet = rulesOnly(decisions([bring], [earlyHow])).length

  const fitted = fitContext(source, beforeLateBullet)

  expect(fitted).toContain(bring)
  expect(fitted).toContain(earlyHow)
  expect(fitted).not.toContain(lateHow)
  expect(rulesOnly(fitted).trimEnd().length).toBeLessThanOrEqual(beforeLateBullet)
})

test('context fitting preserves Bring-to-me rules even when every How-to-decide bullet must go', () => {
  const firstHow = `- Keep a focused plan. -- "${'focus the plan '.repeat(12)}" (2026-10-19)`
  const secondHow = `- Use evidence before claiming success. -- "${'show the evidence '.repeat(12)}" (2026-10-20)`
  const source = decisions([bring], [firstHow, secondHow])
  const maxChars = rulesOnly(decisions([bring], [])).length + 10

  const fitted = fitContext(source, maxChars)

  expect(fitted).toContain(bring)
  expect(fitted).not.toContain(firstHow)
  expect(fitted).not.toContain(secondHow)
  expect(rulesOnly(fitted).trimEnd().length).toBeLessThanOrEqual(maxChars)
  expect(fitted.endsWith('\n\n')).toBe(false)
})

test('one quote key: double quotes become single and whitespace runs one space, for reader and file quotes alike', () => {
  expect(quoteKey('  say  "no"\n\tfirst ')).toBe("say 'no' first")
  const line: ReaderLine = { side: 'bring', topic: 't', claim: 'c', quote: 'say "no"   first', session: 's', turn: 1, strength: 'strong', date: '2026-10-20' }
  expect(verifyReaderLines([line], 'then I said: say "no" first, always')).toEqual([line])
  const file = "- Refuse first. -- \"say 'no' first\" (2026-10-20)"
  expect(keepVerifiedBullets(file, [{ quote: line.quote, date: line.date }])).toEqual({ text: file, dropped: 0 })
})
