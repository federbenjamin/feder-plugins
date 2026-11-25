import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { logPaths } from '../hooks/log'
import { applyEvent, emptyState } from '../hooks/store'
import type { LogEvent, LogState } from '../hooks/store'

export const DIR = '/tmp/ss'
export const ID = 'sess-1'
export const CWD = '/work/repo'
export const T0 = Date.UTC(2026, 10, 25, 10, 30)
export const paths = logPaths(DIR, ID)
export const FIRING_LOG = `${DIR}/logs/session-log.log`
export const PREFIX = 'mcp__session-log__'

// A state built from events, for the pure modules' tests. `at` defaults to one fixed minute.
export function stateOf(...events: Record<string, unknown>[]): LogState {
  return events.reduce<LogState>((s, e) => applyEvent(s, { at: '2026-11-25T10:30:00.000Z', ...e } as LogEvent), emptyState())
}

export type ToolReply = { result?: unknown; isError?: boolean; deny?: string }

// The engine beneath the plugin: a file system held in `files` (tee appends to it, `mv -n` moves),
// a mock clock and env, the tools `tool.register` was given, and one terminal `tool.call` handler
// whose reply a test sets in `state.next` (what the real tool would answer the recorder's `next(e)`).
// `state.failWrite` names a path whose `fs.write` rejects; `state.failMove` makes `mv` exit 1 and move nothing. Both are off by default.
// `state.newest` is git's newest commit per folder, as `git -C <dir> log -1` prints it; a folder not in it is no repo.
export function world(on: On, files: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { STOPSTOPPING_DIR: DIR, HOME: '/home/u' })
  const state = { id: ID, next: { result: 'ok' } as ToolReply, writes: [] as string[], runs: [] as string[][], registered: [] as { name: string; isDeferred?: boolean }[], newest: {} as Record<string, string>, failWrite: undefined as string | undefined, failMove: false }
  on('session.id', async () => ({ value: state.id }))
  on('session.cwd', async () => ({ value: CWD }))
  on('fs.exists', async (_$, e) => ({ value: e.path in files }))
  on('fs.read', async (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', async (_$, e) => {
    if (e.path === state.failWrite) throw new Error(`disk refused ${e.path}`)
    state.writes.push(e.path)
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    state.runs.push([...e.argv])
    if (e.argv[0] === 'tee') files[e.argv[2]!] = (files[e.argv[2]!] ?? '') + (e.init?.stdin ?? '')
    if (e.argv[0] === 'mv' && state.failMove) return { value: { exitCode: 1, stdout: '', stderr: 'mv: failed', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'mv') {
      const [from, to] = e.argv.slice(-2) as [string, string]
      const isKept = e.argv[1] === '-n' && to in files // `mv -n` leaves both files when the target exists
      if (!isKept && from in files) {
        files[to] = files[from]!
        delete files[from]
      }
    }
    if (e.argv[0] === 'git' && e.argv[1] === '-C') {
      const line = state.newest[e.argv[2]!]
      return { value: { exitCode: line === undefined ? 128 : 0, stdout: line ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('ui.toast', async () => ({ value: undefined }))
  on('tool.register', async (_$, e) => {
    state.registered.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: `${PREFIX}${e.name}` } } as never
  })
  on('tool.call', async () => state.next as never)
  const events = (): LogEvent[] =>
    (files[paths.store] ?? '')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as LogEvent)
  const firing = (): string[] => (files[FIRING_LOG] ?? '').split('\n').filter(Boolean)
  return { clock, files, state, events, firing }
}

export const typed = (text: string, kind: string = 'composer') => ({ text, wait: false, origin: { kind } as never })

// A model's call of one of the plugin's tools, as a subagent's when `agentId` is given.
export const call = ($: Engine, name: string, input: Record<string, unknown> = {}, agentId?: string) =>
  $.tool.call({ tool: `${PREFIX}${name}`, tool_use_id: 'toolu_1', ...input, ...(agentId === undefined ? {} : { agentId }) } as never) as Promise<{ result?: unknown; deny?: string }>

// A call of any other tool, as the recorder sees it.
export const other = ($: Engine, tool: string, input: Record<string, unknown> = {}, agentId?: string) =>
  $.tool.call({ tool, tool_use_id: 'toolu_2', ...input, ...(agentId === undefined ? {} : { agentId }) } as never) as Promise<{ result?: unknown; deny?: string }>

export const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
