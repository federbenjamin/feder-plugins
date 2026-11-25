import { isOperatorQuote, isRecord } from './shared/typed'
import { nextId, openTodos, standing } from './store'
import type { LogEvent, LogState } from './store'

// What each writing tool does to the store: the events it appends and the reply the agent reads,
// or the reason it is refused. Pure; register.ts appends the events.

export type WriteTool = 'todo_add' | 'todo_close' | 'decide' | 'ruling' | 'note'

export type CallResult = { events: LogEvent[]; reply: string } | { refuse: string }

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

// `over` as a list: an array of texts, or one text.
function alternatives(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v]).map(text).filter(t => t !== '')
}

const optional = <K extends string>(key: K, value: string): { [P in K]?: string } => (value === '' ? {} : ({ [key]: value } as { [P in K]: string }))

// The id a decision or ruling replaces: one that stands and is no note.
function replacesProblem(state: LogState, id: string): string | undefined {
  if (id === '') return undefined
  const ids = standing(state)
    .filter(e => e.t !== 'note')
    .map(e => e.id)
  return ids.includes(id) ? undefined : `replaces: no standing decision or ruling ${id}; standing: ${ids.join(', ') || 'none'}`
}

export function callTool(state: LogState, tool: WriteTool, input: unknown, now: Date): CallResult {
  const i = isRecord(input) ? input : {}
  const at = now.toISOString()
  switch (tool) {
    case 'todo_add': {
      const body = text(i.text)
      if (body === '') return { refuse: 'todo_add needs text' }
      const id = nextId(state, 't')
      return { events: [{ t: 'todo.add', at, id, text: body, ...optional('tag', text(i.tag)) }], reply: `added ${id}` }
    }
    case 'todo_close': {
      const id = text(i.id)
      const todo = state.todos.find(t => t.id === id)
      if (todo === undefined) {
        return {
          refuse: `no todo ${id || '(no id)'}; open: ${
            openTodos(state)
              .map(t => t.id)
              .join(', ') || 'none'
          }`,
        }
      }
      if (todo.closed) return { events: [], reply: 'already closed' }
      return { events: [{ t: 'todo.close', at, id, ...optional('note', text(i.note)) }], reply: `closed ${id}` }
    }
    case 'decide': {
      const pick = text(i.pick)
      const over = alternatives(i.over)
      const reason = text(i.reason)
      if (pick === '') return { refuse: 'decide needs pick: what you chose' }
      if (over.length === 0) return { refuse: 'decide needs over: at least one alternative you did not choose' }
      if (reason === '') return { refuse: 'decide needs reason: why the pick won' }
      const replaces = text(i.replaces)
      const problem = replacesProblem(state, replaces)
      if (problem !== undefined) return { refuse: problem }
      const id = nextId(state, 'd')
      return { events: [{ t: 'decision', at, id, pick, over, reason, ...optional('replaces', replaces), ...optional('by_session', text(i.by_session)) }], reply: `recorded ${id}` }
    }
    case 'ruling': {
      const quote = text(i.quote)
      const meaning = text(i.meaning)
      const key = text(i.key)
      const value = text(i.value)
      if (quote === '' || meaning === '') return { refuse: "ruling needs quote (the operator's exact words) and meaning (what they rule)" }
      if ((key === '') !== (value === '')) return { refuse: 'ruling takes key and value together, for a session limit' }
      // One prompt holds the whole quote: words from two prompts are not something they said.
      if (!state.typed.some(prompt => isOperatorQuote(quote, prompt))) {
        return { refuse: 'ruling refused: the quote is not in what the operator typed in this session. Quote their exact words; for a ruling another session relayed, use decide with by_session.' }
      }
      const replaces = text(i.replaces)
      // A repeat of a ruling that still stands writes nothing. One that replaces a line is new:
      // the operator may be saying again what a later line overturned.
      const same = replaces !== '' ? undefined : standing(state).find(e => e.t === 'ruling' && isOperatorQuote(quote, e.quote) && isOperatorQuote(e.quote, quote) && (e.key ?? '') === key && (e.value ?? '') === value)
      if (same !== undefined) return { events: [], reply: `already recorded as ${same.id}` }
      const problem = replacesProblem(state, replaces)
      if (problem !== undefined) return { refuse: problem }
      const id = nextId(state, 'r')
      return { events: [{ t: 'ruling', at, id, quote, meaning, ...optional('key', key), ...optional('value', value), ...optional('replaces', replaces) }], reply: `recorded ${id}` }
    }
    case 'note': {
      const body = text(i.text)
      if (body === '') return { refuse: 'note needs text' }
      const id = nextId(state, 'n')
      return { events: [{ t: 'note', at, id, text: body }], reply: `recorded ${id}` }
    }
  }
}
