import { expect, test } from 'claude-code/testing'
import { programWords } from '../hooks/command'
import { commitFrom, didFacts, isRecorded, outputText } from '../hooks/recorder'

const R = { cwd: '/work/repo', ownDir: '/tmp/ss/session-logs' }
const bash = (command: string, output = '') => didFacts({ tool: 'Bash', input: { command }, output, isError: false }, R)

test('Write, Edit and NotebookEdit each record their file, a relative path resolved against the cwd', async () => {
  expect(didFacts({ tool: 'Write', input: { file_path: '/a/b.ts' }, output: '', isError: false }, R)).toEqual([{ kind: 'file', path: '/a/b.ts' }])
  expect(didFacts({ tool: 'Edit', input: { file_path: 'src/../x.ts' }, output: '', isError: false }, R)).toEqual([{ kind: 'file', path: '/work/repo/x.ts' }])
  expect(didFacts({ tool: 'NotebookEdit', input: { notebook_path: '/n.ipynb' }, output: '', isError: false }, R)).toEqual([{ kind: 'file', path: '/n.ipynb' }])
})

test('a commit records its sha and subject from the result', async () => {
  expect(bash('git commit -m "fix it"', '[main 1a2b3c4] fix it\n 1 file changed')).toEqual([{ kind: 'commit', sha: '1a2b3c4', subject: 'fix it' }])
  expect(bash('git commit -m x', '[feat/x (root-commit) abcdef0] first')).toEqual([{ kind: 'commit', sha: 'abcdef0', subject: 'first' }])
})

test('a quiet commit is one fact with an empty sha and the folder it was made in: the cwd, a cd before it, or its -C', async () => {
  expect(bash('git commit -q -m x', '')).toEqual([{ kind: 'commit', sha: '', subject: '', dir: '/work/repo' }])
  expect(bash('cd ../other && git add a.ts && git commit -q -m x && git log --oneline -1', '1a2b3c4 x')).toEqual([{ kind: 'commit', sha: '', subject: '', dir: '/work/other' }])
  expect(bash('git -C /else/where commit -q -m x', '')).toEqual([{ kind: 'commit', sha: '', subject: '', dir: '/else/where' }])
})

test("git's newest-commit line reads back as a sha and a subject; anything else as nothing", async () => {
  expect(commitFrom('1a2b3c4\tfix it: now\n')).toEqual({ sha: '1a2b3c4', subject: 'fix it: now' })
  expect(commitFrom('fatal: not a git repository')).toBeUndefined()
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
    expect(didFacts({ tool: 'Write', input: { file_path: p }, output: '', isError: false }, R)).toEqual([])
  }
  expect(didFacts({ tool: 'Write', input: { file_path: '/tmp/ss/session-logs-other/s.md' }, output: '', isError: false }, R)).toHaveLength(1)
})

