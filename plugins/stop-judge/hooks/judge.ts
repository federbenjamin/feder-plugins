import { PROMPT } from './prompt.ts'
import { contentText, parseRow, SIBLING_TEXTS, typedText } from './shared/typed.ts'
import type { TranscriptRow } from './shared/typed.ts'

// The stop judge's pure side: which transcript rows frame a turn, the request to the model, its
// verdict, and the gates between a verdict and a nudge. register.ts holds every `$` call of the judge.

export const PRIOR_N = 4
export const FRAMING_N = 3
export const MIN_CONFIDENCE = 0.7
export const TAIL_BYTES = 8_000_000
export const NUDGE_PREFIX = `${SIBLING_TEXTS.nudge} ` as const
// The judge's model request: the production path the eval measures.
export const JUDGE_REQUEST = { model: 'haiku', maxTokens: 300, effort: 'low', timeoutMs: 20_000 } as const

// The minutes-since-the-operator's-last-message fact is one switch: off, the request is the
// measured round-3 text and nothing else. Off until a paired run of tools/eval (fact off and on,
// same records, same path) measures a gain past its own noise.
export const MINUTES_FACT = false
export const MINUTES_SENTENCE =
  'The user message also gives the minutes since the operator\'s last typed message. A long gap means unattended work: lean "continue".'

// Earlier messages that ask to be consulted.
export const FRAMING =
  /\bdiscuss|ask me|one by one|one at a time|confirm with me|check with me|show me (first|before)|i want to (approve|see|review)|before (you|we) (build|start|do|change)|do(n'?t| not) (build|start|do|change)|\bwait\b/i

// Every outcome the judge logs, in the order the status line prints them.
export const OUTCOMES = [
  'continue',
  'stop',
  'stop-lowconf',
  'pass-off',
  'pass-subagent',
  'pass-aborted',
  'pass-nested',
  'pass-nudged',
  'pass-keepalive',
  'pass-notext',
  'pass-typing',
  'pass-timeout',
  'pass-error',
] as const

export type Outcome = (typeof OUTCOMES)[number]

type Opening = 'human' | 'plugin' | 'none'
type Verdict = { verdict: 'stop' | 'continue'; reason: string; fields: Record<string, unknown> }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// JSON lines of a transcript tail; the first line may be cut, and sidechain rows are not the session's.
export function parseRows(text: string): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const line of text.split('\n')) {
    const row = parseRow(line)
    if (row) rows.push(row)
  }
  return rows
}

export function assistantText(row: TranscriptRow): string {
  if (row.type !== 'assistant') return ''
  const message = row.message
  return contentText(isRecord(message) ? message.content : undefined)
}

// A user row a plugin submitted (a keepalive ping, an /afk automessage), not the nudge itself.
function pluginText(row: TranscriptRow): string | null {
  if (row.type !== 'user' || row.isMeta || row.isCompactSummary) return null
  const origin = row.origin
  if (!isRecord(origin) || origin.kind !== 'plugin') return null
  const message = row.message
  const raw = isRecord(message) ? message.content : undefined
  if (Array.isArray(raw) && raw.some(b => isRecord(b) && b.type === 'tool_result')) return null
  const text = contentText(raw).trim()
  return text === '' || text.startsWith(NUDGE_PREFIX.trim()) ? null : text
}

// The turn's final message, the message that opened it, and the operator's earlier messages.
// The opening is the newest typed or plugin-submitted user row before the final assistant row.
export function splitTurn(
  rows: readonly TranscriptRow[],
  answer: string | undefined,
): { final: string; opening: string; openingKind: Opening; prior: string[] } {
  let final = answer
  let seenAssistant = final !== undefined
  const found: { text: string; kind: 'human' | 'plugin' }[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    const said = assistantText(row)
    if (row.type === 'assistant') {
      if (said.trim() !== '') {
        seenAssistant = true
        final ??= said
      }
    } else if (seenAssistant) {
      const typed = typedText(row, { sdk: true })
      if (typed) found.push({ text: typed, kind: 'human' })
      else {
        const plugin = pluginText(row)
        if (plugin) found.push({ text: plugin, kind: 'plugin' })
      }
    }
  }
  found.reverse()
  const opening = found.at(-1)
  return {
    final: final ?? '',
    opening: opening?.text ?? '',
    openingKind: opening?.kind ?? 'none',
    prior: found
      .slice(0, -1)
      .filter(f => f.kind === 'human')
      .map(f => f.text),
  }
}

