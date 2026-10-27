import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { capFor, COLD_LIMIT, LEAD_MS, TICK_MS } from '../hooks/keepalive'
import { COLD, HOUR, mainTurn, WARM, world } from './world'

// Each outcome the README lists, driven through the hooks, lands in the log once, at its firing.
const outcomes = (logged: { stdin: string }[]) => logged.map(l => l.stdin.split(' ')[1])
const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

test('the bump past the cap logs done once, after one bump line per ping', async ($, on) => {
  const { clock, logged } = world(on)
  const cap = capFor('claude-opus-5-5')
  await start($)
  await mainTurn($, 't1')
  for (let n = 1; n <= cap; n++) {
    await clock.advance(HOUR - LEAD_MS)
    await mainTurn($, `b${n}`, WARM)
  }
  await clock.advance(HOUR - LEAD_MS)
  await clock.advance(HOUR)
  expect(outcomes(logged)).toEqual([...Array.from({ length: cap }, () => 'bump'), 'done'])
  expect(logged.at(-1)?.stdin).toMatch(new RegExp(`^\\S+ done session=sess-1 ms=0 reason=${cap}/${cap}\\n$`))
})

test('an account change logs stopped-account once', async ($, on) => {
  const { clock, logged, acct } = world(on)
  await start($)
  await mainTurn($, 't1')
  await clock.advance(10 * TICK_MS)
  acct.name = 'acct2'
  await clock.advance(TICK_MS)
  await clock.advance(HOUR)
  expect(outcomes(logged)).toEqual(['stopped-account'])
  expect(logged[0]?.stdin).toMatch(/^\S+ stopped-account session=sess-1 ms=0 reason=account changed\n$/)
  expect(logged[0]?.stdin).not.toContain('acct')
})

test('COLD_LIMIT cold pings log stopped-cold once, after their bump lines', async ($, on) => {
  const { clock, logged } = world(on)
  await start($)
  await mainTurn($, 't0')
  await clock.advance(TICK_MS)
  await mainTurn($, 't1')
  for (let n = 1; n <= COLD_LIMIT; n++) {
    await clock.advance(HOUR - LEAD_MS)
    await mainTurn($, `b${n}`, COLD)
  }
  await clock.advance(HOUR)
  expect(outcomes(logged)).toEqual([...Array.from({ length: COLD_LIMIT }, () => 'bump'), 'stopped-cold'])
  expect(logged.at(-1)?.stdin).toMatch(new RegExp(`^\\S+ stopped-cold session=sess-1 ms=0 reason=${COLD_LIMIT} pings in a row\\n$`))
})

test("a main turn that completes under another id than the running one's logs turn-id-mismatch; a subagent's, its own or an idle complete logs nothing", async ($, on) => {
  const { clock, logged } = world(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 'a1', agentId: 'agent-1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  expect(outcomes(logged)).toEqual([])
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  expect(outcomes(logged)).toEqual(['turn-id-mismatch'])
  expect(logged[0]?.stdin).toMatch(/^\S+ turn-id-mismatch session=sess-1 ms=0 reason=running=t1 completed=t2\n$/)
  await clock.advance(HOUR - LEAD_MS)
  expect(outcomes(logged)).toEqual(['turn-id-mismatch'])
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  await $.turn.complete({ turnId: 't3', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  expect(outcomes(logged)).toEqual(['turn-id-mismatch'])
})

test("a stale completion leaves the running bump turn's bookkeeping alone: its own cold usage is still counted", async ($, on) => {
  const { clock, submitted, statuses } = world(on)
  await start($)
  await mainTurn($, 't0')
  await clock.advance(TICK_MS)
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toHaveLength(1)
  await $.turn.start({ text: submitted[0]!, turnId: 'b1' })
  const before = statuses.length
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, usage: { input_tokens: 2, output_tokens: 1, model: 'claude-opus-5-5', ...COLD } })
  expect(statuses.slice(before)).toEqual([])
  for await (const _ of $.turn.step({ turnId: 'b1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 'b1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, usage: { input_tokens: 2, output_tokens: 1, model: 'claude-opus-5-5', ...COLD } })
  expect(statuses.at(-1)).toBe('keepalive: cache was cold, rebuilt; pings go on')
})

test('a ping that got no response logs no-response once', async ($, on) => {
  const { clock, logged, step } = world(on)
  await start($)
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS)
  step.stopReason = null
  await $.turn.start({ text: 'ping', turnId: 'b1' })
  for await (const _ of $.turn.step({ turnId: 'b1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // no response
  }
  await $.turn.complete({ turnId: 'b1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true })
  await clock.advance(HOUR)
  expect(outcomes(logged)).toEqual(['bump', 'no-response'])
  expect(logged.at(-1)?.stdin).toMatch(/^\S+ no-response session=sess-1 ms=0 reason=ping got no response\n$/)
})
