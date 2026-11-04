import { expect, test } from 'claude-code/testing'
import type { ModelCompleteResult } from 'claude-code'
import { addCall, firingReason, replyResult } from '../hooks/call.ts'

const previous = { title: 'Summary plugin', lastPrompt: '', soFar: 'Set the plugin up.', now: 'Writing tests.' }
const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 }
const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const allowed = { candidates: ['/repo/new.md'], judgeable: ['/repo/old.md'] }
const FILES = 'ADD: /repo/new.md\nSUPERSEDED: /repo/old.md'
const noVerdict = { add: [], superseded: [] }

test('a full reply is a summary the pane takes, with its TASK verdict', () => {
  const reply: ModelCompleteResult = { isAnswered: true, text: 'TASK: New\nTITLE: Summary plugin\nLAST PROMPT: You asked to build it.\nSO FAR: built it\nNOW: testing it', usage }

  expect(replyResult(reply, previous, allowed)).toEqual({
    outcome: 'summary',
    failure: '',
    task: 'new',
    texts: { title: 'Summary plugin', lastPrompt: 'You asked to build it.', soFar: 'built it', now: 'testing it' },
    isTaken: true,
    verdict: noVerdict,
  })
})

test('the file lines ride on a taken reply, and do not change its outcome', () => {
  const texts = 'TITLE: Summary plugin\nLAST PROMPT: You asked to build it.\nSO FAR: built it\nNOW: testing it'
  const verdict = { add: ['/repo/new.md'], superseded: ['/repo/old.md'] }
  expect(replyResult({ isAnswered: true, text: `${texts}\n${FILES}`, usage }, previous, allowed)).toMatchObject({ outcome: 'summary', isTaken: true, verdict })
  expect(replyResult({ isAnswered: true, text: `NOW: testing it\n${FILES}`, usage }, previous, allowed)).toMatchObject({ outcome: 'parse-partial', isTaken: true, verdict })
})

test('a reply of file lines alone is unparsable and leaves the list as it is', () => {
  expect(replyResult({ isAnswered: true, text: FILES, usage }, previous, allowed)).toEqual({ outcome: 'parse-failed', failure: '', task: null, texts: previous, isTaken: false, verdict: noVerdict })
})

test('a partial reply is taken, an unparsable one is not', () => {
  const partial: ModelCompleteResult = { isAnswered: true, text: 'NOW: testing it', usage }
  const prose: ModelCompleteResult = { isAnswered: true, text: 'I cannot tell.', usage }

  expect(replyResult(partial, previous, allowed)).toMatchObject({ outcome: 'parse-partial', task: null, isTaken: true })
  expect(replyResult(prose, previous, allowed)).toEqual({ outcome: 'parse-failed', failure: '', task: null, texts: previous, isTaken: false, verdict: noVerdict })
  expect(replyResult({ ...partial, text: 'TASK: maybe\nNOW: testing it' }, previous, allowed)).toMatchObject({ task: null, isTaken: true })
})

test('an unanswered reply is aborted when cut, else an api-error naming why, and neither is taken', () => {
  const cut: ModelCompleteResult = { isAnswered: false, reason: 'aborted', usage: zero }
  const refused: ModelCompleteResult = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: zero }
  const empty: ModelCompleteResult = { isAnswered: false, reason: 'empty-reply', usage }

  expect(replyResult(cut, previous, allowed)).toEqual({ outcome: 'aborted', failure: '', task: null, texts: previous, isTaken: false, verdict: noVerdict })
  expect(replyResult(refused, previous, allowed)).toEqual({ outcome: 'api-error', failure: 'api-error overloaded', task: null, texts: previous, isTaken: false, verdict: noVerdict })
  expect(replyResult(empty, previous, allowed)).toEqual({ outcome: 'api-error', failure: 'empty-reply', task: null, texts: previous, isTaken: false, verdict: noVerdict })
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