// The session's first message, up to FRAMING_N earlier ones that ask to be consulted, then the
// last `priorN`; in order, without repeats.
export function framingAndPrior(users: readonly string[], priorN: number = PRIOR_N): string[] {
  const recent = priorN > 0 ? users.slice(-priorN) : []
  const older = priorN > 0 ? users.slice(0, -priorN) : users
  const picked = [...(older.length > 0 ? [older[0]!] : []), ...older.filter(u => FRAMING.test(u)).slice(-FRAMING_N)]
  const out: string[] = []
  for (const u of [...picked, ...recent]) if (!out.includes(u)) out.push(u)
  return out
}

// Both ends of a long message: the instruction is often at the top, the question at the bottom.
export function clip(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, Math.floor(n / 2))}\n…\n${text.slice(-Math.floor(n / 2))}`
}

// Whole minutes from the newest typed row to `now`; null with no typed row or no readable time.
export function minutesSinceOperator(rows: readonly TranscriptRow[], now: Date): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (typedText(row, { sdk: true }) === null) continue
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    return Number.isNaN(at) ? null : Math.max(0, Math.floor((now.getTime() - at) / 60_000))
  }
  return null
}

// The minutes fact for a tail: the gap to the newest typed row; with none in the tail, the
// operator wrote before its oldest row, so the gap to that row is a lower bound. null when no row
// carries a readable time.
export type MinutesGap = { minutes: number; isLowerBound: boolean }

export function minutesFact(rows: readonly TranscriptRow[], now: Date): MinutesGap | null {
  if (rows.some(r => typedText(r, { sdk: true }) !== null)) {
    const minutes = minutesSinceOperator(rows, now)
    return minutes === null ? null : { minutes, isLowerBound: false }
  }
  for (const row of rows) {
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    if (!Number.isNaN(at)) return { minutes: Math.max(0, Math.floor((now.getTime() - at) / 60_000)), isLowerBound: true }
  }
  return null
}

// `isMinutesFact` is MINUTES_FACT unless a test sets it.
export function buildSystem(isMinutesFact = MINUTES_FACT): string {
  return isMinutesFact ? `${PROMPT}\n${MINUTES_SENTENCE}\n` : PROMPT
}

// `isLowerBound`: the operator wrote before the transcript tail began, so the gap is "more than".
export function buildUser(final: string, opening: string, prior: readonly string[], minutesSince?: number | null, isLowerBound = false, isMinutesFact = MINUTES_FACT): string {
  let user = ''
  if (prior.length > 0) user += `## Earlier operator messages, oldest first\n\n${prior.map(p => clip(p, 600)).join('\n\n---\n\n')}\n\n`
  user += `## Operator message that opened the turn\n\n${clip(opening, 3000) || '(none captured)'}\n\n## Agent's final message\n\n${final.slice(-4000)}\n\n`
  if (isMinutesFact && typeof minutesSince === 'number') user += `Minutes since the operator's last typed message: ${isLowerBound ? 'more than ' : ''}${minutesSince}\n\n`
  return `${user}One JSON line.`
}

// The whole model request for one turn; `prior` is already picked (framingAndPrior). The gap
// is minutesFact's, whole: its minutes never travel without their lower-bound flag.
export function judgeRequest(final: string, opening: string, prior: readonly string[], gap: MinutesGap | null, isMinutesFact = MINUTES_FACT) {
  return { ...JUDGE_REQUEST, system: buildSystem(isMinutesFact), prompt: buildUser(final, opening, prior, gap?.minutes ?? null, gap?.isLowerBound ?? false, isMinutesFact) }
}

