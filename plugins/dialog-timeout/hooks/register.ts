import type { Register } from 'claude-code'
import { PERSON_ORIGINS } from './shared/events.ts'
import { record } from './shared/record.ts'

// Ends a main turn that has sat on an open dialog (a permission prompt, an AskUserQuestion) for
// the set minutes, then submits AFK_TEXT so the agent runs the afk skill and moves on. No tool
// hooks: while a main turn runs, each tick asks the prompt box whether a dialog holds the keys
// ($.prompt.fill refuses with `dialog`); the dialog's age counts from the first tick that saw it.
// `/dialog-timeout <minutes>|off|on` sets it for every session: it lives in $.store, read on each
// tick, so sessions already open follow a change.

export const DEFAULT_MINUTES = 30
export const TICK_MS = 30_000
export const AFK_TEXT = 'automessage: user is /afk'
export const COMMAND = 'dialog-timeout'
const SETTING = 'setting'

export type DialogTimeoutSetting = {
  minutes: number // how long a dialog may stay open before the turn ends with /afk
  isOff: boolean // /dialog-timeout off; `on` restores `minutes`
}

const fresh = (): DialogTimeoutSetting => ({ minutes: DEFAULT_MINUTES, isOff: false })

// The stored setting, or the default for a value that is missing or not a setting.
export function settingFrom(value: unknown): DialogTimeoutSetting {
  const v = (value ?? {}) as Partial<DialogTimeoutSetting>
  return {
    minutes: typeof v.minutes === 'number' && Number.isInteger(v.minutes) && v.minutes >= 1 ? v.minutes : DEFAULT_MINUTES,
    isOff: v.isOff === true,
  }
}

// One tick's reading: when the open dialog was first seen (0 for none), and whether it is overdue.
export function observe(openSince: number, isDialog: boolean, now: number, timeoutMs: number): { openSince: number; isOverdue: boolean } {
  if (!isDialog) return { openSince: 0, isOverdue: false }
  const since = openSince || now
  return { openSince: since, isOverdue: now - since >= timeoutMs }
}

// `/dialog-timeout <minutes>|off|on`: the setting after the args, and the line the command prints.
export function dialogTimeoutCommand(args: string, s: DialogTimeoutSetting): { setting: DialogTimeoutSetting; text: string } {
  const arg = args.trim().toLowerCase()
  if (arg === 'off') return { setting: { ...s, isOff: true }, text: 'dialog-timeout off: open dialogs wait for you, in every session' }
  if (arg === 'on' || /^\d+$/.test(arg)) {
    const minutes = arg === 'on' ? s.minutes : Number(arg)
    if (minutes >= 1) return { setting: { minutes, isOff: false }, text: `dialog-timeout ${minutes} min: a dialog left open that long ends the turn with /afk` }
  }
  const state = s.isOff ? `off (${s.minutes} min when on)` : `${s.minutes} min`
  return { setting: s, text: `dialog-timeout is ${state}; /dialog-timeout <minutes>, off, or on` }
}

const statusFor = (s: DialogTimeoutSetting): string | undefined => (s.isOff ? 'dialog-timeout off' : undefined)

export const register: Register = on => {
  let setting = fresh()
  let turnId: string | undefined
  let openSince = 0
  let tick: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    tick?.cancel()
    tick = undefined
    if (e.isInteractive) {
      setting = settingFrom(await $.store.get(SETTING))
      $.ui.status(statusFor(setting))
      tick = $.clock.every(TICK_MS, async () => {
        if (turnId === undefined) return
        setting = settingFrom(await $.store.get(SETTING))
        if (setting.isOff) return
        const { refusal } = await $.prompt.fill({ text: '', mode: 'append' })
        const seen = observe(openSince, refusal === 'dialog', await $.clock.now(), setting.minutes * 60_000)
        openSince = seen.openSince
        if (!seen.isOverdue) return
        const id = turnId
        turnId = undefined
        openSince = 0
        try {
          await $.turn.abort({ turnId: id })
          await $.prompt.submit({ text: AFK_TEXT, asUser: true })
          $.ui.status(`dialog-timeout: dialog open ${setting.minutes} min, sent /afk`)
          await record($, COMMAND, 'afk', `dialog open ${setting.minutes} min, sent /afk`)
        } catch {
          $.ui.status('dialog-timeout: could not end the waiting turn')
          await record($, COMMAND, 'afk-failed', 'could not end the waiting turn')
        }
      })
      // After the timer, so a refused registration costs the command, not the timeout.
      await $.command.register({
        name: COMMAND,
        description: 'Minutes an open dialog may wait before the turn ends with /afk, or off; every session',
        argumentHint: '[minutes|off|on]',
        immediate: true,
      })
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const { setting: next, text } = dialogTimeoutCommand(e.args, settingFrom(await $.store.get(SETTING)))
    setting = next
    $.ui.status(statusFor(setting))
    await $.store.set(SETTING, { ...setting })
    return { text }
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.has(e.origin.kind)) $.ui.status(statusFor(setting))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    openSince = 0
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.turnId === turnId) {
      turnId = undefined
      openSince = 0
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    turnId = undefined
    openSince = 0
    return next(e)
  })
}
