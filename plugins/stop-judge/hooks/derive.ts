import { quoteKey } from './decisions.ts'
import { actionSummary, clip } from './shared/text.ts'
import { isRecord, parseRow, typedText } from './shared/typed.ts'

export { pool } from './shared/pool.ts'

// The derivation's pure side: which transcripts to read, their typed turns, the reader batches,
// the estimate, and the reader lines that may reach the synthesis. derive-run.ts holds every `$` call.

export const TURN_CAP = 2000
export const BATCH_TURNS = 120
export const BATCH_CHARS = 160_000
export const MIN_TYPED = 2
export const POOL = 4
// Measured 2026-10-20: $0.15 per 117-turn Sonnet reader batch.
export const COST_PER_TURN_USD = 0.0013
// An allowance for the one synthesis call, added to every estimate.
export const SYNTH_ALLOWANCE_USD = 0.3
// About 150k tokens.
export const SYNTH_INPUT_MAX_CHARS = 600_000
// Scripted runs (`claude -p` in a scratch dir) are not the operator's sessions.
export const EXCLUDED_PROJECT_PREFIXES: readonly string[] = ['-private-tmp-', '-private-var-', '-tmp-', '-var-folders-']
// What a line must hold to be a row typedTurnsOf reads: a user row, a compaction, a queued
// prompt, or the agent message before a turn. The host's `grep -E` gets them as one alternation.
const ROW_MARKERS = ['"user"', 'compact_boundary', '"queued_command"', '"type":"assistant"']
export const ROW_GREP_PATTERN = ROW_MARKERS.join('|')
// Only a real tool-result block puts this key unescaped on a line; such a row is never typed.
const TOOL_RESULT_MARKER = '"type":"tool_result"'
const TYPED_LIMIT = 2500
const QUOTE_MAX = 200

export type Candidate = { project: string; path: string; id: string; mtimeMs: number }

