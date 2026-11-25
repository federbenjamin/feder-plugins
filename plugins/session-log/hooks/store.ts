import { isRecord } from './shared/typed'

// The session log's store: one event per line of `<session-id>.jsonl`, append-only, and the state
// those events fold to. No `$` here; io.ts reads and appends the file.

export type DidFact =
  | { kind: 'file'; path: string }
  | { kind: 'commit'; sha: string; subject: string }
  | { kind: 'push'; ref: string }
  | { kind: 'pr.create'; pr: string }
  | { kind: 'pr.merge'; pr: string }

export type LogEvent = { at: string } & (
  | { t: 'legacy'; path: string }
  | { t: 'todo.add'; id: string; text: string; tag?: string }
  | { t: 'todo.close'; id: string; note?: string }
  | { t: 'decision'; id: string; pick: string; over: string[]; reason: string; replaces?: string; by_session?: string }
  | { t: 'ruling'; id: string; quote: string; meaning: string; key?: string; value?: string; replaces?: string }
  | { t: 'note'; id: string; text: string }
  | { t: 'typed'; text: string }
  | ({ t: 'did' } & DidFact)
)

export type EventOf<T extends LogEvent['t']> = Extract<LogEvent, { t: T }>

export type Todo = { id: string; at: string; text: string; tag?: string; closed?: { at: string; note?: string } }
export type Entry = EventOf<'decision'> | EventOf<'ruling'> | EventOf<'note'>
export type FileTouch = { path: string; count: number; at: string }

export type LogState = {
  legacy?: string
  todos: Todo[]
  entries: Entry[] // decisions, rulings and notes, oldest first
  replaced: Set<string> // ids a later decision or ruling replaces
  did: EventOf<'did'>[] // commits, pushes and PRs, oldest first
  files: FileTouch[] // one per path, oldest touch first
  typed: string[]
}

export function emptyState(): LogState {
  return { todos: [], entries: [], replaced: new Set(), did: [], files: [], typed: [] }
}

// Applies one event in place and returns the state.
export function applyEvent(state: LogState, e: LogEvent): LogState {
  switch (e.t) {
    case 'legacy':
      state.legacy = e.path
      break
    case 'todo.add':
      state.todos.push({ id: e.id, at: e.at, text: e.text, ...(e.tag === undefined ? {} : { tag: e.tag }) })
      break
    case 'todo.close': {
      const todo = state.todos.find(t => t.id === e.id)
      if (todo && !todo.closed) todo.closed = { at: e.at, ...(e.note === undefined ? {} : { note: e.note }) }
      break
    }
    case 'decision':
    case 'ruling':
      state.entries.push(e)
      if (e.replaces !== undefined) state.replaced.add(e.replaces)
      break
    case 'note':
      state.entries.push(e)
      break
    case 'typed':
      state.typed.push(e.text)
      break
    case 'did':
      if (e.kind === 'file') {
        const at = state.files.findIndex(f => f.path === e.path)
        const count = at === -1 ? 0 : state.files.splice(at, 1)[0]!.count
        state.files.push({ path: e.path, count: count + 1, at: e.at })
      } else {
        state.did.push(e)
      }
      break
  }
  return state
}

const KINDS: ReadonlySet<string> = new Set(['legacy', 'todo.add', 'todo.close', 'decision', 'ruling', 'note', 'typed', 'did'])

// The store's text as events. A line that is no event (a cut last line) is skipped.
export function parseStore(text: string): LogEvent[] {
  const events: LogEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const v: unknown = JSON.parse(line)
      if (isRecord(v) && typeof v.t === 'string' && KINDS.has(v.t) && typeof v.at === 'string') events.push(v as LogEvent)
    } catch {
      // not an event
    }
  }
  return events
}

export function foldStore(text: string): LogState {
  return parseStore(text).reduce(applyEvent, emptyState())
}

export function storeLine(e: LogEvent): string {
  return `${JSON.stringify(e)}\n`
}

// The next id of a kind: `t3` after two todos, `d1`, `r1`, `n1`.
export function nextId(state: LogState, prefix: 't' | 'd' | 'r' | 'n'): string {
  const kind = { d: 'decision', r: 'ruling', n: 'note' } as const
  const used = prefix === 't' ? state.todos.length : state.entries.filter(e => e.t === kind[prefix]).length
  return `${prefix}${used + 1}`
}

export const openTodos = (state: LogState): Todo[] => state.todos.filter(t => !t.closed)

// The decisions, rulings and notes nothing later replaces.
export const standing = (state: LogState): Entry[] => state.entries.filter(e => !state.replaced.has(e.id))
