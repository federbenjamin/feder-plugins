import { isFlag, isPositiveInteger, parseCommand, positiveInteger, readSettings } from './shared/settings.ts'
import type { Grammar } from './shared/settings.ts'

// The /dialog-timeout command's pure side: the stored setting, the environment's override, the
// grammar and the lines it prints.

export const DEFAULT_MINUTES = 30
// The `$.store` key the setting is stored under.
export const SETTINGS_KEY = 'setting'

export type Settings = {
  minutes: number // how long a dialog may stay open before the turn ends with /afk
  isOff: boolean // /dialog-timeout off; `on` restores `minutes`
}

const DEFAULTS: Settings = Object.freeze({ minutes: DEFAULT_MINUTES, isOff: false })

// The stored setting, or the default for a value that is missing or not a setting.
export function settingsFrom(value: unknown): Settings {
  return readSettings(value, DEFAULTS, { minutes: isPositiveInteger, isOff: isFlag })
}

// DIALOG_TIMEOUT_MINUTES as whole minutes of at least 1; any other value is ignored.
export function envMinutesFrom(value: string | undefined): number | undefined {
  return positiveInteger(value?.trim() ?? '')
}

// The setting this session runs on: the stored one, with the environment's minutes in place of its own.
export function sessionSetting(stored: unknown, envMinutes: number | undefined): Settings {
  const s = settingsFrom(stored)
  return envMinutes === undefined ? s : { ...s, minutes: envMinutes }
}

export type Action = { kind: 'status' } | { kind: 'off' } | { kind: 'on' } | { kind: 'minutes'; minutes: number } | { kind: 'usage' }

const GRAMMAR: Grammar<Action> = {
  empty: { kind: 'status' },
  words: { off: { kind: 'off' }, on: { kind: 'on' } },
  valued: {},
  other: word => {
    const minutes = positiveInteger(word)
    return minutes === undefined ? undefined : { kind: 'minutes', minutes }
  },
  usage: { kind: 'usage' },
}

// `/dialog-timeout <minutes>|off|on`.
export function dialogTimeoutCommand(args: string): Action {
  return parseCommand(args, GRAMMAR)
}

// The stored setting after the action, and the line the command prints, which names the
// environment's minutes when they are what this session runs on.
export function applyCommand(s: Settings, action: Action, envMinutes?: number): { setting: Settings; text: string } {
  const { setting, text } = applied(s, action)
  const note = envMinutes !== undefined && !setting.isOff ? ` (this session: ${envMinutes} min, from DIALOG_TIMEOUT_MINUTES)` : ''
  return { setting, text: text + note }
}

function applied(s: Settings, action: Action): { setting: Settings; text: string } {
  switch (action.kind) {
    case 'off':
      return { setting: { ...s, isOff: true }, text: 'dialog-timeout off: open dialogs wait for you, in every session' }
    case 'on':
    case 'minutes': {
      const minutes = action.kind === 'on' ? s.minutes : action.minutes
      return { setting: { minutes, isOff: false }, text: `dialog-timeout ${minutes} min: a dialog left open that long ends the turn with /afk` }
    }
    case 'status':
    case 'usage': {
      const state = s.isOff ? `off (${s.minutes} min when on)` : `${s.minutes} min`
      return { setting: s, text: `dialog-timeout is ${state}; /dialog-timeout <minutes>, off, or on` }
    }
  }
}
