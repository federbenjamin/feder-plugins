import { PLUGIN } from './config'
import type { WriteTool } from './calls'

// The six tools an agent keeps the session log with, as `$.tool.register` takes them. Each verb
// is its own tool so its schema can require that verb's fields.

export const READ_TOOL = 'log_read'
export type ToolName = WriteTool | typeof READ_TOOL

const string = { type: 'string' } as const
const object = (properties: Record<string, unknown>, required: readonly string[]) => ({ type: 'object', properties, required, additionalProperties: false })

export const TOOLS: readonly { name: ToolName; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'todo_add',
    description: 'Session log: add an open todo: work that will outlast this turn, or a question, confirmation or choice you are leaving with the operator. Returns its id.',
    inputSchema: object({ text: string, tag: { type: 'string', description: 'A label to group by, such as a branch' } }, ['text']),
  },
  {
    name: 'todo_close',
    description: 'Session log: close a todo by id as soon as it is done, answered or dropped.',
    inputSchema: object({ id: string, note: { type: 'string', description: 'How it ended, when not plainly done' } }, ['id']),
  },
  {
    name: 'decide',
    description: 'Session log: record one choice you made, when you make it: what you picked, what you picked it over, and why. One call per choice, small ones included: a later reader finds each why here and nowhere else.',
    inputSchema: object(
      {
        pick: string,
        over: { type: 'array', items: string, minItems: 1, description: 'The alternatives not chosen' },
        reason: string,
        replaces: { type: 'string', description: 'The id of an earlier decision or ruling this one supersedes' },
        by_session: { type: 'string', description: 'The id of another session, when this is its ruling relayed to you' },
      },
      ['pick', 'over', 'reason'],
    ),
  },
  {
    name: 'ruling',
    description: "Session log: record something the operator ruled, in their own words. The quote must be text they typed in this session. With key and value it sets a session limit.",
    inputSchema: object(
      {
        quote: { type: 'string', description: "The operator's exact words" },
        meaning: { type: 'string', description: 'What the words rule, in one line' },
        key: string,
        value: string,
        replaces: { type: 'string', description: 'The id of an earlier decision or ruling this one supersedes' },
      },
      ['quote', 'meaning'],
    ),
  },
  {
    name: 'note',
    description: 'Session log: record a finding, a measurement or how you checked something, when it lives nowhere else and a later reader will need it.',
    inputSchema: object({ text: string }, ['text']),
  },
  {
    name: READ_TOOL,
    description: "Session log: read the open todos, the standing rulings and decisions, and the recent work, for this session or, with `session`, another session's id.",
    inputSchema: object({ session: string }, []),
  },
]

// The name the model calls a tool by, which a `tool.call` matcher narrows on.
export const calledAs = <N extends string>(name: N): `mcp__${typeof PLUGIN}__${N}` => `mcp__${PLUGIN}__${name}`

export const OWN_TOOLS: ReadonlySet<string> = new Set<string>(TOOLS.map(t => calledAs(t.name)))
