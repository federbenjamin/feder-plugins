// The one firing-log writer's line shape: every plugin appends one such line per firing to
// `<dir>/logs/<plugin>.log`.

export type FiringLine = { at: string; outcome: string; session: string; ms: number; reason: string }

const REASON_MAX = 300
const LINE_RE = /^(\S+) (\S+) session=(\S*) ms=(\d+) reason=(.*)$/

const seconds = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`

export function firingLine(outcome: string, session: string, ms: number, reason: string, now: Date): string {
  const squashed = [...reason.split(/\s+/).filter(Boolean).join(' ')].slice(0, REASON_MAX).join('')
  return `${seconds(now)} ${outcome} session=${session} ms=${ms} reason=${squashed}\n`
}

export function parseFiringLine(line: string): FiringLine | null {
  const m = LINE_RE.exec(line.replace(/\r?\n$/, ''))
  if (!m) return null
  return { at: m[1]!, outcome: m[2]!, session: m[3]!, ms: Number(m[4]), reason: m[5]! }
}

// Outcome counts over the lines at or after `sinceIso`; lines that are not firing lines are skipped.
export function countOutcomes(lines: readonly string[], sinceIso: string): Record<string, number> {
  const parsed = new Date(sinceIso)
  const since = Number.isNaN(parsed.getTime()) ? sinceIso : seconds(parsed)
  const counts: Record<string, number> = {}
  for (const line of lines) {
    const f = parseFiringLine(line)
    if (f && f.at >= since) counts[f.outcome] = (counts[f.outcome] ?? 0) + 1
  }
  return counts
}

export function logPath(dir: string, plugin: string): string {
  return `${dir}/logs/${plugin}.log`
}
