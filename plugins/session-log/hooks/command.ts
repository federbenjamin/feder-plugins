// A shell line as the simple commands it runs, each as its words. Text inside quotes, a heredoc's
// body and a comment never become program words, so a command that only mentions `git push` in a
// message is not one that pushes.

const SEPARATORS = new Set(['\n', ';', '&', '|', '(', ')'])
// Words that stand before a program without being one.
const PREFIXES = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'env', 'command', 'exec', 'sudo', 'nohup', 'caffeinate'])
// Wrappers that take options and one leading value (a duration, a priority) before the program.
const VALUE_PREFIXES = new Set(['timeout', 'gtimeout', 'nice'])
const ASSIGNMENT = /^[A-Za-z_]\w*=/
const HEREDOC = /^<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|()<>]+))/

// The index just past the line that closes a heredoc whose body starts at `from`.
function heredocEnd(s: string, from: number, delimiter: string): number {
  let i = from
  for (;;) {
    const end = s.indexOf('\n', i)
    const line = s.slice(i, end === -1 ? s.length : end)
    i = end === -1 ? s.length : end + 1
    if (line.trim() === delimiter || end === -1) return i
  }
}

// The index just past the `"` that closes a string opened before `from`. A `$(` inside it opens a
// command of its own, whose quotes are not this string's.
function stringEnd(s: string, from: number): number {
  let i = from
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\') i += 2
    else if (s[i] === '$' && s[i + 1] === '(') i = substitutionEnd(s, i + 2)
    else i++
  }
  return i + 1
}

// The index just past the `)` that closes a `$(` opened before `from`, past the quotes and heredoc
// bodies inside it.
function substitutionEnd(s: string, from: number): number {
  let depth = 1
  let i = from
  const heredocs: string[] = []
  while (i < s.length && depth > 0) {
    const c = s[i]!
    if (c === '\\') i += 2
    else if (c === "'") {
      const end = s.indexOf("'", i + 1)
      i = end === -1 ? s.length : end + 1
    } else if (c === '"') i = stringEnd(s, i + 1)
    else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = HEREDOC.exec(s.slice(i))
      if (m) heredocs.push(m[1] ?? m[2] ?? m[3]!)
      i += m ? m[0].length : 2
    } else if (c === '\n') {
      i++
      for (const delimiter of heredocs.splice(0)) i = heredocEnd(s, i, delimiter)
    } else {
      if (c === '(') depth++
      else if (c === ')') depth--
      i++
    }
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
      const end = stringEnd(s, i + 1)
      word = (word ?? '') + s.slice(i + 1, end - 1)
      i = end
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
      const m = HEREDOC.exec(s.slice(i))
      if (m) heredocs.push(m[1] ?? m[2] ?? m[3]!)
      i += m ? m[0].length : 2
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
      // Each heredoc opened on the line just ended: its body runs to its delimiter's own line.
      if (c === '\n') for (const delimiter of heredocs.splice(0)) i = heredocEnd(s, i, delimiter)
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
  for (;;) {
    const w = words[at]
    if (w === undefined) break
    if (ASSIGNMENT.test(w) || PREFIXES.has(w)) at++
    else if (VALUE_PREFIXES.has(w)) {
      at++
      while (words[at]?.startsWith('-')) at++
      if (/^\d/.test(words[at] ?? '')) at++
    } else break
  }
  return words.slice(at)
}
