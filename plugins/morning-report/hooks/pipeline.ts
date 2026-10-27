import { tooManyFailed, type CallFailure } from './shared/retry.ts'
import { parseCommand, type Grammar } from './shared/settings.ts'

// The run's pure side: the window and its state, the session batches, the summary outcome, the
// extract's shape, the prompt fills, and the option and argument parsing. status.ts holds the
// status and patterns files; launchd.ts the schedule.

export type Session = {
  id: string
  project: string
  start: string
  end: string
  typed: number
  active_minutes: number
  text: string
}

export type Summary = { ids: string[]; text: string } | { ids: string[]; failed: string }

export const DAY_MS = 24 * 3600_000
export const MAX_WINDOW_MS = 72 * 3600_000
export const FIRST_WINDOW_MS = DAY_MS
export const BATCH_SMALL_CHARS = 3_000
export const BATCH_MAX_CHARS = 20_000

export function localDate(ms: number, offsetMinutes: number): string {
  return new Date(ms - offsetMinutes * 60_000).toISOString().slice(0, 10)
}

export type State = { watermark?: string; prevWatermark?: string; reportDate?: string }

export function parseState(raw: string): { state: State; corrupt: boolean } {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { state: {}, corrupt: true }
    const str = (k: string) => {
      const x = (v as Record<string, unknown>)[k]
      return typeof x === 'string' ? x : undefined
    }
    return {
      state: { watermark: str('watermark'), prevWatermark: str('prevWatermark'), reportDate: str('reportDate') },
      corrupt: false,
    }
  } catch {
    return { state: {}, corrupt: true }
  }
}

// A run on the day the status was already written redoes it over the same window: prevWatermark
// is where that day's window started.
export function windowForRun(state: State, nowMs: number, today: string) {
  const redo = state.reportDate === today && state.prevWatermark !== undefined
  return windowFor(redo ? state.prevWatermark : state.watermark, nowMs)
}

export function nextState(since: string, until: string, today: string): State {
  return { watermark: until, prevWatermark: since, reportDate: today }
}

export function windowFor(watermark: string | undefined, nowMs: number) {
  const last = watermark ? Date.parse(watermark) : NaN
  const sinceMs = Number.isNaN(last)
    ? nowMs - FIRST_WINDOW_MS
    : Math.max(last, nowMs - MAX_WINDOW_MS)
  return { since: new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString() }
}

export function runRecordName(day: string): string {
  return `${day}-run.json`
}

// The day is done once its run record exists or state.json names it: the record is the last file
// a successful run writes before the state, so the later scheduled fires skip.
export function alreadyWritten(state: State, today: string, runNames: readonly string[]): boolean {
  return state.reportDate === today || runNames.includes(runRecordName(today))
}

export function batchSessions(sessions: readonly Session[]): Session[][] {
  const batches: Session[][] = []
  let small: Session[] = []
  let size = 0
  for (const s of sessions) {
    if (s.text.length >= BATCH_SMALL_CHARS) {
      batches.push([s])
      continue
    }
    if (size + s.text.length > BATCH_MAX_CHARS && small.length) {
      batches.push(small)
      small = []
      size = 0
    }
    small.push(s)
    size += s.text.length
  }
  if (small.length) batches.push(small)
  return batches
}

export function sessionBlock(s: Session): string {
  return `### session ${s.id}\nproject: ${s.project}\nspan: ${s.start} → ${s.end}\nyour active minutes (computed from your message times): ${s.active_minutes}\n\n${s.text}`
}

// Counts sessions, not summary calls: one failed call can hold a batch of several sessions.
export function summaryOutcome(summaries: readonly Summary[]): { failed: number; text: string[] } {
  const sessions = (list: readonly Summary[]) => list.reduce((n, s) => n + s.ids.length, 0)
  const failures = summaries.filter((s): s is Extract<Summary, { failed: string }> => 'failed' in s)
  const failed = sessions(failures)
  const total = sessions(summaries)
  if (tooManyFailed(total, failed)) throw new Error(`${failed} of ${total} summaries failed: ${failures[0]!.failed}`)
  const text = summaries.map(s => ('text' in s ? s.text : `## ${s.ids.join(', ')} — not summarized (${s.failed})`))
  return { failed, text }
}

