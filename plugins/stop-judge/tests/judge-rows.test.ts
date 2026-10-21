import { expect, test } from 'claude-code/testing'
import { buildUser, clip, FRAMING, framingAndPrior, guardOutcome, minutesFact, minutesSinceOperator, parseRows, splitTurn } from '../hooks/judge.ts'
import type { TranscriptRow } from '../hooks/shared/typed.ts'

const at = (minute: number) => `2026-10-20T12:${String(minute).padStart(2, '0')}:00.000Z`

function typed(text: string, minute: number): TranscriptRow {
  return {
    type: 'user',
    timestamp: at(minute),
    message: { content: text },
    origin: { kind: 'human' },
    promptSource: 'typed',
    turnOrigin: 'human',
  }
}

function assistant(content: unknown): TranscriptRow {
  return { type: 'assistant', message: { content } }
}

test('unparseable and sidechain JSON lines never become transcript rows', async () => {
  const row = typed('one real question', 1)
  const rows = parseRows([JSON.stringify({ ...row, isSidechain: true }), 'not JSON', JSON.stringify(row)].join('\n'))

  expect(rows).toEqual([row])
})

test('the newest typed row determines whole minutes, while machine prompts leave no operator gap', async () => {
  const pluginRow: TranscriptRow = {
    type: 'user',
    timestamp: at(59),
    message: { content: 'keepalive ping. Reply only: ok' },
    origin: { kind: 'plugin', name: 'cache-keepalive', asUser: true },
    promptSource: 'system',
    turnOrigin: 'system',
  }
  const now = new Date('2026-10-20T13:00:00.000Z')

  expect(minutesSinceOperator([typed('older question', 45), typed('newer question', 53), pluginRow], now)).toBe(7)
  expect(minutesSinceOperator([pluginRow], now)).toBe(null)
})

test('the minutes fact is the final line before the judge output instruction, and absent without a gap', async () => {
  const withFact = buildUser('final text', 'opening text', ['prior text'], 7, false, true)
  const withoutFact = buildUser('final text', 'opening text', ['prior text'], null, false, true)
  const suffix = "Minutes since the operator's last typed message: 7\n\nOne JSON line."

  expect(withFact.slice(-suffix.length)).toBe(suffix)
  expect(withoutFact).not.toContain("Minutes since the operator's last typed message")
})

test('consulting language frames prior context but a grilling skill name does not', async () => {
  const users = ['first instruction', '/some-skill this', 'lets discuss it', 'ask me one by one', 'older note', 'recent one', 'recent two', 'recent three', 'recent four']

  expect(FRAMING.test('lets discuss it')).toBe(true)
  expect(FRAMING.test('ask me one by one')).toBe(true)
  expect(FRAMING.test('/some-skill this')).toBe(false)
  expect(framingAndPrior(users)).toEqual(['first instruction', 'lets discuss it', 'ask me one by one', 'recent one', 'recent two', 'recent three', 'recent four'])
})

test('a completed turn keeps its human opening, prior requests, and all visible final text', async () => {
  const rows: TranscriptRow[] = [
    typed('zeroth ask', 1),
    assistant([{ type: 'text', text: 'Zeroth answer.' }]),
    typed('first ask', 2),
    assistant([{ type: 'text', text: 'Earlier answer.' }]),
    typed('<bash-input>ls</bash-input>', 3),
    typed('<bash-stdout>output</bash-stdout>', 4),
    { type: 'attachment', timestamp: at(5), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } } },
    typed('open the PR when green', 6),
    { type: 'user', timestamp: at(7), message: { content: [{ type: 'tool_result', content: 'tool output' }] }, origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human' },
    { type: 'attachment', timestamp: at(8), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'ask me one by one before you push', origin: { kind: 'human' } }, promptSource: 'queued', turnOrigin: 'human' },
    assistant([{ type: 'text', text: 'Green.' }, { type: 'text', text: null }, { type: 'text', text: 'Want me to open the PR?' }]),
    { type: 'system', subtype: 'other' },
  ]

  expect(splitTurn(rows, undefined)).toEqual({
    opening: 'ask me one by one before you push',
    openingKind: 'human',
    prior: ['zeroth ask', 'first ask', 'open the PR when green'],
    final: 'Green.\n\nWant me to open the PR?',
  })
})

test('a plugin keepalive opening is passed without judging the short reply', async () => {
  const rows: TranscriptRow[] = [
    {
      type: 'user',
      timestamp: at(10),
      message: { content: 'keepalive ping. Reply only: ok' },
      origin: { kind: 'plugin', name: 'cache-keepalive', asUser: true },
      promptSource: 'system',
      turnOrigin: 'system',
    },
    assistant([{ type: 'text', text: 'ok' }]),
  ]
  const turn = splitTurn(rows, undefined)

  expect(turn.openingKind).toBe('plugin')
  expect(guardOutcome({ isOff: false, agentId: undefined, reason: 'answer', nested: false, nudgedThisPrompt: false, ...turn })).toBe('pass-keepalive')
})

test('clipping preserves both the instruction at the start and question at the end', async () => {
  expect(clip('a'.repeat(50) + 'b'.repeat(50), 20)).toBe('a'.repeat(10) + '\n…\n' + 'b'.repeat(10))
})

test('the minutes fact is exact with a typed row in the tail, a lower bound from the oldest timed row without one, and absent with no time', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  const typedAt = (iso: string) => ({ type: 'user', timestamp: iso, message: { role: 'user', content: 'go on' } })
  const plugin = (iso: string) => ({ type: 'user', timestamp: iso, message: { role: 'user', content: 'keepalive ping' }, origin: { kind: 'plugin' }, promptSource: 'system' })
  const agent = (iso: string) => ({ type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: 'ok' }] } })
  expect(minutesFact([agent('2026-10-20T10:00:00Z'), typedAt('2026-10-20T11:53:00Z'), agent('2026-10-20T11:59:00Z')], now)).toEqual({ minutes: 7, isLowerBound: false })
  expect(minutesFact([{ type: 'assistant' }, agent('2026-10-20T10:20:30Z'), plugin('2026-10-20T11:00:00Z'), agent('2026-10-20T11:59:00Z')], now)).toEqual({ minutes: 99, isLowerBound: true })
  expect(minutesFact([], now)).toBeNull()
  expect(minutesFact([{ type: 'assistant', timestamp: 'garbled' }], now)).toBeNull()
  expect(minutesSinceOperator([plugin('2026-10-20T11:00:00Z')], now)).toBeNull()
})
