import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'
import { COMMAND, DEFAULT_MINUTES, dialogTimeoutCommand, observe, record, settingFrom, TICK_MS } from '../hooks/register'

const T0 = 1_000_000
const TIMEOUT = DEFAULT_MINUTES * 60_000
const on30 = { minutes: 30, isOff: false }

test('a dialog is overdue the set time after the first tick that saw it', async () => {
  expect(observe(0, true, T0, TIMEOUT)).toEqual({ openSince: T0, isOverdue: false })
  expect(observe(T0, true, T0 + TIMEOUT - TICK_MS, TIMEOUT)).toEqual({ openSince: T0, isOverdue: false })
  expect(observe(T0, true, T0 + TIMEOUT, TIMEOUT)).toEqual({ openSince: T0, isOverdue: true })
})

test('a tick with no dialog restarts the count', async () => {
  expect(observe(T0, false, T0 + TIMEOUT, TIMEOUT)).toEqual({ openSince: 0, isOverdue: false })
  expect(observe(0, true, T0 + TIMEOUT, TIMEOUT)).toEqual({ openSince: T0 + TIMEOUT, isOverdue: false })
})

test('/dialog-timeout takes minutes, off and on, and reports the setting for anything else', async () => {
  expect(dialogTimeoutCommand(' 10 ', on30).setting).toEqual({ minutes: 10, isOff: false })
  expect(dialogTimeoutCommand('OFF', on30).setting).toEqual({ minutes: 30, isOff: true })
  expect(dialogTimeoutCommand('on', { minutes: 10, isOff: true }).setting).toEqual({ minutes: 10, isOff: false })
  expect(dialogTimeoutCommand('5', { minutes: 10, isOff: true }).setting).toEqual({ minutes: 5, isOff: false })
  for (const bad of ['', '0', '-3', '1.5', 'soon']) expect(dialogTimeoutCommand(bad, on30).setting).toBe(on30)
  expect(dialogTimeoutCommand('', { minutes: 10, isOff: true }).text).toBe('dialog-timeout is off (10 min when on); /dialog-timeout <minutes>, off, or on')
})

test('a stored value that is not a setting reads as the default', async () => {
  expect(settingFrom(undefined)).toEqual(on30)
  expect(settingFrom({ minutes: 0, isOff: 'yes' })).toEqual(on30)
  expect(settingFrom({ minutes: 10, isOff: true })).toEqual({ minutes: 10, isOff: true })
})

// The engine beneath: a clock at T0, a store holding `stored`, and a prompt box that counts
// each time it is asked.
function world(on: On, stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored)
  const box = { fills: 0 }
  const statuses: (string | undefined)[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('prompt.fill', async () => (box.fills++, { isFilled: true }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return { clock, box, statuses }
}

const run = (args: string) => ({ command: COMMAND, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })
const endTurn = ($: Engine, turnId: string) => $.turn.complete({ turnId, reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })

test('the prompt box is asked only while a main turn runs', async ($, on) => {
  const { clock, box } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(10 * TICK_MS)
  expect(box.fills).toBe(0)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(2 * TICK_MS)
  expect(box.fills).toBe(2)
  await endTurn($, 't1')
  await clock.advance(10 * TICK_MS)
  expect(box.fills).toBe(2)
})

test('/dialog-timeout off stops the asking and shows in the status line; on brings it back', async ($, on) => {
  const { clock, box, statuses } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('off'))
  expect(statuses.at(-1)).toBe('dialog-timeout off')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(10 * TICK_MS)
  expect(box.fills).toBe(0)
  await $.command.run(run('on'))
  expect(statuses.at(-1)).toBe(undefined)
  await clock.advance(TICK_MS)
  expect(box.fills).toBe(1)
})

test('a setting another session stored applies here from the start', async ($, on) => {
  const { clock, box, statuses } = world(on, { setting: { minutes: 30, isOff: true } })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toBe('dialog-timeout off')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(10 * TICK_MS)
  expect(box.fills).toBe(0)
})

test('a firing appends one line to the shared log with tee', async () => {
  const argv: string[][] = []
  const stdin: string[] = []
  const $ = {
    env: { get: async (name: string) => (name === 'STOPSTOPPING_DIR' ? '/tmp/ss' : undefined) },
    fs: { exists: async () => true, write: async () => {} },
    session: { id: async () => 'sess-1' },
    clock: { now: async () => T0 },
    process: {
      run: async (cmd: readonly string[], init?: { stdin?: string }) => {
        argv.push([...cmd])
        stdin.push(init?.stdin ?? '')
        return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
  } as unknown as EngineInterface
  await record($, 'afk', 'dialog open 30 min, sent /afk')
  expect(argv).toEqual([['tee', '-a', '/tmp/ss/logs/dialog-timeout.log']])
  expect(stdin[0]).toBe('1970-01-01T00:16:40Z afk session=sess-1 ms=0 reason=dialog open 30 min, sent /afk\n')
})
