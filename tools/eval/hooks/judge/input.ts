import { DOC_SKIP, FRAMING, INPUT_LIMITS, PLAN_PATH, REFUSED } from './config.ts'
import { assistantText } from './judge.ts'
import { contentText, isRecord, typedText } from './shared/typed.ts'
import type { TranscriptRow } from './shared/typed.ts'

// The judge's user message, built from the transcript tail: the conversation, the facts code can
// read from the rows, what the agent did this turn, the opening of a plan it named, and its final
// message. A "turn" here runs from the operator's last typed message to the final message.

const NOTIFIED = /<tool-use-id>([^<]+)<\/tool-use-id>/g

type Exchange = { operator: string; agent: string }

export type Turn = {
  older: string[] // operator messages before the window that frame the session
  recent: Exchange[]
  opening: string
  operatorText: string // all the operator typed in the tail: what a quote is checked against
  actions: string[]
  minutes: number | null
  along: string[] // the agent's text during the turn, before its final message
  pending: string[]
  refused: string[]
  final: string
}

const flat = (t: unknown): string => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '')

const head = (text: string, n: number): string => {
  const t = text.trim()
  return t.length <= n ? t : `${t.slice(0, n)} […]`
}

const tail = (text: string, n: number): string => {
  const t = text.trim()
  return t.length <= n ? t : `[…] ${t.slice(-n)}`
}

const timeOf = (row: TranscriptRow | undefined): number => (typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN)

const blocksOf = (row: TranscriptRow): Record<string, unknown>[] => {
  const content = isRecord(row.message) ? row.message.content : undefined
  return Array.isArray(content) ? content.filter(isRecord) : []
}

const isToolAgent = (name: unknown): boolean => name === 'Agent' || name === 'Task'

function actionLine(block: Record<string, unknown>): string {
  const name = typeof block.name === 'string' ? block.name : '?'
  const input = isRecord(block.input) ? block.input : {}
  let what: string
  if (name === 'Bash') what = flat(input.description || input.command).slice(0, INPUT_LIMITS.actionChars)
  else if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name)) what = String(input.file_path || input.notebook_path || '')
  else if (isToolAgent(name)) what = flat(input.description).slice(0, INPUT_LIMITS.actionChars)
  else if (name === 'Skill') what = String(input.skill ?? '')
  else what = flat(JSON.stringify(input)).slice(0, INPUT_LIMITS.otherToolChars)
  return `${name}: ${what}${input.run_in_background || isToolAgent(name) ? ' (in background)' : ''}`
}

const resultText = (block: Record<string, unknown>): string => flat(contentText(block.content))

// Background jobs started and not yet reported, and the calls refused since the opening. A job is
// closed by a notification naming its tool use, by a result that is not an async launch, or by a
// TaskStop of its task; one older than the window is taken as gone.
function factsOf(rows: readonly TranscriptRow[], openAt: number, now: number): { pending: string[]; refused: string[] } {
  const started = new Map<unknown, { what: string; at: number; task: unknown }>()
  const closed = new Set<unknown>()
  const stopped = new Set<unknown>()
  const refused: string[] = []
  rows.forEach((row, k) => {
    const content = isRecord(row.message) ? row.message.content : undefined
    const texts = [row.type === 'queue-operation' ? row.content : undefined, typeof content === 'string' ? content : undefined, ...blocksOf(row).filter(b => b.type === 'text').map(b => b.text)]
    for (const text of texts) if (typeof text === 'string') for (const m of text.matchAll(NOTIFIED)) closed.add(m[1])
    for (const block of blocksOf(row)) {
      if (block.type === 'tool_use') {
        const input = isRecord(block.input) ? block.input : {}
        if (block.name === 'TaskStop') stopped.add(input.task_id ?? null)
        if (input.run_in_background || (isToolAgent(block.name) && input.run_in_background !== false)) {
          started.set(block.id, { what: flat(input.description || input.command).slice(0, INPUT_LIMITS.jobChars), at: timeOf(row), task: null })
        }
      } else if (block.type === 'tool_result') {
        const job = started.get(block.tool_use_id)
        const result = row.toolUseResult
        if (job && isRecord(result)) {
          job.task = result.backgroundTaskId || result.agentId || null
          const isLaunch = result.status === 'async_launched' || result.status === undefined || result.status === null
          if (!isLaunch || (!result.backgroundTaskId && !result.isAsync)) closed.add(block.tool_use_id)
        }
        if (block.is_error && k >= openAt) {
          const text = resultText(block)
          if (REFUSED.test(text)) refused.push(text.slice(0, INPUT_LIMITS.errorChars))
        }
      }
    }
  })
  const pending = [...started].filter(([id, job]) => !closed.has(id) && !stopped.has(job.task) && now - job.at < INPUT_LIMITS.backgroundWindowMs).map(([, job]) => job.what)
  return { pending, refused }
}

// The session's first older message and the last few that ask to be consulted, without repeats.
function framing(older: readonly string[]): string[] {
  const picked = [...older.slice(0, 1), ...older.filter(u => FRAMING.test(u)).slice(-INPUT_LIMITS.framingN)]
  return [...new Set(picked)]
}

