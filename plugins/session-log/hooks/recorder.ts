import { programWords, simpleCommands } from './command'
import { absolutePath, touchedBy } from './shared/text'
import { isRecord } from './shared/typed'
import type { DidFact } from './store'

// What a finished tool call did that the log records: a file written, a commit, a push, a pull
// request opened or merged. Pure; register.ts hands it the main session's calls.

const WRITERS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])
const COMMITTERS: ReadonlySet<string> = new Set(['commit', 'revert', 'cherry-pick'])
// git's own options that take a value as the next word.
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
// gh's own options that may stand before `pr`, each taking a value.
const GH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-R', '--repo'])
// Flags with which a command does not do what its name says: a rehearsal, a step with no commit,
// the end of a sequence, a page opened in a browser, auto-merge switched on or off for later.
const NO_FACT: Readonly<Record<string, ReadonlySet<string>>> = {
  commit: new Set(['--dry-run']),
  revert: new Set(['--no-commit', '-n', '--abort', '--quit', '--skip']),
  'cherry-pick': new Set(['--no-commit', '-n', '--abort', '--quit', '--skip']),
  push: new Set(['--dry-run', '-n']),
  'pr create': new Set(['--dry-run', '--web', '-w']),
  'pr merge': new Set(['--auto', '--disable-auto']),
}

// `[main 1a2b3c4] subject`, `[main (root-commit) 1a2b3c4] subject`, `[detached HEAD 1a2b3c4] subject`
const COMMIT_LINE = /^\[[^\]\n]*?\b([0-9a-f]{7,40})\] (.*)$/gm
const PUSHED_REF = /^\s*(?:[*+=! -]\s+)?(?:\[[^\]]+\]|[0-9a-f]+\.{2,3}[0-9a-f]+)\s+(\S+) -> (\S+)/m
const PR_URL = /https:\/\/\S+\/pull\/\d+/
const PR_NUMBER = /#(\d+)\b/

// The tools whose calls can hold a fact; every other call is passed by without a look.
export const isRecorded = (tool: string): boolean => WRITERS.has(tool) || tool === 'Bash'

const isProgram = (word: string | undefined, name: string): boolean => word === name || word?.endsWith(`/${name}`) === true

const does = (action: string, words: readonly string[]): boolean => !words.some(w => NO_FACT[action]?.has(w))

// A git command's subcommand, and the folder its `-C` names.
function gitCall(words: readonly string[]): { sub: string; dir?: string } | undefined {
  if (!isProgram(words[0], 'git')) return undefined
  let dir: string | undefined
  let at = 1
  while (at < words.length) {
    const w = words[at]!
    if (GIT_VALUE_OPTIONS.has(w)) {
      if (w === '-C') dir = words[at + 1]
      at += 2
    } else if (w.startsWith('-')) at++
    else return { sub: w, ...(dir === undefined ? {} : { dir }) }
  }
  return undefined
}

function ghPr(words: readonly string[]): { verb: string; rest: readonly string[] } | undefined {
  if (!isProgram(words[0], 'gh')) return undefined
  let at = 1
  while (GH_VALUE_OPTIONS.has(words[at] ?? '')) at += 2
  if (words[at] !== 'pr' || words[at + 1] === undefined) return undefined
  return { verb: words[at + 1]!, rest: words.slice(at + 2) }
}

// A fact as found. A commit whose output named no sha has `dir`, the folder it was made in, for
// the caller to read the sha and subject from git; `dir` is never stored.
export type FoundFact = DidFact & { dir?: string }

// What a shell line did. A line that failed still made the commits its output names, since one
// part can fail after another committed; nothing else is taken from a failed line.
function commandFacts(command: string, output: string, r: { cwd: string; isError: boolean }): FoundFact[] {
  const facts: FoundFact[] = []
  let isCommitRead = false
  let dir = r.cwd
  for (const words of simpleCommands(command).map(programWords)) {
    if (words[0] === 'cd' && words[1] !== undefined) dir = absolutePath(words[1], dir)
    const call = gitCall(words)
    const git = call?.sub
    if (git !== undefined && COMMITTERS.has(git) && does(git, words) && !isCommitRead) {
      // One read of the output for every committing command in the line: it names each commit once.
      // A quiet commit prints none; its fact carries the folder to ask git in.
      isCommitRead = true
      const commits = [...output.matchAll(COMMIT_LINE)].map(m => ({ kind: 'commit' as const, sha: m[1]!, subject: m[2]! }))
      if (commits.length > 0) facts.push(...commits)
      else if (!r.isError) facts.push({ kind: 'commit', sha: '', subject: '', dir: call?.dir === undefined ? dir : absolutePath(call.dir, dir) })
    }
    if (r.isError) continue
    if (git === 'push' && does('push', words) && !output.includes('Everything up-to-date')) {
      const ref = PUSHED_REF.exec(output)
      facts.push({ kind: 'push', ref: ref ? ref[2]! : '' })
    }
    const pr = ghPr(words)
    if (pr?.verb === 'create' && does('pr create', pr.rest)) {
      facts.push({ kind: 'pr.create', pr: PR_URL.exec(output)?.[0] ?? '' })
    } else if (pr?.verb === 'merge' && does('pr merge', pr.rest)) {
      const named = pr.rest.find(w => /^\d+$/.test(w) || PR_URL.test(w))
      const number = PR_NUMBER.exec(output)?.[1] ?? (named !== undefined && /^\d+$/.test(named) ? named : undefined)
      facts.push({ kind: 'pr.merge', pr: PR_URL.exec(output)?.[0] ?? (number !== undefined ? `#${number}` : (named ?? '')) })
    }
  }
  return facts
}

// `git log` arguments that print a folder's newest commit as `<sha>\t<subject>`, and their reader.
export const NEWEST_COMMIT = ['log', '-1', '--format=%h%x09%s'] as const

export function commitFrom(stdout: string): { sha: string; subject: string } | undefined {
  const m = /^([0-9a-f]{7,40})\t(.*)$/m.exec(stdout)
  return m ? { sha: m[1]!, subject: m[2]! } : undefined
}

// `ownDir` is the folder of the session's own log files, whose writes are no fact. A shell line
// sent to the background has not run yet when its call returns, so it holds no fact.
export function didFacts(call: { tool: string; input: unknown; output: string; isError: boolean }, r: { cwd: string; ownDir: string }): FoundFact[] {
  if (WRITERS.has(call.tool)) {
    if (call.isError) return []
    return touchedBy(call.tool, call.input)
      .map(p => absolutePath(p, r.cwd))
      .filter(p => !p.startsWith(`${r.ownDir}/`))
      .map(path => ({ kind: 'file', path }))
  }
  if (call.tool !== 'Bash' || !isRecord(call.input) || typeof call.input.command !== 'string' || call.input.run_in_background === true) return []
  return commandFacts(call.input.command, call.output, { cwd: r.cwd, isError: call.isError })
}

// A tool result as text: what the model read, else a shell result's two streams.
export function outputText(r: { text?: unknown; result?: unknown }): string {
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return r.result
  if (!isRecord(r.result)) return ''
  return [r.result.stdout, r.result.stderr].filter((s): s is string => typeof s === 'string').join('\n')
}
