import { OUTCOMES } from './judge.ts'
import { isFlag, parseCommand, readSettings } from './shared/settings.ts'
import type { Grammar } from './shared/settings.ts'

// The /stop-judge command's pure side: the stored settings, the grammar, the status line.

export type Settings = { isOff: boolean; isContextOff: boolean }

export type Action =
  | { kind: 'status' }
  | { kind: 'off' }
  | { kind: 'on' }
  | { kind: 'context-off' }
  | { kind: 'context-on' }
  | { kind: 'derive'; all: boolean }
  | { kind: 'usage' }

// The command's name, which is also the plugin's log name.
export const COMMAND = 'stop-judge'
// The `$.store` key the judge switch is stored under.
export const SETTINGS_KEY = 'settings'

export const USAGE = '/stop-judge [off|on|context off|context on|derive [all]]'

// Printed in the judge's outcome order; any other outcome follows alphabetically.
const OUTCOME_ORDER: readonly string[] = OUTCOMES

const DEFAULTS: Settings = Object.freeze({ isOff: false, isContextOff: false })

export function settingsFrom(value: unknown): Settings {
  return readSettings(value, DEFAULTS, { isOff: isFlag, isContextOff: isFlag })
}

const GRAMMAR: Grammar<Action> = {
  empty: { kind: 'status' },
  words: { off: { kind: 'off' }, on: { kind: 'on' }, derive: { kind: 'derive', all: false } },
  valued: {
    context: v => (v === 'off' ? { kind: 'context-off' } : v === 'on' ? { kind: 'context-on' } : undefined),
    derive: v => (v === 'all' ? { kind: 'derive', all: true } : undefined),
  },
  usage: { kind: 'usage' },
}

export function stopJudgeCommand(args: string): Action {
  return parseCommand(args, GRAMMAR)
}

const rank = (outcome: string): number => {
  const i = OUTCOME_ORDER.indexOf(outcome)
  return i === -1 ? OUTCOME_ORDER.length : i
}

export function statusText(info: { settings: Settings; counts: Record<string, number>; decisions: { lines: number; date: string } | null }): string {
  const counts = Object.entries(info.counts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([outcome, n]) => `${outcome} ${n}`)
  const decisions = info.decisions ? `${info.decisions.lines} lines (${info.decisions.date})` : 'none'
  return [
    `${info.settings.isOff ? 'off' : 'on'}`,
    `context: ${info.settings.isContextOff ? 'off' : 'on'}`,
    `last 7 days: ${counts.length > 0 ? counts.join(', ') : 'none'}`,
    `DECISIONS.md: ${decisions}`,
  ].join(' · ')
}

// The plugin's one status line: the judge-off marker and a derive run's progress, either or both.
// Every writer of the line goes through this, so neither hides the other.
export function statusLine(settings: Pick<Settings, 'isOff'>, derive?: string): string | undefined {
  const parts = [...(settings.isOff ? ['stop-judge off'] : []), ...(derive ? [derive] : [])]
  return parts.length > 0 ? parts.join(' · ') : undefined
}
