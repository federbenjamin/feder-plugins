import { expect, test } from 'claude-code/testing'
import { call, ID, other, paths, start, typed, world } from './world'

const outcomes = (lines: string[]) => lines.map(l => l.split(' ')[1])

test('session.start registers the six tools with isDeferred false and logs one tools line', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.state.registered.map(t => t.name)).toEqual(['todo_add', 'todo_close', 'decide', 'ruling', 'note', 'log_read'])
  expect(w.state.registered.every(t => t.isDeferred === false)).toBe(true)
  expect(outcomes(w.firing())).toEqual(['tools'])
  expect(w.firing()[0]).toMatch(/reason=registered=6$/)
})

test('every tool call logs exactly one firing line, named for the tool', async ($, on) => {
  const w = world(on)
  await call($, 'todo_add', { text: 'a' })
  await call($, 'note', { text: 'n' })
  await call($, 'log_read')
  await call($, 'decide', { pick: 'A', over: [], reason: 'r' }) // refused: still one line
  expect(outcomes(w.firing())).toEqual(['todo-add', 'note', 'read', 'refused'])
})

test('a todo added, closed, then closed again: the second close writes nothing and replies already closed', async ($, on) => {
  const w = world(on)
  expect((await call($, 'todo_add', { text: 'a' })).result).toBe('added t1')
  expect((await call($, 'todo_close', { id: 't1' })).result).toBe('closed t1')
  const before = w.events().length
  expect((await call($, 'todo_close', { id: 't1' })).result).toBe('already closed')
  expect(w.events()).toHaveLength(before)
})

test('a refused call denies with the reason and appends nothing to the store or the view', async ($, on) => {
  const w = world(on)
  const r = await call($, 'decide', { pick: 'A', over: ['B'], reason: '' })
  expect(r.deny).toContain('reason')
  expect(w.files[paths.store]).toBeUndefined()
  expect(w.files[paths.view]).toBeUndefined()
})

test('a call from a subagent is refused with a one-line reason and writes nothing', async ($, on) => {
  const w = world(on)
  const r = await call($, 'todo_add', { text: 'a' }, 'agent-1')
  expect(r.deny).toMatch(/subagent/)
  expect(r.deny).not.toContain('\n')
  expect(w.files[paths.store]).toBeUndefined()
  expect(w.files[paths.view]).toBeUndefined()
  expect(outcomes(w.firing())).toEqual(['refused'])
})

test('a subagent may not read the log either', async ($, on) => {
  const w = world(on, { [paths.view]: '# hand kept' })
  expect((await call($, 'log_read', {}, 'agent-1')).deny).toMatch(/subagent/)
})

test('a ruling quoting a typed composer prompt passes, an invented quote is refused with a pointer to decide', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(typed('please never force push to main'))
  const ok = await call($, 'ruling', { quote: 'never force push', meaning: 'no force push' })
  expect(ok.result).toBe('recorded r1')
  const bad = await call($, 'ruling', { quote: 'always squash', meaning: 'squash' })
  expect(bad.deny).toContain('decide')
  expect(bad.deny).toContain('by_session')
  expect(w.events().filter(e => e.t === 'ruling')).toHaveLength(1)
})

test('a headless sdk prompt counts as typed, a peer prompt does not', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(typed('use the staging bucket', 'sdk'))
  await $.prompt.submit(typed('delete the production bucket', 'peer'))
  expect((await call($, 'ruling', { quote: 'staging bucket', meaning: 'm' })).result).toBe('recorded r1')
  expect((await call($, 'ruling', { quote: 'delete the production bucket', meaning: 'm' })).deny).toBeDefined()
  expect(w.events().filter(e => e.t === 'typed')).toHaveLength(1)
})

test('the same ruling quote recorded twice through the tool writes nothing the second time', async ($, on) => {
  const w = world(on)
  await $.prompt.submit(typed('keep it small'))
  await call($, 'ruling', { quote: 'keep it small', meaning: 'size' })
  const before = w.events().length
  expect((await call($, 'ruling', { quote: 'keep it small', meaning: 'size' })).result).toBe('already recorded as r1')
  expect(w.events()).toHaveLength(before)
})

