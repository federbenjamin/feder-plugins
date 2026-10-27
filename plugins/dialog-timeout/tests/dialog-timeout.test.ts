import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { COMMAND, observe, register, TICK_MS } from '../hooks/register'
import { applyCommand, DEFAULT_MINUTES, dialogTimeoutCommand, envMinutesFrom, sessionSetting, settingsFrom } from '../hooks/settings'
import type { Settings } from '../hooks/settings'

const T0 = 1_000_000
const TIMEOUT = DEFAULT_MINUTES * 60_000
const on30 = { minutes: 30, isOff: false }
const command = (args: string, s: Settings, envMinutes?: number) => applyCommand(s, dialogTimeoutCommand(args), envMinutes)

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
  expect(dialogTimeoutCommand(' 10 ')).toEqual({ kind: 'minutes', minutes: 10 })
  expect(dialogTimeoutCommand('')).toEqual({ kind: 'status' })
  expect(dialogTimeoutCommand('soon')).toEqual({ kind: 'usage' })
  expect(command(' 10 ', on30).setting).toEqual({ minutes: 10, isOff: false })
  expect(command('OFF', on30).setting).toEqual({ minutes: 30, isOff: true })
  expect(command('on', { minutes: 10, isOff: true }).setting).toEqual({ minutes: 10, isOff: false })
  expect(command('5', { minutes: 10, isOff: true }).setting).toEqual({ minutes: 5, isOff: false })
  for (const bad of ['', '0', '-3', '1.5', 'soon', '10 20']) expect(command(bad, on30).setting).toBe(on30)
  expect(command('', { minutes: 10, isOff: true }).text).toBe('dialog-timeout is off (10 min when on); /dialog-timeout <minutes>, off, or on')
  expect(command('soon', { minutes: 10, isOff: true }).text).toBe('dialog-timeout is off (10 min when on); /dialog-timeout <minutes>, off, or on')
})

test('a stored value that is not a setting reads as the default', async () => {
  expect(settingsFrom(undefined)).toEqual(on30)
  expect(settingsFrom({ minutes: 0, isOff: 'yes' })).toEqual(on30)
  expect(settingsFrom({ minutes: 10, isOff: true })).toEqual({ minutes: 10, isOff: true })
})

test('DIALOG_TIMEOUT_MINUTES replaces the stored minutes in this session alone, and off still wins', async () => {
  for (const bad of [undefined, '', '0', '-3', '1.5', 'abc']) expect(envMinutesFrom(bad)).toBe(undefined)
  expect(envMinutesFrom(' 2 ')).toBe(2)
  expect(sessionSetting({ minutes: 10, isOff: false }, 2)).toEqual({ minutes: 2, isOff: false })
  expect(sessionSetting({ minutes: 10, isOff: true }, 2)).toEqual({ minutes: 2, isOff: true })
  expect(sessionSetting(undefined, undefined)).toEqual(on30)
  const set = command('10', on30, 2)
  expect(set.setting).toEqual({ minutes: 10, isOff: false })
  expect(set.text).toBe('dialog-timeout 10 min: a dialog left open that long ends the turn with /afk (this session: 2 min, from DIALOG_TIMEOUT_MINUTES)')
  expect(command('', on30, 2).text).toBe('dialog-timeout is 30 min; /dialog-timeout <minutes>, off, or on (this session: 2 min, from DIALOG_TIMEOUT_MINUTES)')
  expect(command('off', on30, 2).text).toBe('dialog-timeout off: open dialogs wait for you, in every session')
})

// The engine beneath: a clock at T0, a store holding `stored`, an environment holding `env`, and
// a prompt box that counts each time it is asked.
function world(on: On, stored: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored)
  mock.env(on, env)
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

