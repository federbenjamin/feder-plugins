import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Summary } from '../types'
import { PLUGIN } from '../hooks/config'
import { registerPane } from '../hooks/pane'
import { register } from '../hooks/register'
import { capturePath, paneLines } from '../hooks/summary'

const T0 = Date.parse('2026-10-23T12:00:00Z')
const DIR = '/tmp/state'
const ID = 'synthetic-session'

const summary = (changes: Partial<Summary> = {}): Summary => ({
  soFar: 'Build the summary plugin',
  now: 'Pin its lifecycle contract',
  files: ['plugins/session-summary/hooks/register.ts'],
  at: T0 - 2 * 60_000,
  status: 'running',
  source: 'messages',
  variant: 'edit',
  ...changes,
})

function world(on: On, capture = '') {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { STOPSTOPPING_DIR: DIR })
  mock.store(on)
  const commands: string[] = []
  const opened: string[] = []
  const reads: string[] = []
  on('fs.exists', async (_$, e) => ({ value: e.path === capturePath(DIR, ID) && capture !== '' }))
  on('fs.read', async (_$, e) => {
    reads.push(e.path)
    return { value: capture }
  })
  on('session.id', async () => ({ value: ID }))
  on('command.register', async (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', async (_$, e) => {
    opened.push(e.requestId)
    return { value: undefined }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  return { clock, commands, opened, reads }
}

test('the pane registration is scoped to the Session pane request', async () => {
  const registrations: { event: string; options: unknown }[] = []
  const on = ((event: string, options: unknown) => registrations.push({ event, options })) as unknown as On
  registerPane(on)
  expect(registrations).toEqual([{ event: 'ui.render', options: { component: 'Pane', requestId: PLUGIN } }])
})

test('the pane keeps labels and freshness dim while leaving summary content readable', async () => {
  expect(paneLines(summary(), T0)).toEqual([
    { text: 'So far', dim: true },
    { text: 'Build the summary plugin', dim: false },
    { text: 'Now', dim: true },
    { text: 'Pin its lifecycle contract', dim: false },
    { text: 'plugins/session-summary/hooks/register.ts', dim: true },
    { text: 'updated 2 min ago · messages · edit', dim: true },
  ])
})

test('an empty summary says so instead of rendering blank pane rows', async () => {
  expect(paneLines(summary({ soFar: '', now: '', files: [], at: 0 }), T0)).toEqual([
    { text: 'So far', dim: true },
    { text: '(none yet)', dim: false },
    { text: 'Now', dim: true },
    { text: '(none yet)', dim: false },
    { text: 'no summary yet', dim: true },
  ])
})

test('register installs the pane and every session lifecycle hook', async () => {
  const events: string[] = []
  const on = ((event: string) => events.push(event)) as unknown as On
  register(on)
  expect(events).toEqual(expect.arrayContaining(['ui.render', 'session.start', 'turn.start', 'turn.complete', 'session.end', 'command.run']))
})

test('a non-interactive session still registers /session-summary without opening a pane', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(w.commands).toEqual([PLUGIN])
  expect(w.opened).toEqual([])
})

test('an interactive session restores its synthetic capture before opening the Session pane', async ($, on) => {
  const capture = `${JSON.stringify({ at: '2026-10-23T11:58:00.000Z', soFar: 'Earlier work', now: 'Resume it', files: [], status: 'running', source: 'messages', variant: 'edit' })}\n`
  const w = world(on, capture)
  await $.session.start({ cwd: '/tmp/project', surface: 'terminal', isInteractive: true })
  expect(w.reads).toEqual([capturePath(DIR, ID)])
  expect(w.commands).toEqual([PLUGIN])
  expect(w.opened).toEqual([PLUGIN])
  await w.clock.advance(30_000)
})
