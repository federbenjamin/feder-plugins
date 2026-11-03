import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

export const MIN = 60_000
export const T0 = 1_000_000

export type Agent = { id: string; status: string }

// The engine beneath the plugin: a mock clock and env, a log sink, a prompt recorder, an
// agent list the test edits, and a tool.call hook that holds each call open until the test frees it.
export function world(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { STOPSTOPPING_DIR: '/tmp/ss' })
  const logged: string[] = []
  const prompts: string[] = []
  const state = { agents: [] as Agent[], isSubmitRefused: false, isSubmitDropped: false, listCalls: 0 }
  const holds: (() => void)[] = []
  on('fs.exists', async () => ({ value: true }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'tee') logged.push(e.init?.stdin ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('agent.list', async () => {
    state.listCalls++
    return { value: state.agents as never }
  })
  on('prompt.submit', async (_$, e) => {
    if (state.isSubmitRefused) throw new Error('refused')
    if (state.isSubmitDropped) return { drop: 'dropped' }
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', async (_$, e) => {
    await new Promise<void>(resolve => holds.push(resolve))
    return { result: 'ok', tool: e.tool } as never
  })
  return { clock, logged, prompts, state, release: () => holds.splice(0).forEach(r => r()) }
}

export const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive })

export const running = (...ids: string[]): Agent[] => ids.map(id => ({ id, status: 'running' }))
