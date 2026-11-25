// A shell line as the simple commands it runs, each as its words. Text inside quotes, a heredoc's
// body and a comment never become program words, so a command that only mentions `git push` in a
// message is not one that pushes.

const SEPARATORS = new Set(['\n', ';', '&', '|', '(', ')'])
// Words that stand before a program without being one.
const PREFIXES = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'env', 'command', 'exec', 'sudo', 'nohup'])
const ASSIGNMENT = /^[A-Za-z_]\w*=/

// The index just past the `)` that closes a `$(` opened before `from`.
function substitutionEnd(s: string, from: number): number {
  let depth = 1
  let i = from
  while (i < s.length && depth > 0) {
    const c = s[i]!
    if (c === '\\') i++
    else if (c === "'") {
      const end = s.indexOf("'", i + 1)
      i = end === -1 ? s.length : end
    } else if (c === '(') depth++
    else if (c === ')') depth--
    i++
  }
  return i
}

export function simpleCommands(command: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word: string | null = null
  const heredocs: string[] = []
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  const s = command
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\') {
      if (s[i + 1] !== '\n') word = (word ?? '') + (s[i + 1] ?? '')
      i += 2
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1)
      const stop = end === -1 ? s.length : end
      word = (word ?? '') + s.slice(i + 1, stop)
      i = stop + 1
    } else if (c === '"') {
      let j = i + 1
      let inner = ''
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) j++
        inner += s[j]
        j++
      }
      word = (word ?? '') + inner
      i = j + 1
    } else if (c === '$' && s[i + 1] === '(') {
      const end = substitutionEnd(s, i + 2)
      word = (word ?? '') + s.slice(i, end)
      i = end
    } else if (c === '`') {
      const end = s.indexOf('`', i + 1)
      const stop = end === -1 ? s.length : end
      word = (word ?? '') + s.slice(i, stop + 1)
      i = stop + 1
    } else if (c === '#' && word === null) {
      const end = s.indexOf('\n', i)
      i = end === -1 ? s.length : end
    } else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      endWord()
      const m = /^<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|()<>]+))/.exec(s.slice(i))
      if (m) {
        heredocs.push(m[1] ?? m[2] ?? m[3]!)
        i += m[0].length
      } else {
        i += 2
      }
    } else if (c === '<' || c === '>') {
      endWord()
      i++
      while (s[i] === '<' || s[i] === '>' || s[i] === '&') i++
    } else if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else if (SEPARATORS.has(c)) {
      endCommand()
      i++
      if (c === '\n') {
        // Each heredoc opened on the line just ended: its body runs to its delimiter's own line.
        for (const delimiter of heredocs.splice(0)) {
          for (;;) {
            const end = s.indexOf('\n', i)
            const line = s.slice(i, end === -1 ? s.length : end)
            i = end === -1 ? s.length : end + 1
            if (line.trim() === delimiter || end === -1) break
          }
        }
      }
    } else {
      word = (word ?? '') + c
      i++
    }
  }
  endCommand()
  return commands
}

// A simple command from its program on: assignments and the words that only introduce it dropped.
export function programWords(words: readonly string[]): string[] {
  let at = 0
  while (at < words.length && (ASSIGNMENT.test(words[at]!) || PREFIXES.has(words[at]!))) at++
  return words.slice(at)
}