// `final`'s row ends the turn; with no row holding that text, every row read is before it.
export function readTurn(rows: readonly TranscriptRow[], final: string): Turn {
  const found = rows.findLastIndex(r => r.type === 'assistant' && assistantText(r) === final)
  const end = found === -1 ? rows.length : found
  const said: { at: number; text: string }[] = []
  rows.slice(0, end).forEach((row, at) => {
    const text = typedText(row, { sdk: true })
    if (text) said.push({ at, text })
  })
  const openAt = said.at(-1)?.at ?? 0
  const lastAgent = (from: number, to: number): string => {
    for (let k = to - 1; k > from; k--) {
      const text = assistantText(rows[k]!)
      if (text.trim() !== '') return text
    }
    return ''
  }
  const exchanges = said.slice(0, -1).map((s, n) => ({ operator: s.text, agent: lastAgent(s.at, said[n + 1]!.at) }))
  const errors = new Map<unknown, string>()
  for (const row of rows.slice(openAt, end + 1)) {
    for (const block of blocksOf(row)) if (block.type === 'tool_result' && block.is_error) errors.set(block.tool_use_id, resultText(block).slice(0, INPUT_LIMITS.errorChars))
  }
  const actions: string[] = []
  const along: string[] = []
  for (const row of rows.slice(openAt, end)) {
    if (row.type !== 'assistant') continue
    for (const block of blocksOf(row)) {
      if (block.type !== 'tool_use') continue
      const error = errors.get(block.id)
      actions.push(actionLine(block) + (error === undefined ? '' : ` — FAILED: ${error}`))
    }
    const text = assistantText(row)
    if (text.trim() !== '') along.push(text)
  }
  const endAt = timeOf(rows[Math.min(end, rows.length - 1)])
  const gapMs = endAt - timeOf(rows[openAt])
  return {
    older: framing(exchanges.slice(0, -INPUT_LIMITS.window).map(e => e.operator)),
    recent: exchanges.slice(-INPUT_LIMITS.window),
    opening: said.at(-1)?.text ?? '',
    operatorText: said.map(s => s.text).join('\n'),
    actions,
    minutes: Number.isNaN(gapMs) ? null : Math.round(gapMs / 60_000),
    along,
    final,
    ...factsOf(rows.slice(0, end + 1), openAt, endAt),
  }
}

// The Markdown files under the home folder that the turn names, oldest mention first, leaving out
// the session logs and transcripts; `~` is kept as written.
export function namedDocs(turn: Turn, home: string): string[] {
  const root = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const path = new RegExp(`(?:~${root === '' ? '' : `|${root}`})/[\\w./\\-]+\\.md`, 'g')
  const texts = [...turn.recent.slice(-3).flatMap(e => [e.operator, e.agent]), turn.opening, ...turn.actions, turn.final]
  const seen = new Set<string>()
  for (const text of texts) {
    for (const [p] of text.matchAll(path)) if (!DOC_SKIP.some(s => expandHome(p, home).includes(s))) seen.add(p)
  }
  return [...seen]
}

export function expandHome(path: string, home: string): string {
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

// The plan among the last few documents that exist: the last whose path says it is one.
export function planOf(existing: readonly string[]): string | null {
  return existing.slice(-INPUT_LIMITS.maxDocs).findLast(p => PLAN_PATH.test(p)) ?? null
}

export function buildInput(turn: Turn, plan: { path: string; body: string } | null): string {
  let user = ''
  if (turn.older.length > 0) user += `## Older operator messages, oldest first\n\n${turn.older.map(u => head(u, INPUT_LIMITS.framingClip)).join('\n\n---\n\n')}\n\n`
  if (turn.recent.length > 0) user += `## Recent conversation, oldest first\n\n${turn.recent.map(e => `Operator: ${head(e.operator, INPUT_LIMITS.operatorClip)}\n\nAgent: ${tail(e.agent, INPUT_LIMITS.agentClip) || '(no text)'}`).join('\n\n')}\n\n`
  user += `## Operator message that opened the turn\n\n${head(turn.opening, INPUT_LIMITS.openingClip) || '(none captured)'}\n\n`
  user += `## Facts read from the transcript\n\nBackground jobs not yet reported: ${turn.pending.join('; ') || 'none'}\nTool calls refused this turn: ${turn.refused.join('; ') || 'none'}\n\n`
  const shown = turn.actions.slice(-INPUT_LIMITS.maxActions)
  user += `## What the agent did this turn\n\n${turn.actions.length} tool calls${turn.minutes === null ? '' : ` over ${turn.minutes} minutes`}.\n`
  if (turn.actions.length > shown.length) user += `(the last ${shown.length} of them)\n`
  user += `${shown.map(a => `- ${a}\n`).join('')}\n`
  if (turn.along.length > 0) user += `What it said along the way, the latest last:\n\n${turn.along.slice(-INPUT_LIMITS.alongTheWay).map(m => tail(m, INPUT_LIMITS.alongClip)).join('\n\n')}\n\n`
  if (plan) user += `## Plan document ${plan.path}, its opening\n\n${plan.body.slice(0, INPUT_LIMITS.planChars)}\n\n`
  return `${user}## Agent's final message\n\n${turn.final.slice(-INPUT_LIMITS.finalChars)}\n\nOne JSON line.`
}