// What the outcome needs of a model reply.
export type JudgeReply = { isAnswered: true; text: string } | { isAnswered: false; reason: string; error?: string }

// A reply's outcome, as the judge logs it: an unanswered call passes (a cut one as a timeout),
// a reply with no verdict is an error, and a verdict goes through the gate.
export function judgeOutcome(reply: JudgeReply): { outcome: 'continue' | 'stop' | 'stop-lowconf' | 'pass-error' | 'pass-timeout'; reason: string; verdict: Verdict | null } {
  if (!reply.isAnswered) return { outcome: reply.reason === 'aborted' ? 'pass-timeout' : 'pass-error', reason: reply.error ? `${reply.reason} ${reply.error}` : reply.reason, verdict: null }
  const verdict = parseVerdict(reply.text)
  if (!verdict) return { outcome: 'pass-error', reason: `no verdict in: ${reply.text.slice(0, 160)}`, verdict: null }
  return { ...decide(verdict), verdict }
}

// The end of the JSON object that starts at `start`, honouring strings; -1 when it never closes.
function objectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

const squash = (v: unknown): string => (v === undefined || v === null ? '' : [...String(v).split(/\s+/).filter(Boolean).join(' ')].slice(0, 300).join(''))

// The judge's JSON line from a reply that may wrap it in prose or a code fence; null where none is there.
export function parseVerdict(text: string): Verdict | null {
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const end = objectEnd(text, i)
    if (end === -1) continue
    let v: unknown
    try {
      v = JSON.parse(text.slice(i, end + 1))
    } catch {
      continue
    }
    if (isRecord(v) && (v.verdict === 'stop' || v.verdict === 'continue')) {
      const { verdict, reason, ...fields } = v
      return { verdict, reason: squash(reason), fields }
    }
  }
  // Unterminated JSON: an unescaped quote or newline in the reason.
  const m = /"verdict"\s*:\s*"(stop|continue)"/.exec(text)
  if (!m) return null
  const r = /"reason"\s*:\s*"([\s\S]*)/.exec(text)
  const reason = (r?.[1] ?? '').split('\n')[0]!.replace(/["} ]+$/, '')
  return { verdict: m[1] as 'stop' | 'continue', reason: squash(reason), fields: {} }
}

// A finite number in [0, 1], else null.
export function confidenceOf(fields: Record<string, unknown>): number | null {
  const c = fields.confidence
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1 ? c : null
}

export function decide(v: Verdict, minConfidence: number = MIN_CONFIDENCE): { outcome: 'continue' | 'stop' | 'stop-lowconf' | 'pass-error'; reason: string } {
  if (v.verdict === 'stop') return { outcome: 'stop', reason: v.reason }
  const conf = confidenceOf(v.fields)
  if (conf === null || conf < minConfidence) return { outcome: 'stop-lowconf', reason: `conf=${conf ?? 'missing'} ${v.reason}` }
  if (v.reason === '') return { outcome: 'pass-error', reason: 'continue with an empty reason' }
  return { outcome: 'continue', reason: v.reason }
}

export function guardOutcome(g: {
  isOff: boolean
  agentId: string | undefined
  reason: string
  nested: boolean
  nudgedThisPrompt: boolean
  openingKind: Opening
  opening: string
  final: string
}): Outcome | null {
  if (g.isOff) return 'pass-off'
  if (g.agentId) return 'pass-subagent'
  if (g.reason !== 'answer') return 'pass-aborted'
  if (g.nested) return 'pass-nested'
  if (g.nudgedThisPrompt) return 'pass-nudged'
  if (g.openingKind === 'plugin' && (g.opening.startsWith(SIBLING_TEXTS.keepalivePing) || g.opening.startsWith(SIBLING_TEXTS.keepaliveLast))) return 'pass-keepalive'
  if (g.final.trim() === '') return 'pass-notext'
  return null
}

export function nudgeText(reason: string): string {
  return `${NUDGE_PREFIX}${reason.replace(/\.+$/, '')}.`
}

export function transcriptFindArgv(home: string, sessionId: string): string[] {
  return ['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${sessionId}.jsonl`]
}
