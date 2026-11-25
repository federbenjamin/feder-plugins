import { FILES_SHOWN } from './config'
import { openTodos, standing } from './store'
import type { Entry, EventOf, LogState } from './store'

// The view: `<session-id>.md`, written from the store after every write, in the three sections
// and line shapes a hand-kept log had, so whatever read that file reads this one.

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const date = (at: string): string => at.slice(0, 10)
const minute = (at: string): string => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`

function didLine(e: EventOf<'did'>): string {
  const when = minute(e.at)
  switch (e.kind) {
    case 'commit':
      return e.sha === '' ? `- ${when} commit (its output named no sha)` : `- ${when} commit ${e.sha} ${oneLine(e.subject)}`
    case 'push':
      return `- ${when} pushed${e.ref === '' ? '' : ` ${e.ref}`}`
    case 'pr.create':
      return `- ${when} PR opened${e.pr === '' ? '' : ` ${e.pr}`}`
    case 'pr.merge':
      return `- ${when} PR merged${e.pr === '' ? '' : ` ${e.pr}`}`
    case 'file':
      return `- ${when} wrote ${e.path}`
  }
}

function filesLine(state: LogState): string[] {
  if (state.files.length === 0) return []
  const newest = [...state.files].reverse().slice(0, FILES_SHOWN)
  const names = newest.map(f => (f.count > 1 ? `${f.path} ×${f.count}` : f.path)).join(', ')
  const more = state.files.length > newest.length ? `, newest ${newest.length}` : ''
  return [`- files written (${state.files.length}${more}): ${names}`]
}

// What a session limit held before this ruling set it: the last earlier ruling on the key.
function was(state: LogState, ruling: EventOf<'ruling'>): string {
  let old = 'default'
  for (const e of state.entries) {
    if (e === ruling) break
    if (e.t === 'ruling' && e.key === ruling.key && e.value !== undefined) old = e.value
  }
  return old
}

function entryLines(state: LogState, e: Entry): string[] {
  switch (e.t) {
    case 'decision': {
      const by = e.by_session === undefined ? '' : `; decided by session ${e.by_session}`
      return [`- ${date(e.at)} [agent] ${oneLine(e.pick)} over ${e.over.map(oneLine).join(', ')} -- ${oneLine(e.reason)}${by} (${e.id})`]
    }
    case 'ruling': {
      const line = `- ${date(e.at)} [user] ${oneLine(e.meaning)}: "${oneLine(e.quote)}" (${e.id})`
      return e.key === undefined ? [line] : [line, `tunable: ${e.key}=${e.value} (was ${was(state, e)})`]
    }
    case 'note':
      return [`- ${date(e.at)} note: ${oneLine(e.text)} (${e.id})`]
  }
}

export function renderView(state: LogState, sessionId: string): string {
  const todos = openTodos(state).map(t => `- [ ] ${t.id} ${oneLine(t.text)}${t.tag === undefined ? '' : ` · ${t.tag}`}`)
  return [
    `# Session log — ${sessionId}`,
    '',
    `A view the session-log plugin writes from ${sessionId}.jsonl after every write. Never edit it: record with the session-log tools.`,
    ...(state.legacy === undefined ? [] : [`The log kept by hand before the tools: ${state.legacy}`]),
    '',
    '## Work log',
    '',
    ...state.did.map(didLine),
    ...filesLine(state),
    '',
    '## Todo',
    '',
    ...todos,
    '',
    '## Decisions',
    '',
    ...standing(state).flatMap(e => entryLines(state, e)),
    '',
  ].join('\n')
}
