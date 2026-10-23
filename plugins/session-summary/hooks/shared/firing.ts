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

export function sessionLogsDir(dir: string): string {
  return `${dir}/session-logs`
}

export function sessionLogPath(dir: string, sessionId: string): string {
  return `${sessionLogsDir(dir)}/${sessionId}.md`
}

// Where every plugin keeps what it writes for the person: STOPSTOPPING_DIR, else
// `$HOME/.claude/stopstopping`; '' when neither is set, so nothing is written relative to cwd.
export function stateDir(home: string | undefined, override: string | undefined): string {
  return override || (home ? `${home}/.claude/stopstopping` : '')
}

// The one firing: the log a plugin appends to and the line it appends, from the two env values.
// null when there is no state dir. The hooks file does the write: `tee -a` on the path.
export function firingRecord(f: {
  home: string | undefined
  override: string | undefined
  plugin: string
  outcome: string
  session: string
  ms: number
  reason: string
  now: Date
}): { path: string; line: string } | null {
  const dir = stateDir(f.home, f.override)
  if (dir === '') return null
  return { path: logPath(dir, f.plugin), line: firingLine(f.outcome, f.session, f.ms, f.reason, f.now) }
}