export function selectCandidates(
  projects: readonly { name: string; files: readonly { name: string; kind: string; mtimeMs: number }[] }[],
  projectsDir: string,
): Candidate[] {
  const out: Candidate[] = []
  for (const project of projects) {
    if (EXCLUDED_PROJECT_PREFIXES.some(p => project.name.startsWith(p))) continue
    for (const file of project.files) {
      if (file.kind !== 'file' || !file.name.endsWith('.jsonl')) continue
      out.push({ project: project.name, path: `${projectsDir}/${project.name}/${file.name}`, id: file.name.slice(0, -'.jsonl'.length), mtimeMs: file.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export type Turn = { ts: string; text: string; before: string }

// A cheap look at a raw line before it is parsed: whether it can be a typed turn, a compaction, or
// the agent message before one.
export function mayHoldTurn(line: string): boolean {
  return !line.includes(TOOL_RESULT_MARKER) && ROW_MARKERS.some(m => line.includes(m))
}

// One top-level session's lines: its typed turns, each with the agent message before it, and
// the times of its compactions.
export function typedTurnsOf(lines: Iterable<string>): { turns: Turn[]; compactions: string[] } {
  const turns: Turn[] = []
  const compactions: string[] = []
  let before: unknown
  for (const line of lines) {
    if (!mayHoldTurn(line)) continue
    const row = parseRow(line)
    if (row === null) continue
    if (row.type === 'assistant') {
      before = row.message
      continue
    }
    const ts = row.timestamp
    if (typeof ts !== 'string' || ts === '') continue
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      compactions.push(ts)
      continue
    }
    const text = typedText(row, { sdk: false })
    if (text !== null) turns.push({ ts, text, before: actionSummary(before) })
  }
  return { turns, compactions }
}

export type Session = { id: string; project: string; turns: Turn[] }

// Sessions come newest first; the session that crosses the cap keeps its newest turns.
export function packSessions(sessions: readonly Session[], cap: number | null): { kept: Session[]; turns: number } {
  const kept: Session[] = []
  let turns = 0
  for (const session of sessions) {
    if (session.turns.length < MIN_TYPED) continue
    if (cap !== null && turns >= cap) break
    const room = cap === null ? session.turns.length : cap - turns
    const taken = session.turns.length <= room ? session.turns : session.turns.slice(-room)
    kept.push({ ...session, turns: [...taken] })
    turns += taken.length
  }
  return { kept, turns }
}

export type Batch = { sessions: string[]; turns: number; text: string; operatorText: string }

function digest(session: Session, from: number, chunk: readonly Turn[]): { text: string; operator: string[] } {
  const total = session.turns.length
  const first = from + 1
  const last = from + chunk.length
  const span = first === 1 && last === total ? `${total} typed turns` : `turns ${first}-${last} of ${total}`
  const lines = [`# session ${session.id}`, `project: ${session.project} · ${span}`, '']
  const operator: string[] = []
  chunk.forEach((turn, i) => {
    const typed = clip(turn.text.trim(), TYPED_LIMIT)
    operator.push(typed)
    lines.push(`## turn ${first + i} — ${turn.ts}`, "### agent's preceding action", turn.before, '### operator typed', typed, '')
  })
  return { text: lines.join('\n'), operator }
}

// A session longer than `maxTurns` is split into consecutive chunks, each repeating the header.
// `operatorText` is the typed text exactly as the batch shows it, for quote verification.
export function batches(sessions: readonly Session[], maxTurns: number = BATCH_TURNS, maxChars: number = BATCH_CHARS): Batch[] {
  const out: Batch[] = []
  let current = { sessions: new Set<string>(), turns: 0, parts: [] as string[], operator: [] as string[], chars: 0 }
  const close = () => {
    if (current.parts.length > 0) out.push({ sessions: [...current.sessions], turns: current.turns, text: current.parts.join('\n\n'), operatorText: current.operator.join('\n') })
    current = { sessions: new Set(), turns: 0, parts: [], operator: [], chars: 0 }
  }
  for (const session of sessions) {
    for (let start = 0; start < session.turns.length; start += maxTurns) {
      const chunk = session.turns.slice(start, start + maxTurns)
      const { text, operator } = digest(session, start, chunk)
      if (current.parts.length > 0 && (current.turns + chunk.length > maxTurns || current.chars + text.length > maxChars)) close()
      current.sessions.add(session.id)
      current.turns += chunk.length
      current.parts.push(text)
      current.operator.push(...operator)
      current.chars += text.length
    }
  }
  close()
  return out
}

// The date each session's quotes carry: the day of its newest turn.
export function sessionDates(sessions: readonly Session[]): Record<string, string> {
  const dates: Record<string, string> = {}
  for (const s of sessions) {
    const last = s.turns.at(-1)
    if (last) dates[s.id] = last.ts.slice(0, 10)
  }
  return dates
}

// `<t> turns, <first day> to <last day>`: the header's window.
export function windowText(sessions: readonly Session[]): string {
  const days = sessions.flatMap(s => s.turns.map(t => t.ts.slice(0, 10))).sort()
  const turns = days.length
  return turns === 0 ? '0 turns' : `${turns} turns, ${days[0]} to ${days[turns - 1]}`
}

export function estimateUsd(turns: number, usdPerTurn: number): number {
  return turns * usdPerTurn + SYNTH_ALLOWANCE_USD
}

export function confirmText(run: { sessions: number; turns: number; total: number; usd: number }): string {
  return `${run.sessions} sessions, ${run.turns} of ${run.total} typed turns, ~$${run.usd.toFixed(2)}. Run?`
}

export type ReaderLine = { side: 'decide' | 'bring' | 'how'; topic: string; claim: string; quote: string; session: string; turn: number; strength: 'strong' | 'medium' | 'weak'; date: string }

const SIDES: ReadonlySet<string> = new Set(['decide', 'bring', 'how'])
const STRENGTHS: ReadonlySet<string> = new Set(['strong', 'medium', 'weak'])

// One finding per JSON line; a line of another shape, or naming a session not in the batch, is skipped.
export function parseReaderLines(text: string, sessionDates: Record<string, string>): ReaderLine[] {
  const out: ReaderLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(v)) continue
    const { side, topic, claim, quote, session, turn, strength } = v
    if (typeof side !== 'string' || !SIDES.has(side) || typeof strength !== 'string' || !STRENGTHS.has(strength)) continue
    if (typeof topic !== 'string' || typeof claim !== 'string' || typeof quote !== 'string' || typeof session !== 'string') continue
    const date = Object.hasOwn(sessionDates, session) ? sessionDates[session] : undefined
    const n = Number(turn)
    if (date === undefined || topic.trim() === '' || claim.trim() === '' || quote.trim() === '' || !Number.isInteger(n)) continue
    out.push({ side: side as ReaderLine['side'], topic: topic.trim(), claim: claim.trim(), quote: quote.trim(), session, turn: n, strength: strength as ReaderLine['strength'], date })
  }
  return out
}

// A quote survives only when it is the operator's own words in this batch, and short enough for
// the file's format.
export function verifyReaderLines(lines: readonly ReaderLine[], operatorText: string): ReaderLine[] {
  const haystack = quoteKey(operatorText)
  return lines.filter(l => {
    const quote = quoteKey(l.quote)
    return quote !== '' && quote.length <= QUOTE_MAX && haystack.includes(quote)
  })
}

const STRENGTH_RANK: Record<ReaderLine['strength'], number> = { weak: 0, medium: 1, strong: 2 }
const lineText = (l: ReaderLine): string => JSON.stringify(l)

// Over the cap, drops the weakest lines first and the oldest among equals; the rest keep their order.
export function capSynthesisInput(lines: readonly ReaderLine[], maxChars: number): { kept: ReaderLine[]; dropped: number } {
  let size = lines.reduce((n, l) => n + lineText(l).length + 1, 0)
  if (size <= maxChars) return { kept: [...lines], dropped: 0 }
  const order = lines.map((l, i) => i).sort((a, b) => STRENGTH_RANK[lines[a]!.strength] - STRENGTH_RANK[lines[b]!.strength] || lines[a]!.date.localeCompare(lines[b]!.date) || a - b)
  const gone = new Set<number>()
  for (const i of order) {
    if (size <= maxChars) break
    gone.add(i)
    size -= lineText(lines[i]!).length + 1
  }
  return { kept: lines.filter((_, i) => !gone.has(i)), dropped: gone.size }
}

export function synthesisInput(lines: readonly ReaderLine[], currentFile: string | null): string {
  const current = currentFile === null || currentFile.trim() === '' ? '(none yet)' : currentFile.trim()
  const findings = lines.length > 0 ? lines.map(lineText).join('\n') : '(none)'
  return `## Current file\n\n${current}\n\n## Reader findings, one JSON line each\n\n${findings}\n`
}

// from federbenjamin/morning-report hooks/pipeline.ts
export type CallFailure = { reason: string; status?: number | null; error?: string }

// Errors no wait will clear: retrying only repeats them, so the run stops at the first one.
const PERMANENT_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
  'invalid_request',
  'model_not_found',
])

export const RETRY_DELAYS_S = [30, 60, 120, 240] as const

export function isPermanent(f: CallFailure): boolean {
  return f.error !== undefined && PERMANENT_ERRORS.has(f.error)
}

// Seconds to wait before retry number `attempt` (0-based), or undefined to give up. The derive
// readers (derive-run.ts completeWithRetry) ask once, for attempt 0, and only after a non-permanent
// api-error: one retry, never for a timed-out call.
export function retryDelayS(f: CallFailure, attempt: number): number | undefined {
  if (isPermanent(f)) return undefined
  if (f.reason === 'aborted') return attempt === 0 ? RETRY_DELAYS_S[0] : undefined
  return RETRY_DELAYS_S[attempt]
}

// The report is still worth writing when most sessions were summarized.
export function tooManyFailed(total: number, failed: number): boolean {
  return total > 0 && failed * 2 > total
}
// end of the morning-report copy

// A model reply without the code fence it may come wrapped in.
export function contentOfReply(text: string): string {
  const fenced = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/.exec(text)
  return (fenced ? fenced[1]! : text).trim()
}
