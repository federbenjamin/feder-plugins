import { expect, test } from 'claude-code/testing'
import { renderView } from '../hooks/render'
import { stateOf } from './world'

const section = (view: string, name: string): string[] => {
  const lines = view.split('\n')
  const from = lines.indexOf(`## ${name}`)
  const rest = lines.slice(from + 1)
  const next = rest.findIndex(l => l.startsWith('## '))
  return (next === -1 ? rest : rest.slice(0, next)).filter(l => l !== '')
}

const file = (path: string, at = '2026-11-25T10:30:00.000Z') => ({ t: 'did', kind: 'file', path, at })

test('the view opens with its title and always carries the three sections in order', async () => {
  const view = renderView(stateOf(), 'sess-1')
  expect(view.split('\n')[0]).toBe('# Session log — sess-1')
  const heads = view.split('\n').filter(l => l.startsWith('## '))
  expect(heads).toEqual(['## Work log', '## Todo', '## Decisions'])
})

test('Work log lists commits, pushes and PR lines in the order they happened', async () => {
  const view = renderView(
    stateOf(
      { t: 'did', kind: 'commit', sha: '1a2b3c4', subject: 'fix  the\nthing', at: '2026-11-25T09:05:00.000Z' },
      { t: 'did', kind: 'push', ref: 'feat/x', at: '2026-11-25T09:06:00.000Z' },
      { t: 'did', kind: 'pr.create', pr: 'https://github.com/o/r/pull/7', at: '2026-11-25T09:07:00.000Z' },
      { t: 'did', kind: 'pr.merge', pr: '#7', at: '2026-11-25T09:08:00.000Z' },
    ),
    's',
  )
  expect(section(view, 'Work log')).toEqual([
    '- 2026-11-25 09:05Z commit 1a2b3c4 fix the thing',
    '- 2026-11-25 09:06Z pushed feat/x',
    '- 2026-11-25 09:07Z PR opened https://github.com/o/r/pull/7',
    '- 2026-11-25 09:08Z PR merged #7',
  ])
})

test('Work log says so when a commit output named no sha', async () => {
  const view = renderView(stateOf({ t: 'did', kind: 'commit', sha: '', subject: '' }), 's')
  expect(section(view, 'Work log')).toEqual(['- 2026-11-25 10:30Z commit (its output named no sha)'])
})

test('Work log folds files into one line with the count of paths and a x-count per repeated path', async () => {
  const view = renderView(stateOf(file('/a.ts'), file('/b.ts'), file('/a.ts')), 's')
  // /a.ts was written again after /b.ts, so it is the newest
  expect(section(view, 'Work log')).toEqual(['- files written (2): /a.ts ×2, /b.ts'])
})

test('Work log files line shows the newest ten of twelve, newest first, and says how many it shows', async () => {
  const paths = Array.from({ length: 12 }, (_, i) => `/f${i + 1}.ts`)
  const view = renderView(stateOf(...paths.map(p => file(p))), 's')
  const [line] = section(view, 'Work log')
  expect(line).toBe(`- files written (12, newest 10): ${paths.slice(2).reverse().join(', ')}`)
  expect(line).not.toContain('/f1.ts')
  expect(line).not.toContain('/f2.ts')
})

test('Todo lists open items as "- [ ] <id> <text>" and a closed item leaves the view', async () => {
  const view = renderView(
    stateOf({ t: 'todo.add', id: 't1', text: 'first' }, { t: 'todo.add', id: 't2', text: 'second', tag: 'feat/x' }, { t: 'todo.add', id: 't3', text: 'third' }, { t: 'todo.close', id: 't1' }),
    's',
  )
  const todo = section(view, 'Todo')
  expect(todo).toEqual(['- [ ] t2 second · feat/x', '- [ ] t3 third'])
  for (const l of todo) expect(l).toMatch(/^- \[ \] /)
  expect(view).not.toContain('first')
})

