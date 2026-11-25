import { programWords, simpleCommands } from './command'
import { absolutePath, touchedBy } from './shared/text'
import { isRecord } from './shared/typed'
import type { DidFact } from './store'

// What a finished tool call did that the log records: a file written, a commit, a push, a pull
// request opened or merged. Pure; register.ts hands it only successful calls of the main session.

const WRITERS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])
const COMMITTERS: ReadonlySet<string> = new Set(['commit', 'revert', 'cherry-pick'])
// git's own options that take a value as the next word.
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

// `[main 1a2b3c4] subject`, `[main (root-commit) 1a2b3c4] subject`, `[detached HEAD 1a2b3c4] subject`
const COMMIT_LINE = /^\[[^\]\n]*?\b([0-9a-f]{7,40})\] (.*)$/gm
const PUSHED_REF = /^\s*(?:[*+=! -]\s+)?(?:\[[^\]]+\]|[0-9a-f]+\.{2,3}[0-9a-f]+)\s+(\S+) -> (\S+)/m
const PR_URL = /https:\/\/\S+\/pull\/\d+/
const PR_NUMBER = /#(\d+)\b/

// The tools whose calls can hold a fact; every other call is passed by without a look.
export const isRecorded = (tool: string): boolean => WRITERS.has(tool) || tool === 'Bash'

const isProgram =(word: string | undefined, name: string): boolean => word === name || word?.endsWith(`/${name}`) === true

function gitSubcommand(words: readonly string[]): string | undefined {
  if (!isProgram(words[0], 'git')) return undefined
  let at = 1
  while (at < words.length) {
    const w = words[at]!
    if (GIT_VALUE_OPTIONS.has(w)) at += 2
    else if (w.startsWith('-')) at++
    else return w
  }
  return undefined
}

function ghPr(words: readonly string[]): { verb: string; rest: readonly string[] } | undefined {
  if (!isProgram(words[0], 'gh') || words[1] !== 'pr' || words[2] === undefined) return undefined
  return { verb: words[2], rest: words.slice(3) }
}

function commandFacts(command: string, output: string): DidFact[] {
  const facts: DidFact[] = []
  let isCommitRead = false
  for (const words of simpleCommands(command).map(programWords)) {
    const git = gitSubcommand(words)
    if (git !== undefined && COMMITTERS.has(git) && !isCommitRead) {
      // One read of the output for every committing command in the line: it names each commit once.
      isCommitRead = true
      const commits = [...output.matchAll(COMMIT_LINE)].map(m => ({ kind: 'commit' as const, sha: m[1]!, subject: m[2]! }))
      facts.push(...(commits.length > 0 ? commits : [{ kind: 'commit' as const, sha: '', subject: '' }]))
    } else if (git === 'push' && !output.includes('Everything up-to-date')) {
      const ref = PUSHED_REF.exec(output)
      facts.push({ kind: 'push', ref: ref ? ref[2]! : '' })
    }
    const pr = ghPr(words)
    if (pr?.verb === 'create') {
      facts.push({ kind: 'pr.create', pr: PR_URL.exec(output)?.[0] ?? '' })
    } else if (pr?.verb === 'merge') {
      const named = pr.rest.find(w => /^\d+$/.test(w) || PR_URL.test(w))
      const number = PR_NUMBER.exec(output)?.[1] ?? (named !== undefined && /^\d+$/.test(named) ? named : undefined)
      facts.push({ kind: 'pr.merge', pr: PR_URL.exec(output)?.[0] ?? (number !== undefined ? `#${number}` : (named ?? '')) })
    }
  }
  return facts
}

// `ownDir` is the folder of the session's own log files, whose writes are no fact.
export function didFacts(call: { tool: string; input: unknown; output: string }, r: { cwd: string; ownDir: string }): DidFact[] {
  if (WRITERS.has(call.tool)) {
    return touchedBy(call.tool, call.input)
      .map(p => absolutePath(p, r.cwd))
      .filter(p => !p.startsWith(`${r.ownDir}/`))
      .map(path => ({ kind: 'file', path }))
  }
  if (call.tool === 'Bash' && isRecord(call.input) && typeof call.input.command === 'string') return commandFacts(call.input.command, call.output)
  return []
}

// A tool result as text: what the model read, else a shell result's two streams.
export function outputText(r: { text?: unknown; result?: unknown }): string {
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return r.result
  if (!isRecord(r.result)) return ''
  return [r.result.stdout, r.result.stderr].filter((s): s is string => typeof s === 'string').join('\n')
}
