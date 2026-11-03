import { expect, test } from 'claude-code/testing'
import { dueCalls, isTimed, noticeText, sleptMs, SLEEP_GAP_MS, STALL_MS, TICK_MS } from '../hooks/stall'
import type { RunningCall } from '../hooks/stall'
import { agentDone, agentTurn, MIN, running, session, start, world } from './world'

const call = (o: Partial<RunningCall> = {}): RunningCall => ({ agentId: 'a1', tool: 'Bash', startedAt: 0, isNoticed: false, ...o })

test('a subagent call running past the limit yields one prompt and one log line without the input', async ($, on) => {
  const { clock, prompts, logged, state } = world(on)
  state.agents = running('a1')
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'secret-command-xyz', agentId: 'a1' })
  await clock.advance(STALL_MS + TICK_MS)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Subagent a1')
  expect(prompts[0]).toContain('its Bash call')
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatch(/^\S+ notice session=sess-1 ms=0 reason=agent=a1 tool=Bash\n$/)
  expect(logged[0]).not.toContain('secret-command-xyz')
  expect(prompts[0]).not.toContain('secret-command-xyz')
})

test('later ticks send no second notice for the same call', async ($, on) => {
  const { clock, prompts, logged, state } = world(on)
  state.agents = running('a1')
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(STALL_MS + TICK_MS)
  await clock.advance(10 * MIN)
  expect(prompts).toHaveLength(1)
  expect(logged).toHaveLength(1)
})

test('a call that finished before the limit yields nothing', async ($, on) => {
  const { clock, prompts, logged, state, release } = world(on)
  state.agents = running('a1')
  await start($)
  const p = $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(STALL_MS - MIN)
  release()
  await p
  await clock.advance(30 * MIN)
  expect([prompts, logged]).toEqual([[], []])
})

test('a call just under the limit is not yet noticed, and is at the next tick past it', async ($, on) => {
  const { clock, prompts, state } = world(on)
  state.agents = running('a1')
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(STALL_MS - TICK_MS)
  expect(prompts).toEqual([])
  await clock.advance(TICK_MS)
  expect(prompts).toHaveLength(1)
})

test('a main-loop call yields nothing', async ($, on) => {
  const { clock, prompts, state } = world(on)
  state.agents = running('a1')
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x' })
  await clock.advance(STALL_MS * 2)
  expect(prompts).toEqual([])
})

for (const tool of ['Agent', 'Task']) {
  test(`a nested ${tool} call from a subagent yields nothing`, async ($, on) => {
    const { clock, prompts, state } = world(on)
    state.agents = running('a1')
    await start($)
    void $.tool.call({ tool, agentId: 'a1' } as never)
    await clock.advance(STALL_MS * 2)
    expect(prompts).toEqual([])
  })
}

test('two calls due on the same tick yield one prompt with both lines', async ($, on) => {
  const { clock, prompts, logged, state } = world(on)
  state.agents = running('a1', 'a2')
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  void $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'a2' } as never)
  await clock.advance(STALL_MS + TICK_MS)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Subagent a1: its Bash call')
  expect(prompts[0]).toContain('Subagent a2: its Read call')
  expect(logged).toHaveLength(2)
})

test('an agent no longer reported running yields no notice, and is not noticed later either', async ($, on) => {
  const { clock, prompts, logged, state } = world(on)
  state.agents = [{ id: 'a1', status: 'completed' }]
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(STALL_MS + TICK_MS)
  expect([prompts, logged]).toEqual([[], []])
  expect(state.listCalls).toBeGreaterThan(0)
  state.agents = running('a1')
  await clock.advance(10 * MIN)
  expect(prompts).toEqual([])
})

test('only the still-running agent among two due calls is named', async ($, on) => {
  const { clock, prompts, state } = world(on)
  state.agents = [...running('a1'), { id: 'a2', status: 'killed' }]
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a2' })
  await clock.advance(STALL_MS + TICK_MS)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('a1')
  expect(prompts[0]).not.toContain('a2')
})

// mock.clock fires every tick on the way through an advance, so it cannot make a gap between ticks;
// sleep is covered by the sleptMs test below and by the moved start time in this one.
test('a slept gap pushes the stall out: the same wall time that notices without sleep does not after a gap', () => {
  const started = 3 * MIN
  const lastTick = 5 * MIN
  const now = lastTick + 120 * MIN
  const c = call({ startedAt: started })
  c.startedAt += sleptMs(lastTick, now)
  expect(dueCalls([c], now)).toEqual([])
  expect(dueCalls([c], now + STALL_MS - 2 * MIN)).toEqual([c])
})

test('a non-interactive session.start sets no timer, so nothing fires', async ($, on) => {
  const { clock, prompts, state } = world(on)
  state.agents = running('a1')
  await start($, false)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(STALL_MS * 2)
  expect([prompts, state.listCalls]).toEqual([[], 0])
})

test('a second session.start does not leave two timers sending duplicate notices', async ($, on) => {
  const { clock, prompts, state } = world(on)
  state.agents = running('a1')
  await start($)
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(STALL_MS + TICK_MS)
  expect(prompts).toHaveLength(1)
})

