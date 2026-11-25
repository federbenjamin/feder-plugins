import { expect, test } from 'claude-code/testing'
import { didFacts, isRecorded, outputText } from '../hooks/recorder'

const R = { cwd: '/work/repo', ownDir: '/tmp/ss/session-logs' }
const bash = (command: string, output = '') => didFacts({ tool: 'Bash', input: { command }, output }, R)

test('Write, Edit and NotebookEdit each record their file, a relative path resolved against the cwd', async () => {
  expect(didFacts({ tool: 'Write', input: { file_path: '/a/b.ts' }, output: '' }, R)).toEqual([{ kind: 'file', path: '/a/b.ts' }])
  expect(didFacts({ tool: 'Edit', input: { file_path: 'src/../x.ts' }, output: '' }, R)).toEqual([{ kind: 'file', path: '/work/repo/x.ts' }])
  expect(didFacts({ tool: 'NotebookEdit', input: { notebook_path: '/n.ipynb' }, output: '' }, R)).toEqual([{ kind: 'file', path: '/n.ipynb' }])
})

test('a commit records its sha and subject from the result', async () => {
  expect(bash('git commit -m "fix it"', '[main 1a2b3c4] fix it\n 1 file changed')).toEqual([{ kind: 'commit', sha: '1a2b3c4', subject: 'fix it' }])
  expect(bash('git commit -m x', '[feat/x (root-commit) abcdef0] first')).toEqual([{ kind: 'commit', sha: 'abcdef0', subject: 'first' }])
})

test('a commit whose output names no sha is still one fact, with an empty sha', async () => {
  expect(bash('git commit -m x', '')).toEqual([{ kind: 'commit', sha: '', subject: '' }])
})

test('git push records the pushed ref, and nothing when everything was up to date', async () => {
  const out = 'To github.com:o/r.git\n   1a2b3c4..5d6e7f8  feat/x -> feat/x\n'
  expect(bash('git push origin feat/x', out)).toEqual([{ kind: 'push', ref: 'feat/x' }])
  expect(bash('git push', 'Everything up-to-date')).toEqual([])
})

test('gh pr create records the PR url and gh pr merge the PR number', async () => {
  expect(bash('gh pr create --fill', 'https://github.com/o/r/pull/12\n')).toEqual([{ kind: 'pr.create', pr: 'https://github.com/o/r/pull/12' }])
  expect(bash('gh pr merge 12 --squash', '')).toEqual([{ kind: 'pr.merge', pr: '#12' }])
})

test('the commit and the push of one chained line are two facts', async () => {
  const out = '[main 1a2b3c4] msg\n   1a2b3c4..5d6e7f8  main -> main\n'
  expect(bash('git commit -m msg && git push', out).map(f => f.kind)).toEqual(['commit', 'push'])
})

test('a Bash command that only mentions git commit inside a quoted string records nothing', async () => {
  expect(bash('echo "now run git commit -m x"', '[main 1a2b3c4] x')).toEqual([])
})

test('a Bash command that only mentions git push or gh pr create inside a quoted string records nothing', async () => {
  expect(bash("echo 'git push origin main'", 'main -> main')).toEqual([])
  expect(bash('echo "gh pr create"', 'https://github.com/o/r/pull/1')).toEqual([])
})

test('a Bash heredoc that mentions git commit, git push and gh pr create records nothing', async () => {
  const cmd = "cat > plan.md <<'EOF'\ngit commit -m x\ngit push\ngh pr create\nEOF"
  expect(bash(cmd, '[main 1a2b3c4] x\nmain -> main\nhttps://github.com/o/r/pull/1')).toEqual([])
})

test('a write to the session\'s own log files records nothing, a write beside them does', async () => {
  for (const p of ['/tmp/ss/session-logs/s.md', '/tmp/ss/session-logs/s.jsonl']) {
    expect(didFacts({ tool: 'Write', input: { file_path: p }, output: '' }, R)).toEqual([])
  }
  expect(didFacts({ tool: 'Write', input: { file_path: '/tmp/ss/session-logs-other/s.md' }, output: '' }, R)).toHaveLength(1)
})

test('a read-only tool is not a recorded tool and holds no fact', async () => {
  for (const t of ['Read', 'Grep', 'Glob', 'WebFetch']) {
    expect(isRecorded(t)).toBe(false)
    expect(didFacts({ tool: t, input: { file_path: '/a', command: 'git push' }, output: '' }, R)).toEqual([])
  }
  for (const t of ['Write', 'Edit', 'NotebookEdit', 'Bash']) expect(isRecorded(t)).toBe(true)
})

test('outputText prefers text, then a string result, then a shell result\'s two streams', async () => {
  expect(outputText({ text: 'a', result: 'b' })).toBe('a')
  expect(outputText({ result: 'b' })).toBe('b')
  expect(outputText({ result: { stdout: 'out', stderr: 'err' } })).toBe('out\nerr')
  expect(outputText({ result: { stdout: 'out' } })).toBe('out')
  expect(outputText({ result: 5 })).toBe('')
  expect(outputText({})).toBe('')
})
