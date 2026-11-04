import type { ModelUsage } from 'claude-code'
import { JUDGE_REQUEST } from './config.ts'
import type { Judged } from './decide.ts'
import { PROMPT } from './prompt.ts'
import { contentText, isRecord, parseRow, SIBLING_TEXTS, typedText } from './shared/typed.ts'
import type { TranscriptRow } from './shared/typed.ts'

// The stop judge's pure side: the rows that end a turn, the request to the model, the gates around
// a nudge, and the capture. input.ts builds the user message, decide.ts reads the reply, and
// register.ts holds every `$` call of the judge.

export const NUDGE_PREFIX = `${SIBLING_TEXTS.nudge} ` as const

// Every outcome the judge logs, in the order the status line prints them.
export const OUTCOMES = [
  'continue',
  'stop',
  'pass-off',
  'pass-subagent',
  'pass-aborted',
  'pass-nested',
  'pass-scripted',
  'pass-nudged',
  'pass-keepalive',
  'pass-notext',
  'pass-typing',
  'pass-late',
  'pass-timeout',
  'pass-error',
] as const

export type Outcome = (typeof OUTCOMES)[number]

type Opening = 'human' | 'plugin' | 'none'

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

// The turn's final message and what started it: the newest typed or plugin-submitted user row
// before the final assistant row. The gates read this; input.ts reads the conversation.
export function splitTurn(rows: readonly TranscriptRow[], answer: string | undefined): { final: string; opening: string; openingKind: Opening } {
  let final = answer
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.type === 'assistant') {
      const said = assistantText(row)
      if (said.trim() !== '') final ??= said
    } else if (final !== undefined) {
      const typed = typedText(row, { sdk: true })
      if (typed) return { final, opening: typed, openingKind: 'human' }
      const plugin = pluginText(row)
      if (plugin) return { final, opening: plugin, openingKind: 'plugin' }
    }
  }
  return { final: final ?? '', opening: '', openingKind: 'none' }
}

// The cache mark reaches the API's prompt cache for five minutes; the fixed text is its prefix.
export function judgeRequest(input: string, system: string = PROMPT) {
  return { ...JUDGE_REQUEST, system: [{ text: system, cache: true as const }], prompt: input }
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

// A project folder named for a scratch path. A session that started in `/tmp` itself is in
// `-private-tmp`, so a name counts whole or as a prefix up to a dash.
const SCRATCH_PROJECTS: readonly string[] = ['-private-tmp', '-private-var', '-tmp', '-var-folders']

export function isScratchProject(name: string): boolean {
  return SCRATCH_PROJECTS.some(p => name === p || name.startsWith(`${p}-`))
}

// A `claude -p` run started in a scratch folder is a script's, not the operator's work. A headless
// agent in a repo or worktree is still judged.
export function isScriptedRun(isInteractive: boolean, transcriptPath: string): boolean {
  return !isInteractive && isScratchProject(transcriptPath.split('/').at(-2) ?? '')
}

// A nudge is late once a newer main turn has started, running or already over: `$.prompt.submit`
// would queue it behind that turn, to land on work it was never about.
export function isNudgeLate(t: { isTurnRunning: boolean; lastEnded: string | undefined; judged: string }): boolean {
  return t.isTurnRunning || t.lastEnded !== t.judged
}

export function nudgeText(reason: string): string {
  return `${NUDGE_PREFIX}${reason.replace(/\.+$/, '')}.`
}

export function transcriptFindArgv(home: string, sessionId: string): string[] {
  return ['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${sessionId}.jsonl`]
}

export function capturePath(dir: string, sessionId: string): string {
  return `${dir}/stop-judge-captures/${sessionId}.jsonl`
}

// One judged turn, whatever became of it: the exact message sent, the raw reply, and what the code
// made of them. `outcome` is the firing line's; it differs from `decision` when a gate stopped a nudge.
export type Capture = Pick<Judged, 'answers' | 'quotes' | 'decision'> & {
  at: string
  turnId: string
  input: string
  inputChars: number
  plan: string | null
  reply: string | null
  outcome: string
  reason: string
  ms: number
  usage: ModelUsage
  usd: number
}

export function captureLine(c: Capture): string {
  return `${JSON.stringify(c)}\n`
}
