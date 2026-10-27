import { expect, test } from 'claude-code/testing'
import { mainTurnEnded, mainTurnStarted } from '../hooks/shared/events.ts'
import type { MainTurn } from '../hooks/shared/events.ts'

const running: MainTurn = { turnId: 't1', startedAt: 100 }

test('a main turn.start with nothing running begins tracking its turnId', () => {
  expect(mainTurnStarted(undefined, { turnId: 't1' })?.turnId).toBe('t1')
})

test('a subagent turn.start leaves the running main turn untouched', () => {
  expect(mainTurnStarted(running, { turnId: 'a1', agentId: 'agent-1' }, 999)).toBe(running)
})

test('a subagent turn.start does not begin tracking when nothing is running', () => {
  expect(mainTurnStarted(undefined, { turnId: 'a1', agentId: 'agent-1' }, 5)).toBeUndefined()
})

test('a main turn.start replaces a turn that is still running', () => {
  expect(mainTurnStarted(running, { turnId: 't2' }, 200)).toEqual({ turnId: 't2', startedAt: 200 })
})

test('startedAt is kept when the caller passes a clock reading', () => {
  expect(mainTurnStarted(undefined, { turnId: 't1' }, 1234)).toEqual({ turnId: 't1', startedAt: 1234 })
})

// A reading of 0 is still a reading: a truthiness check would drop it.
test('a clock reading of 0 is kept, not treated as absent', () => {
  expect(mainTurnStarted(undefined, { turnId: 't1' }, 0)?.startedAt).toBe(0)
})

// cache-keepalive passes no clock reading; the key must be absent, not present-and-undefined,
// and a previous turn's startedAt must not leak into the replacement.
test('startedAt is absent when no reading is passed, even replacing a turn that had one', () => {
  const fresh = mainTurnStarted(running, { turnId: 't2' })
  expect(fresh?.turnId).toBe('t2')
  expect(Object.keys(fresh ?? {})).toEqual(['turnId'])
})

test('a subagent turn.complete leaves the running main turn, even with its turnId', () => {
  expect(mainTurnEnded(running, { turnId: 't1', agentId: 'agent-1' })).toBe(running)
})

test('a turn.complete for another turnId leaves the running main turn', () => {
  expect(mainTurnEnded(running, { turnId: 'other' })).toBe(running)
})

test('a main turn.complete with the running turnId clears the tracker', () => {
  expect(mainTurnEnded(running, { turnId: 't1' })).toBeUndefined()
})

test('a main turn.complete with nothing running stays undefined', () => {
  expect(mainTurnEnded(undefined, { turnId: 't1' })).toBeUndefined()
})

test('a subagent between a main start and its complete does not strand the tracker', () => {
  let turn = mainTurnStarted(undefined, { turnId: 't1' })
  turn = mainTurnStarted(turn, { turnId: 'a1', agentId: 'agent-1' })
  turn = mainTurnEnded(turn, { turnId: 'a1', agentId: 'agent-1' })
  expect(turn?.turnId).toBe('t1')
  expect(mainTurnEnded(turn, { turnId: 't1' })).toBeUndefined()
})