test("a subagent's turn leaves the main turn tracked: the asking stops when the main turn ends", async ($, on) => {
  const { clock, box } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.start({ text: 'work', turnId: 'a1', agentId: 'agent-1' })
  const before = box.fills
  await endTurn($, 't1')
  await clock.advance(10 * TICK_MS)
  expect(box.fills).toBe(before)
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

test('a session reads DIALOG_TIMEOUT_MINUTES for itself, and a stored off still stops the asking', async ($, on) => {
  const { clock, box } = world(on, { setting: { minutes: 30, isOff: false } }, { DIALOG_TIMEOUT_MINUTES: '2' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect((await $.command.run(run(''))).text).toBe('dialog-timeout is 30 min; /dialog-timeout <minutes>, off, or on (this session: 2 min, from DIALOG_TIMEOUT_MINUTES)')
  await $.command.run(run('off'))
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(10 * TICK_MS)
  expect(box.fills).toBe(0)
})

// The kit strips the `dialog` refusal a test hook gives prompt.fill (only the engine's own cause
// passes up), so these drive the registered hooks with a hand-made `$` that holds a dialog open.
function hooked(opts: { isAbortRefused?: boolean } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const fakeOn = ((event: string, a: unknown, b?: unknown) => {
    handlers.set(event, (typeof a === 'function' ? a : b) as (...args: unknown[]) => Promise<unknown>)
  }) as unknown as On
  register(fakeOn, {} as PluginOptions)
  const clock = { now: T0, tick: undefined as (() => Promise<void>) | undefined }
  const logged: string[] = []
  const aborted: string[] = []
  const done = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  const $ = {
    env: { get: async (name: string) => (name === 'STOPSTOPPING_DIR' ? '/tmp/ss' : undefined) },
    fs: { exists: async () => true, write: async () => {} },
    session: { id: async () => 'sess-1' },
    store: { get: async () => undefined, set: async () => {} },
    ui: { status: () => {} },
    command: { register: async () => ({ command: COMMAND }) },
    prompt: { fill: async () => ({ isFilled: false, refusal: 'dialog', text: '' }), submit: async () => ({ text: '' }) },
    turn: {
      abort: async (init: { turnId: string }) => {
        aborted.push(init.turnId)
        if (opts.isAbortRefused) throw new Error('refused')
      },
    },
    clock: {
      now: async () => clock.now,
      every: (_ms: number, cb: () => Promise<void>) => ((clock.tick = cb), { cancel: () => {} }),
    },
    process: {
      run: async (cmd: readonly string[], init?: { stdin?: string }) => {
        if (cmd[0] === 'tee') logged.push(init?.stdin ?? '')
        return done
      },
    },
  } as unknown as EngineInterface
  const next = async (e: unknown) => e
  const fire = (event: string, e: unknown) => handlers.get(event)!($, e, next)
  return { clock, logged, aborted, fire }
}

const overdue = async (h: ReturnType<typeof hooked>, opts: { isSubagentStarted?: boolean } = {}) => {
  await h.fire('session.start', { isInteractive: true })
  await h.fire('turn.start', { turnId: 't1' })
  if (opts.isSubagentStarted) await h.fire('turn.start', { turnId: 'a1', agentId: 'agent-1' })
  await h.clock.tick!()
  h.clock.now = T0 + TIMEOUT
  await h.clock.tick!()
  h.clock.now = T0 + 2 * TIMEOUT
  await h.clock.tick!()
}

test('a dialog left open past the timeout ends the turn and logs afk once', async () => {
  const h = hooked()
  await overdue(h)
  expect(h.logged).toEqual([`1970-01-01T00:46:40Z afk session=sess-1 ms=0 reason=dialog open ${DEFAULT_MINUTES} min, sent /afk\n`])
})

test("the overdue abort ends the main turn, not a subagent's that started after it", async () => {
  const h = hooked()
  await overdue(h, { isSubagentStarted: true })
  expect(h.aborted).toEqual(['t1'])
  expect(h.logged).toEqual([`1970-01-01T00:46:40Z afk session=sess-1 ms=0 reason=dialog open ${DEFAULT_MINUTES} min, sent /afk\n`])
})

test('a turn that could not be ended logs afk-failed once', async () => {
  const h = hooked({ isAbortRefused: true })
  await overdue(h)
  expect(h.logged).toEqual(['1970-01-01T00:46:40Z afk-failed session=sess-1 ms=0 reason=could not end the waiting turn\n'])
})