test('a read-only tool is not a recorded tool and holds no fact', async () => {
  for (const t of ['Read', 'Grep', 'Glob', 'WebFetch']) {
    expect(isRecorded(t)).toBe(false)
    expect(didFacts({ tool: t, input: { file_path: '/a', command: 'git push' }, output: '', isError: false }, R)).toEqual([])
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

const failed = (command: string, output = '') => didFacts({ tool: 'Bash', input: { command }, output, isError: true }, R)

test('gh pr merge with --auto or --disable-auto records nothing, a plain merge records the PR', async () => {
  expect(bash('gh pr merge 12 --auto --squash', '')).toEqual([])
  expect(bash('gh pr merge 12 --disable-auto', '')).toEqual([])
  expect(bash('gh pr merge 12 --squash', '')).toEqual([{ kind: 'pr.merge', pr: '#12' }])
})

test('a Bash call sent to the background records nothing, whatever its command', async () => {
  const run = (command: string, output: string) => didFacts({ tool: 'Bash', input: { command, run_in_background: true }, output, isError: false }, R)
  expect(run('git commit -m x && git push', '[main 1a2b3c4] x\n   1a2b3c4..5d6e7f8  main -> main')).toEqual([])
  expect(run('gh pr create --fill', 'https://github.com/o/r/pull/3')).toEqual([])
})

test('a failed line still records the commits its output names, and no push', async () => {
  const out = '[main 1a2b3c4] x\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs'
  expect(failed('git commit -m x && git push', out)).toEqual([{ kind: 'commit', sha: '1a2b3c4', subject: 'x' }])
})

test('a failed line with a quiet commit records nothing, and neither does a failed Write', async () => {
  expect(failed('git commit -q -m x', '')).toEqual([])
  expect(failed('git commit -q -m x && gh pr create --fill', 'https://github.com/o/r/pull/1')).toEqual([])
  expect(didFacts({ tool: 'Write', input: { file_path: '/a.ts' }, output: '', isError: true }, R)).toEqual([])
})

// The body is a heredoc inside "$(...)": the odd " used to end the string early and turn the
// body's lines into commands.
test('a double-quoted $(cat <<EOF) body with an odd number of " that mentions git push and gh pr merge records nothing', async () => {
  const push = 'gh issue create --title t --body "$(cat <<\'EOF\'\nthe 12" screen fails\ngit push origin main is rejected\nEOF\n)"'
  const merge = 'gh pr comment 4 --body "$(cat <<\'EOF\'\nPlan: a 12" tweak.\ngh pr merge 4 --squash once green\nEOF\n)"'
  expect(bash(push, 'main -> main')).toEqual([])
  expect(bash(merge, 'Merged')).toEqual([])
})

test("a double-quoted $(cat <<EOF) body with an apostrophe (don't) that mentions git push and gh pr merge records nothing", async () => {
  const push = 'gh issue create --title t --body "$(cat <<\'EOF\'\nwe don\'t know why\ngit push origin main is rejected\nEOF\n)"'
  const merge = 'gh pr comment 4 --body "$(cat <<\'EOF\'\ndon\'t do it yet.\ngh pr merge 4 --squash once green\nEOF\n)"'
  expect(bash(push, 'main -> main')).toEqual([])
  expect(bash(merge, 'Merged')).toEqual([])
})

test('rehearsals and steps that make nothing record nothing', async () => {
  expect(bash('git push --dry-run origin feat/x', ' * [new branch]      feat/x -> feat/x')).toEqual([])
  expect(bash('git commit --dry-run -m x', '')).toEqual([])
  expect(bash('gh pr create --dry-run --fill', 'https://github.com/o/r/pull/1')).toEqual([])
  expect(bash('gh pr create --web', 'Opening github.com in your browser.')).toEqual([])
  expect(bash('git revert --no-commit HEAD', '')).toEqual([])
  expect(bash('git cherry-pick -n abc1234', '')).toEqual([])
  expect(bash('git cherry-pick --abort', '')).toEqual([])
  // the same command without the flag does count
  expect(bash('git revert HEAD', '[main 1a2b3c4] Revert x')).toEqual([{ kind: 'commit', sha: '1a2b3c4', subject: 'Revert x' }])
})

test('timeout, nice and a leading gh -R do not hide the command behind them', async () => {
  expect(programWords(['timeout', '120', 'git', 'push', 'origin', 'feat/x'])).toEqual(['git', 'push', 'origin', 'feat/x'])
  expect(programWords(['nice', '-n', '5', 'git', 'push'])).toEqual(['git', 'push'])
  const out = '   1a2b3c4..5d6e7f8  feat/x -> feat/x'
  expect(bash('timeout 120 git push origin feat/x', out)).toEqual([{ kind: 'push', ref: 'feat/x' }])
  expect(bash('nice -n 5 git push', out)).toEqual([{ kind: 'push', ref: 'feat/x' }])
  expect(bash('gh -R o/r pr create --fill', 'https://github.com/o/r/pull/7')).toEqual([{ kind: 'pr.create', pr: 'https://github.com/o/r/pull/7' }])
})
