import { expect, test } from 'claude-code/testing'
import type { ModelCompleteResult } from 'claude-code'
import { addCall, firingReason, replyResult } from '../hooks/call.ts'

const previous = { soFar: 'Set the plugin up.', now: 'Writing tests.', files: ['src/old.ts'] }
const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 }
const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('a full reply is a summary the pane takes', () => {
  const reply: ModelCompleteResult = { isAnswered: true, text: 'SO FAR: built it\nNOW: testing it\nFILES: src/new.ts', usage }

  expect(replyResult(reply, previous, ['src/new.ts'], 'running')).toEqual({
    outcome: 'summary',
    failure: '',
    texts: { soFar: 'built it', now: 'testing it', files: ['src/new.ts'] },
    isTaken: true,
  })
})

test('a partial reply is taken, an unparsable one is not', () => {
  const partial: ModelCompleteResult = { isAnswered: true, text: 'NOW: testing it', usage }
  const prose: ModelCompleteResult = { isAnswered: true, text: 'I cannot tell.', usage }

  expect(replyResult(partial, previous, ['src/new.ts'], 'running')).toMatchObject({ outcome: 'parse-partial', isTaken: true })
  expect(replyResult(prose, previous, ['src/new.ts'], 'running')).toEqual({ outcome: 'parse-failed', failure: '', texts: previous, isTaken: false })
})

test('an unanswered reply is aborted when cut, else an api-error naming why, and neither is taken', () => {
  const cut: ModelCompleteResult = { isAnswered: false, reason: 'aborted', usage: zero }
  const refused: ModelCompleteResult = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: zero }
  const empty: ModelCompleteResult = { isAnswered: false, reason: 'empty-reply', usage }

  expect(replyResult(cut, previous, [], 'running')).toEqual({ outcome: 'aborted', failure: '', texts: previous, isTaken: false })
  expect(replyResult(refused, previous, [], 'running')).toEqual({ outcome: 'api-error', failure: 'api-error overloaded', texts: previous, isTaken: false })
  expect(replyResult(empty, previous, [], 'ended')).toEqual({ outcome: 'api-error', failure: 'empty-reply', texts: previous, isTaken: false })
})

test('each call adds its tokens and dollars to the session totals', () => {
  const once = addCall({ count: 0, input: 0, output: 0, cached: 0, usd: 0 }, usage, 0.25)
  expect(once).toEqual({ count: 1, input: 1200, output: 80, cached: 300, usd: 0.25 })
  expect(addCall(once, zero, 0)).toEqual({ ...once, count: 2 })
})

test('every firing reason leads with the same six fields in the read-back order', () => {
  expect(firingReason({ source: 'messages', variant: 'edit', usage, usd: 0.000158 })).toBe('source=messages variant=edit in=1200 out=80 cached=300 usd=0.0002')
  expect(firingReason({ source: 'session-log', variant: 'append' })).toBe('source=session-log variant=append in=0 out=0 cached=0 usd=0.0000')
  expect(firingReason({ source: 'messages', variant: 'edit', usage: zero, usd: 0, failure: 'api-error overloaded' })).toBe(
    'source=messages variant=edit in=0 out=0 cached=0 usd=0.0000 api-error overloaded',
  )
})