test('log_read of a session with no store returns that session\'s .md text as it is', async ($, on) => {
  const old = '# Session log — old\n\n## Todo\n\n- [ ] hand-written\n'
  const w = world(on, { '/tmp/ss/session-logs/old-1.md': old })
  expect((await call($, 'log_read', { session: 'old-1' })).result).toBe(old)
  expect(w.files['/tmp/ss/session-logs/old-1.jsonl']).toBeUndefined()
})

test('log_read of a session nobody logged says so, and a session id with a path in it is refused', async ($, on) => {
  world(on)
  expect((await call($, 'log_read', { session: 'nope' })).result).toBe('no log for session nope')
  expect((await call($, 'log_read', { session: '../../etc/passwd' })).deny).toContain('session id')
})

test('log_read of the running session renders its store', async ($, on) => {
  world(on)
  await call($, 'todo_add', { text: 'open item' })
  expect((await call($, 'log_read')).result).toContain('- [ ] t1 open item')
})

test('the view is rewritten after every write', async ($, on) => {
  const w = world(on)
  await call($, 'todo_add', { text: 'one' })
  expect(w.files[paths.view]).toContain('- [ ] t1 one')
  await call($, 'todo_close', { id: 't1' })
  expect(w.files[paths.view]).not.toContain('one')
})

test('the first write of a session whose .md exists with no store moves it to .legacy.md and the view names it', async ($, on) => {
  const w = world(on, { [paths.view]: '# hand kept log\n- [ ] old todo\n' })
  await call($, 'todo_add', { text: 'new' })
  expect(w.files[paths.legacy]).toBe('# hand kept log\n- [ ] old todo\n')
  expect(w.files[paths.view]).toContain(`The log kept by hand before the tools: ${paths.legacy}`)
  expect(w.files[paths.view]).not.toContain('old todo')
  expect(w.events()[0]).toMatchObject({ t: 'legacy', path: paths.legacy })
  expect(outcomes(w.firing())).toContain('legacy')
  // moved once: the second write leaves the legacy file and adds no second legacy event
  await call($, 'todo_add', { text: 'again' })
  expect(w.events().filter(e => e.t === 'legacy')).toHaveLength(1)
})

test('state survives a reload: the store is read back and the ids continue', async ($, on) => {
  const w = world(on)
  await call($, 'todo_add', { text: 'a' })
  await call($, 'todo_add', { text: 'b' })
  w.state.id = 'other-session'
  await call($, 'todo_add', { text: 'elsewhere' })
  w.state.id = ID // back: the session is loaded again from its store
  expect((await call($, 'todo_add', { text: 'c' })).result).toBe('added t3')
  expect((await call($, 'todo_close', { id: 't1' })).result).toBe('closed t1')
  expect(w.files[paths.view]).toContain('- [ ] t2 b')
  expect(w.files[paths.view]).toContain('- [ ] t3 c')
})

test('a Write that succeeded is recorded as a did event and shows in the view', async ($, on) => {
  const w = world(on)
  await other($, 'Write', { file_path: '/work/repo/a.ts', content: 'x' })
  await other($, 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })
  expect(w.events().map(e => e.t)).toEqual(['did', 'did'])
  expect(w.files[paths.view]).toContain('- files written (1): /work/repo/a.ts ×2')
  expect(outcomes(w.firing())).toEqual(['did', 'did'])
})

test('a Bash commit and a push are recorded from the tool result', async ($, on) => {
  const w = world(on)
  w.state.next = { result: { stdout: '[main 1a2b3c4] fix it\n', stderr: '' } }
  await other($, 'Bash', { command: 'git commit -m "fix it"' })
  w.state.next = { result: { stdout: '', stderr: '   1a2b3c4..5d6e7f8  main -> main\n' } }
  await other($, 'Bash', { command: 'git push' })
  expect(w.events()).toMatchObject([
    { t: 'did', kind: 'commit', sha: '1a2b3c4', subject: 'fix it' },
    { t: 'did', kind: 'push', ref: 'main' },
  ])
})