test('the timer ticks only while a subagent is in a turn', async ($, on) => {
  // The engine dispatches clock.every once per period, so a count of dispatches is a count of ticks.
  let ticks = 0
  const counting = ((event: string, ...rest: unknown[]) => {
    const hook = rest.at(-1) as (...a: unknown[]) => unknown
    const counted = (...a: unknown[]) => {
      ticks++
      return hook(...a)
    }
    return (on as (...a: unknown[]) => unknown)(event, ...(event === 'clock.every' ? [...rest.slice(0, -1), counted] : rest))
  }) as typeof on
  const { clock, prompts, state, release } = world(counting)
  state.agents = running('a1')
  await session($)
  await clock.advance(10 * MIN)
  expect(ticks).toBe(0)

  await agentTurn($, 'a1')
  const first = $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(2 * MIN)
  expect(ticks).toBeGreaterThanOrEqual(4)
  release()
  await first
  await agentDone($, 'a1')
  await clock.advance(TICK_MS)
  const afterDone = ticks
  await clock.advance(10 * MIN)
  expect(ticks).toBe(afterDone)

  await agentTurn($, 'a1')
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(STALL_MS + TICK_MS)
  expect(prompts).toHaveLength(1)
  expect(ticks).toBeGreaterThan(afterDone)
})

test('the timer keeps running until the last subagent in a turn is done', async ($, on) => {
  const { clock, prompts, state } = world(on)
  state.agents = running('a2')
  await start($)
  await agentDone($, 'a1')
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a2' })
  await clock.advance(STALL_MS + TICK_MS)
  expect(prompts).toHaveLength(1)
})

test('a new call after a noticed one still hung gets its own notice', async ($, on) => {
  const { clock, prompts, state } = world(on)
  state.agents = running('a1', 'a2')
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(STALL_MS + TICK_MS)
  expect(prompts).toHaveLength(1)
  void $.tool.call({ tool: 'Read', file_path: 'y', agentId: 'a2' } as never)
  await clock.advance(STALL_MS + TICK_MS)
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('Subagent a2')
  expect(prompts[1]).not.toContain('Subagent a1')
})

test('session.end drops running calls', async ($, on) => {
  const { clock, prompts, state } = world(on)
  state.agents = running('a1')
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(2 * MIN)
  await $.session.end({ sessionId: 'sess-1', reason: 'other' } as never)
  await start($)
  await clock.advance(STALL_MS * 2)
  expect(prompts).toEqual([])
})

test('a dropped prompt logs submit-failed and no notice line', async ($, on) => {
  const { clock, logged, state } = world(on)
  state.agents = running('a1')
  state.isSubmitDropped = true
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  await clock.advance(STALL_MS + TICK_MS)
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatch(/^\S+ submit-failed session=sess-1 ms=0 reason=calls=1\n$/)
})

test('a refused prompt.submit logs submit-failed and no notice line', async ($, on) => {
  const { clock, prompts, logged, state } = world(on)
  state.agents = running('a1', 'a2')
  state.isSubmitRefused = true
  await start($)
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
  void $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a2' })
  await clock.advance(STALL_MS + TICK_MS)
  expect(prompts).toEqual([])
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatch(/^\S+ submit-failed session=sess-1 ms=0 reason=calls=2\n$/)
})

test('isTimed: only calls with an agentId that are not Agent or Task', () => {
  expect(isTimed({ tool: 'Bash' })).toBe(false)
  expect(isTimed({ tool: 'Bash', agentId: 'a1' })).toBe(true)
  expect(isTimed({ tool: 'Agent', agentId: 'a1' })).toBe(false)
  expect(isTimed({ tool: 'Task', agentId: 'a1' })).toBe(false)
})

test('dueCalls: due exactly at STALL_MS, not before, and never once noticed', () => {
  const calls = [call({ startedAt: 0 }), call({ agentId: 'a2', startedAt: 1 }), call({ agentId: 'a3', startedAt: 0, isNoticed: true })]
  expect(dueCalls(calls, STALL_MS - 1).map(c => c.agentId)).toEqual([])
  expect(dueCalls(calls, STALL_MS).map(c => c.agentId)).toEqual(['a1'])
  expect(dueCalls(calls, STALL_MS + 1).map(c => c.agentId)).toEqual(['a1', 'a2'])
})

test('sleptMs: the whole gap from SLEEP_GAP_MS up, zero below', () => {
  expect(sleptMs(100, 100 + TICK_MS)).toBe(0)
  expect(sleptMs(100, 100 + SLEEP_GAP_MS - 1)).toBe(0)
  expect(sleptMs(100, 100 + SLEEP_GAP_MS)).toBe(SLEEP_GAP_MS)
  expect(sleptMs(0, 120 * MIN)).toBe(120 * MIN)
})

test('noticeText: one line per call with whole minutes, then the closing advice', () => {
  const text = noticeText([call({ startedAt: 0 }), call({ agentId: 'a2', tool: 'Read', startedAt: MIN })], 16 * MIN + 59_000)
  expect(text.split('\n')).toEqual([
    'Subagent a1: its Bash call has been running for 16 minutes.',
    'Subagent a2: its Read call has been running for 15 minutes.',
    'It may be hung. Check what it was told to produce; if it is stuck, stop it with TaskStop and take the work back.',
  ])
})
