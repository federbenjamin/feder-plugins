import { expect, test } from 'claude-code/testing'
import { programWords, simpleCommands } from '../hooks/command'

test('a command line splits at ;, &&, || and | into simple commands', async () => {
  expect(simpleCommands('git add . && git commit -m x; echo hi | cat')).toEqual([['git', 'add', '.'], ['git', 'commit', '-m', 'x'], ['echo', 'hi'], ['cat']])
})

test('text inside quotes stays one word, so a message that mentions git push is no push', async () => {
  expect(simpleCommands('echo "run git push now"')).toEqual([['echo', 'run git push now']])
  expect(simpleCommands("echo 'gh pr create'")).toEqual([['echo', 'gh pr create']])
})

test('a heredoc body never becomes program words, but the command after it does', async () => {
  const cmd = "cat <<'EOF' > notes.md\ngit commit -m hi\ngh pr create\nEOF\ngit push"
  expect(simpleCommands(cmd)).toEqual([['cat', 'notes.md'], ['git', 'push']])
})

test('a comment is dropped, a # inside a word is not', async () => {
  expect(simpleCommands('ls # git push')).toEqual([['ls']])
  expect(simpleCommands('echo a#b')).toEqual([['echo', 'a#b']])
})

test('a command substitution stays inside its word', async () => {
  expect(simpleCommands('echo $(git push)')).toEqual([['echo', '$(git push)']])
})

test('programWords drops leading assignments and introducing words', async () => {
  expect(programWords(['FOO=1', 'sudo', 'git', 'push'])).toEqual(['git', 'push'])
  expect(programWords(['if', 'git', 'push'])).toEqual(['git', 'push'])
  expect(programWords(['git', 'push'])).toEqual(['git', 'push'])
  expect(programWords(['A=1'])).toEqual([])
})