test('gh pr create and gh pr merge are recorded from the tool result', async ($, on) => {
  const w = world(on)
  w.state.next = { result: 'https://github.com/o/r/pull/9\n' }
  await other($, 'Bash', { command: 'gh pr create --fill' })
  w.state.next = { result: 'Merged' }
  await other($, 'Bash', { command: 'gh pr merge 9 --squash' })
  expect(w.events()).toMatchObject([
    { t: 'did', kind: 'pr.create', pr: 'https://github.com/o/r/pull/9' },
    { t: 'did', kind: 'pr.merge', pr: '#9' },
  ])
})

test('a failed call records nothing', async ($, on) => {
  const w = world(on)
  w.state.next = { result: 'boom', isError: true }
  await other($, 'Write', { file_path: '/a.ts' })
  w.state.next = { deny: 'blocked' }
  await other($, 'Write', { file_path: '/b.ts' })
  expect(w.files[paths.store]).toBeUndefined()
})

test("a subagent's call records nothing", async ($, on) => {
  const w = world(on)
  await other($, 'Write', { file_path: '/a.ts' }, 'agent-1')
  expect(w.files[paths.store]).toBeUndefined()
})

test('a read-only tool records nothing', async ($, on) => {
  const w = world(on)
  await other($, 'Read', { file_path: '/a.ts' })
  await other($, 'Grep', { pattern: 'x' })
  expect(w.files[paths.store]).toBeUndefined()
})

test("the plugin's own tools record no did event", async ($, on) => {
  const w = world(on)
  await call($, 'todo_add', { text: 'a' })
  await call($, 'log_read')
  expect(w.events().map(e => e.t)).toEqual(['todo.add'])
})

test("a quiet commit's sha and subject are read from git in its folder; with no answer the commit is kept without them", async ($, on) => {
  const w = world(on)
  w.state.newest['/work/repo'] = '5d6e7f8\tquiet one\n'
  w.state.next = { result: '' }
  await other($, 'Bash', { command: 'git commit -q -m "quiet one"' })
  await other($, 'Bash', { command: 'cd /not/a/repo && git commit -q -m lost' })
  expect(w.events().map(({ at: _, ...e }) => e)).toEqual([
    { t: 'did', kind: 'commit', sha: '5d6e7f8', subject: 'quiet one' },
    { t: 'did', kind: 'commit', sha: '', subject: '' },
  ])
})

test('a Bash command that only mentions git commit, git push or gh pr create in a string or heredoc records nothing', async ($, on) => {
  const w = world(on)
  w.state.next = { result: '[main 1a2b3c4] x\nmain -> main\nhttps://github.com/o/r/pull/1' }
  await other($, 'Bash', { command: 'echo "git commit -m x; git push; gh pr create"' })
  await other($, 'Bash', { command: "cat <<'EOF'\ngit commit -m x\ngit push\ngh pr create\nEOF" })
  expect(w.files[paths.store]).toBeUndefined()
})

test("a write to the session's own log files records nothing", async ($, on) => {
  const w = world(on)
  await other($, 'Write', { file_path: paths.view, content: 'x' })
  await other($, 'Edit', { file_path: paths.store, old_string: 'a', new_string: 'b' })
  expect(w.files[paths.store]).toBeUndefined()
})

test('the recorder passes the real result through unchanged', async ($, on) => {
  const w = world(on)
  w.state.next = { result: 'wrote it' }
  expect((await other($, 'Write', { file_path: '/a.ts' })).result).toBe('wrote it')
})

test("the store's text never goes to a process: a text naming a settings file is recorded like any other", async ($, on) => {
  const w = world(on)
  expect((await call($, 'note', { text: 'the fix was one line in ~/.claude/settings.json' })).result).toBe('recorded n1')
  expect(w.events().map(e => e.t)).toEqual(['note'])
  expect(w.state.runs.filter(argv => argv.includes(paths.store))).toEqual([['mv', paths.incoming, paths.store]])
  expect(w.files[paths.incoming]).toBeUndefined()
})
