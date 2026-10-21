import { OUTCOMES } from './judge.ts'

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

export const USAGE = '/stop-judge [off|on|context off|context on|derive [all]]'

// Printed in the judge's outcome order; any other outcome follows alphabetically.
const OUTCOME_ORDER: readonly string[] = OUTCOMES

export function settingsFrom(value: unknown): Settings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Settings>
  return { isOff: v.isOff === true, isContextOff: v.isContextOff === true }
}

export function stopJudgeCommand(args: string): Action {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [head, rest, extra] = words
  if (head === undefined) return { kind: 'status' }
  if (extra !== undefined) return { kind: 'usage' }
  if (rest === undefined) {
    if (head === 'off' || head === 'on') return { kind: head }
    if (head === 'derive') return { kind: 'derive', all: false }
  } else {
    if (head === 'context' && (rest === 'off' || rest === 'on')) return { kind: rest === 'off' ? 'context-off' : 'context-on' }
    if (head === 'derive' && rest === 'all') return { kind: 'derive', all: true }
  }
  return { kind: 'usage' }
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
    `stop-judge: ${info.settings.isOff ? 'off' : 'on'}`,
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