export function notSummarized(failed: number): string {
  return failed ? ` (${plural(failed, 'session')} not summarized)` : ''
}

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export type UsageByModel = Record<string, Usage & { calls: number }>

export function addUsage(acc: UsageByModel, model: string, u: Usage): void {
  const cur = (acc[model] ??= {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  cur.calls += 1
  cur.input_tokens += u.input_tokens
  cur.output_tokens += u.output_tokens
  cur.cache_read_input_tokens += u.cache_read_input_tokens
  cur.cache_creation_input_tokens += u.cache_creation_input_tokens
}

export function describeFailure(model: string, f: CallFailure): string {
  const detail = [f.status, f.error].filter(x => x !== undefined && x !== null).join(' ')
  return `${model} call failed: ${f.reason}${detail ? ` ${detail}` : ''}`
}

export function expandHome(path: string, home: string): string {
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

export type RunArgs = { force: boolean; backfill?: { date: string; since: string; until: string } }

// `/morning-run [--force] [--backfill YYYY-MM-DD --until ISO]`: a backfill writes a past day's
// summaries over the 24h before `until`, and leaves the status, the patterns and the watermark alone.
export function parseRunArgs(args: string): RunArgs {
  const force = /(^|\s)--force\b/.test(args)
  const date = /--backfill\s+(\d{4}-\d{2}-\d{2})\b/.exec(args)?.[1]
  const until = /--until\s+(\S+)/.exec(args)?.[1]
  if (date === undefined) return { force }
  const untilMs = until === undefined ? NaN : Date.parse(until)
  if (Number.isNaN(untilMs)) throw new Error('--backfill needs --until <ISO time>')
  return {
    force,
    backfill: { date, since: new Date(untilMs - FIRST_WINDOW_MS).toISOString(), until: new Date(untilMs).toISOString() },
  }
}

export type ProjectMinutes = { project: string; active_minutes: number }
export type Extracted = { sessions: Session[]; active_minutes: number; projects: ProjectMinutes[] }

type JsonObject = Record<string, unknown>

function objectAt(value: unknown, at: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`extract output: ${at} is not an object`)
  return value as JsonObject
}

function arrayAt(o: JsonObject, key: string, at: string): unknown[] {
  const value = o[key]
  if (!Array.isArray(value)) throw new Error(`extract output: ${at}${key} is missing or not an array`)
  return value
}

function fieldsAt(o: JsonObject, types: Readonly<Record<string, 'string' | 'number'>>, at: string): void {
  for (const [key, type] of Object.entries(types)) {
    if (typeof o[key] !== type) throw new Error(`extract output: ${at}${key} is missing or not a ${type}`)
  }
}

const SESSION_FIELDS = { id: 'string', project: 'string', start: 'string', end: 'string', typed: 'number', active_minutes: 'number', text: 'string' } as const
const PROJECT_FIELDS = { project: 'string', active_minutes: 'number' } as const

export function parseExtracted(stdout: string): Extracted {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (err) {
    throw new Error(`extract output is not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const top = objectAt(value, 'the result')
  arrayAt(top, 'sessions', '').forEach((s, i) => fieldsAt(objectAt(s, `sessions[${i}]`), SESSION_FIELDS, `sessions[${i}].`))
  fieldsAt(top, { active_minutes: 'number' }, '')
  arrayAt(top, 'projects', '').forEach((p, i) => fieldsAt(objectAt(p, `projects[${i}]`), PROJECT_FIELDS, `projects[${i}].`))
  return top as Extracted
}

export const PROFILE_HEADINGS = [
  { heading: 'Watch for', holds: 'what the nightly patterns catalog judges as going well or not working, one item a line' },
] as const

export function profileHeadingsBlock(): string {
  return PROFILE_HEADINGS.map(h => `## ${h.heading} — ${h.holds}`).join('\n')
}

export const SCAN_TOOL = 'morning_setup_scan'

// The `{{KEY}}` slots each prompt file holds, which its hook fills; a test binds this to the files.
export const PROMPT_FILLS = {
  'summarizer.md': ['PROFILE'],
  'status.md': [],
  'patterns.md': ['WATCH_FOR'],
  'setup-scan.md': [],
  'morning-setup.md': ['DATA_DIR', 'TODAY', 'PREVIEW', 'PROFILE_HEADINGS', 'PROFILE'],
} as const

export type PromptName = keyof typeof PROMPT_FILLS
export type PromptValues<N extends PromptName> = Record<(typeof PROMPT_FILLS)[N][number], string>

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g

// One pass, so a value that itself holds `{{KEY}}` is never filled again.
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (match, key: string) => (Object.hasOwn(values, key) ? values[key]! : match))
}

export type IntBounds = { min: number; max: number; fallback: number }
export const SETUP_DAYS: IntBounds = { min: 1, max: 7, fallback: 7 }
export const REPORT_FIRES = 5
export const REPORT_HOUR: IntBounds = { min: 0, max: 24 - REPORT_FIRES, fallback: 5 }

export function intOption(value: unknown, bounds: IntBounds): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)))
}