test('Decisions: an agent decision matches "- <date> [agent] pick over A, B -- reason (id)"', async () => {
  const view = renderView(stateOf({ t: 'decision', id: 'd1', pick: 'sqlite', over: ['postgres', 'files'], reason: 'no server', at: '2026-11-25T08:00:00.000Z' }), 's')
  const [line] = section(view, 'Decisions')
  expect(line).toBe('- 2026-11-25 [agent] sqlite over postgres, files -- no server (d1)')
  expect(line).toMatch(/^- \S+ \[agent\] /)
})

test('Decisions: a relayed decision names the session that ruled it', async () => {
  const view = renderView(stateOf({ t: 'decision', id: 'd1', pick: 'A', over: ['B'], reason: 'r', by_session: 'abc-123' }), 's')
  expect(section(view, 'Decisions')).toEqual(['- 2026-11-25 [agent] A over B -- r; decided by session abc-123 (d1)'])
})

test('Decisions: a ruling is "- <date> [user] <meaning>: \"<quote>\"" with no tunable line', async () => {
  const view = renderView(stateOf({ t: 'ruling', id: 'r1', quote: 'never touch main', meaning: 'main is off limits' }), 's')
  const [line, ...more] = section(view, 'Decisions')
  expect(line).toBe('- 2026-11-25 [user] main is off limits: "never touch main" (r1)')
  expect(line).toMatch(/^- 2026-11-25 \[user\] /)
  expect(more).toEqual([])
})

test('Decisions: a tunable ruling adds "tunable: key=value (was old)", was being the last earlier value, else default', async () => {
  const view = renderView(
    stateOf(
      { t: 'ruling', id: 'r1', quote: 'cap 3', meaning: 'cap', key: 'retries', value: '3' },
      { t: 'ruling', id: 'r2', quote: 'cap 5', meaning: 'cap', key: 'retries', value: '5' },
    ),
    's',
  )
  expect(section(view, 'Decisions')).toEqual([
    '- 2026-11-25 [user] cap: "cap 3" (r1)',
    'tunable: retries=3 (was default)',
    '- 2026-11-25 [user] cap: "cap 5" (r2)',
    'tunable: retries=5 (was 3)',
  ])
})

test('Decisions: a decision or ruling that a later one replaces leaves the view, tunable line and all', async () => {
  const view = renderView(
    stateOf(
      { t: 'decision', id: 'd1', pick: 'OLD', over: ['B'], reason: 'r' },
      { t: 'ruling', id: 'r1', quote: 'old quote', meaning: 'm', key: 'k', value: '1' },
      { t: 'decision', id: 'd2', pick: 'NEW', over: ['OLD'], reason: 'r2', replaces: 'd1' },
      { t: 'ruling', id: 'r2', quote: 'new quote', meaning: 'm', key: 'k', value: '2', replaces: 'r1' },
    ),
    's',
  )
  const text = section(view, 'Decisions').join('\n')
  expect(text).not.toContain('(d1)')
  expect(text).not.toContain('old quote')
  expect(text).not.toContain('k=1')
  expect(text).toContain('[agent] NEW over OLD')
  expect(text).toContain('tunable: k=2 (was 1)')
})

test('Decisions: a note is a line of its own and a multi-line quote stays on one line', async () => {
  const view = renderView(stateOf({ t: 'note', id: 'n1', text: 'the cache\nis stale' }, { t: 'ruling', id: 'r1', quote: 'two\nlines', meaning: 'm' }), 's')
  expect(section(view, 'Decisions')).toEqual(['- 2026-11-25 note: the cache is stale (n1)', '- 2026-11-25 [user] m: "two lines" (r1)'])
})

test('a session whose hand-kept log was moved aside names it in the view', async () => {
  const view = renderView(stateOf({ t: 'legacy', path: '/tmp/ss/session-logs/s.legacy.md' }), 's')
  expect(view).toContain('The log kept by hand before the tools: /tmp/ss/session-logs/s.legacy.md')
})
