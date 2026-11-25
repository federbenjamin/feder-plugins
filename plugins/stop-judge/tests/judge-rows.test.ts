import { expect, test } from 'claude-code/testing'
import { guardOutcome, nudgeFollowUp, parseRows, splitTurn } from '../hooks/judge'
import type { TranscriptRow } from '../hooks/shared/typed'

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

test('a completed turn keeps its human opening and all visible final text', async () => {
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
    final: 'Green.\n\nWant me to open the PR?',
  })
})

test('a row after the final assistant row is not the opening, and an answer stands in for a missing row', async () => {
  expect(splitTurn([typed('ask', 1), assistant([{ type: 'text', text: 'Done.' }]), typed('typed since', 2)], undefined)).toEqual({ final: 'Done.', opening: 'ask', openingKind: 'human' })
  expect(splitTurn([typed('ask', 1)], 'The engine answer.')).toEqual({ final: 'The engine answer.', opening: 'ask', openingKind: 'human' })
  expect(splitTurn([], undefined)).toEqual({ final: '', opening: '', openingKind: 'none' })
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

test('what a nudge led to: cut short, work, or an answer alone, counted from the last nudge on', () => {
  const nudge: TranscriptRow = { type: 'user', message: { content: 'STOP JUDGE — nothing holds it: Open the PR.' }, origin: { kind: 'plugin' } }
  const call = assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])
  const said = assistant([{ type: 'text', text: 'Done.' }])
  expect(nudgeFollowUp([typed('go', 1), call, said], 'answer')).toBe(null)
  expect(nudgeFollowUp([typed('go', 1), call, nudge, said], 'answer')).toEqual({ followup: 'answered', toolCalls: 0 })
  expect(nudgeFollowUp([nudge, call, nudge, call, call, said], 'answer')).toEqual({ followup: 'worked', toolCalls: 2 })
  expect(nudgeFollowUp([nudge, call], 'aborted')).toEqual({ followup: 'interrupted', toolCalls: 1 })
})
