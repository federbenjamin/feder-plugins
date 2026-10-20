import { expect, test } from 'claude-code/testing'
import { capSynthesisInput, verifyReaderLines } from '../hooks/derive.ts'
import type { ReaderLine } from '../hooks/derive.ts'

function finding(overrides: Partial<ReaderLine> = {}): ReaderLine {
  return {
    side: 'bring',
    topic: 'scope',
    claim: 'Ask before changing the agreed scope.',
    quote: 'ask before changing scope',
    session: 'session-1',
    turn: 1,
    strength: 'medium',
    date: '2026-10-20',
    ...overrides,
  }
}

test('reader findings retain a whitespace-normalised verbatim operator quote and discard invented wording', () => {
  const matching = finding({ quote: 'ask\n\tbefore   changing scope' })
  const invented = finding({ quote: 'choose the database for me', session: 'session-2' })

  expect(verifyReaderLines([matching, invented], 'Please ask before changing scope; I need to review it.')).toEqual([matching])
})

test('the synthesis cap removes weak evidence before older stronger evidence', () => {
  const oldestMedium = finding({ quote: 'medium oldest', session: 'session-1', strength: 'medium', date: '2026-10-18' })
  const newestWeak = finding({ quote: 'weak newest', session: 'session-2', strength: 'weak', date: '2026-10-20' })
  const newestStrong = finding({ quote: 'strong newest', session: 'session-3', strength: 'strong', date: '2026-10-21' })

  const capped = capSynthesisInput([oldestMedium, newestWeak, newestStrong], 200)

  expect(capped).toEqual({ kept: [newestStrong], dropped: 2 })
})
