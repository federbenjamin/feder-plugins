import type { Register } from 'claude-code'
import { applyCommand, dialogTimeoutCommand, envMinutesFrom, sessionSetting, settingsFrom, SETTINGS_KEY } from './settings.ts'
import type { Settings } from './settings.ts'
import { mainTurnEnded, mainTurnStarted, PERSON_ORIGINS } from './shared/events.ts'
import type { MainTurn } from './shared/events.ts'
import { record } from './shared/record.ts'

// Ends a main turn that has sat on an open dialog (a permission prompt, an AskUserQuestion) for
// the set minutes, then submits AFK_TEXT so the agent runs the afk skill and moves on. No tool
// hooks: while a main turn runs, each tick asks the prompt box whether a dialog holds the keys
// ($.prompt.fill refuses with `dialog`); the dialog's age counts from the first tick that saw it.
// `/dialog-timeout <minutes>|off|on` sets it for every session: it lives in $.store, read on each
// tick, so sessions already open follow a change. DIALOG_TIMEOUT_MINUTES in the session's
// environment replaces the minutes for that session alone; `off` still wins over it.

export const TICK_MS = 30_000
export const AFK_TEXT = 'automessage: user is /afk'
export const COMMAND = 'dialog-timeout'

// One tick's reading: when the open dialog was first seen (0 for none), and whether it is overdue.
export function observe(openSince: number, isDialog: boolean, now: number, timeoutMs: number): { openSince: number; isOverdue: boolean } {
  if (!isDialog) return { openSince: 0, isOverdue: false }
  const since = openSince || now
  return { openSince: since, isOverdue: now - since >= timeoutMs }
}

const statusFor = (s: Settings): string | undefined => (s.isOff ? 'dialog-timeout off' : undefined)

export const register: Register = on => {
  let setting = settingsFrom(undefined)
  let envMinutes: number | undefined
  let mainTurn: MainTurn | undefined
  let openSince = 0
  let tick: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    tick?.cancel()
    tick = undefined
    if (e.isInteractive) {
      envMinutes = envMinutesFrom(await $.env.get('DIALOG_TIMEOUT_MINUTES'))
      setting = sessionSetting(await $.store.get(SETTINGS_KEY), envMinutes)
      $.ui.status(statusFor(setting))
      tick = $.clock.every(TICK_MS, async () => {
        if (mainTurn === undefined) return
        setting = sessionSetting(await $.store.get(SETTINGS_KEY), envMinutes)
        if (setting.isOff) return
        const { refusal } = await $.prompt.fill({ text: '', mode: 'append' })
        const seen = observe(openSince, refusal === 'dialog', await $.clock.now(), setting.minutes * 60_000)
        openSince = seen.openSince
        if (!seen.isOverdue || mainTurn === undefined) return
        const id = mainTurn.turnId
        mainTurn = undefined
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
    const action = dialogTimeoutCommand(e.args)
    const { setting: stored, text } = applyCommand(settingsFrom(await $.store.get(SETTINGS_KEY)), action, envMinutes)
    setting = sessionSetting(stored, envMinutes)
    $.ui.status(statusFor(setting))
    if (action.kind !== 'status' && action.kind !== 'usage') await $.store.set(SETTINGS_KEY, { ...stored })
    return { text }
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.has(e.origin.kind)) $.ui.status(statusFor(setting))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    mainTurn = mainTurnStarted(mainTurn, e)
    openSince = 0
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const running = mainTurn
    mainTurn = mainTurnEnded(mainTurn, e)
    if (running !== undefined && mainTurn === undefined) openSince = 0
    // A main complete under another id leaves the tick polling a turn that may be over: log it.
    if (!e.agentId && mainTurn !== undefined) await record($, COMMAND, 'turn-id-mismatch', `running=${mainTurn.turnId} completed=${e.turnId}`)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    mainTurn = undefined
    openSince = 0
    return next(e)
  })
}