const STDERR_HEAD_CHARS = 200

export function stderrHead(stderr: string): string {
  return stderr.trim().slice(0, STDERR_HEAD_CHARS)
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function consentLine(sessions: number, batches: number, days: number, summaryModel: string, reportModel: string): string {
  return `${plural(sessions, 'session')} over the last ${plural(days, 'day')}: ${plural(batches, 'summary call')} on ${summaryModel}, then 1 ${reportModel} call`
}

// What the hook fills into a prompt in place of a missing input. Each prompt branches on this text.
export const SETUP_NO_PROFILE = '(none yet)'
export const SUMMARY_NO_PROFILE = '(no profile yet)'
export const SCAN_NO_SESSIONS = '(no sessions'

export function noSessionsScan(days: number): string {
  return `${SCAN_NO_SESSIONS} in the last ${plural(days, 'day')})`
}

export const SCAN_UNREADABLE = `${SCAN_NO_SESSIONS} read: the sessions could not be read)`

export const SETUP_ARGUMENT_HINT = '[schedule | remove]'
export const SETUP_USAGE = `usage: /morning-setup ${SETUP_ARGUMENT_HINT}`

export type SetupArgs = { kind: 'interview' } | { kind: 'schedule' } | { kind: 'remove' } | { kind: 'usage' }

const SETUP_GRAMMAR: Grammar<SetupArgs> = {
  empty: { kind: 'interview' },
  words: { schedule: { kind: 'schedule' }, remove: { kind: 'remove' } },
  valued: {},
  usage: { kind: 'usage' },
}

export function parseSetupArgs(args: string): SetupArgs {
  return parseCommand(args, SETUP_GRAMMAR)
}

export type ScanInput = { since: string; until: string; days: number; summaries: readonly string[] }

export function scanPrompt({ since, until, days, summaries }: ScanInput): string {
  return [`Window: ${since} → ${until} (${plural(days, 'day')}).`, `# Session summaries\n${summaries.join('\n\n')}`].join('\n\n')
}

// The scan model has no slot for missing summaries, so the file itself says what it covers.
export function scanFileText(scan: string, failed: number, sessions: number): string {
  const partial = failed ? `\n${failed} of ${plural(sessions, 'session')} could not be summarized, so Habits covers only part of the window.\n` : ''
  return scan.trim() + '\n' + partial
}
