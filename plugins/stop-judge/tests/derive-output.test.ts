import { expect, test } from 'claude-code/testing'
import { capSynthesisInput, contentOfReply, parseReaderLines, verifyReaderLines } from '../hooks/derive.ts'
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

test('a reader line may be a principle; a line naming any other side is skipped', () => {
  const line = (side: string) => JSON.stringify({ side, topic: 'fixes', claim: 'The root cause wins over a patch.', quote: 'root cause', session: 'session-1', turn: 3, strength: 'strong' })

  const parsed = parseReaderLines([line('principle'), line('rule')].join('\n'), { 'session-1': '2026-10-20' })

  expect(parsed.map(l => l.side)).toEqual(['principle'])
})

test('the synthesis reply loses its code fence, and a quote mark it copied escaped from the JSON findings becomes a single quote', () => {
  const reply = '```markdown\n- Say so. -- "they said \\"no\\" twice" (2026-10-20)\n```'

  expect(contentOfReply(reply)).toBe(`- Say so. -- "they said 'no' twice" (2026-10-20)`)
})
