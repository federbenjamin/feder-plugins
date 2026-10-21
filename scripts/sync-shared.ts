// Writes the generated copies (a plugin cannot import across its folder, and a symlink is refused
// by the loader): shared/ into each plugin, the judge into tools/eval, and the eval's sample
// fixtures from their one source.
//   node scripts/sync-shared.ts           write every target
//   node scripts/sync-shared.ts --check   write nothing; exit 1 on a drifted, missing or stale
//                                         target, a missing source or plugin, or a sibling text
//                                         that left its plugin
// Every job and check is mandatory: a source or plugin that is gone fails both modes.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { directiveText } from '../plugins/session-log/hooks/log.ts'
import { SIBLING_TEXTS } from '../shared/typed.ts'
import { GRADES, RECORDS } from '../tools/eval/fixtures/samples.ts'

const ROOT = join(import.meta.dirname, '..')
const PARTS = ['dialog-timeout', 'cache-keepalive', 'stop-judge', 'session-log'] as const

export type Job = {
  name: string
  from: string // a folder under the repo root
  to: string // a folder under the repo root
  plugin: string // the target's plugin folder; the job never creates it
  files?: readonly string[] // the files it copies, each required; default every .ts under `from`
  owns?: boolean // `to` holds only generated files: any other file in it is stale
}

export const JOBS: readonly Job[] = [
  ...PARTS.map(p => ({ name: `shared -> ${p}`, from: 'shared', to: `plugins/${p}/hooks/shared`, plugin: `plugins/${p}`, owns: true })),
  { name: 'judge -> eval', from: 'plugins/stop-judge/hooks', to: 'tools/eval/hooks/judge', plugin: 'tools/eval', files: ['judge.ts', 'prompt.ts'], owns: true },
  { name: 'judge shared -> eval', from: 'plugins/stop-judge/hooks/shared', to: 'tools/eval/hooks/judge/shared', plugin: 'tools/eval' },
]

// Files written from a module's text, not copied: the eval's fixtures, whose source the tests import.
export function generated(): { path: string; text: string; source: string }[] {
  const source = 'tools/eval/fixtures/samples.ts'
  return [
    { path: 'tools/eval/fixtures/records.sample.jsonl', text: RECORDS, source },
    { path: 'tools/eval/fixtures/grades.sample.jsonl', text: GRADES, source },
  ]
}

// Texts that must stay verbatim in a file that cannot import their source: the sibling texts in
// the plugin that sends them (shared/typed.ts reads them back), and the session-log directive in
// the shell hook that prints it.
export function literalChecks(): { literal: string; file: string }[] {
  return [
    { literal: SIBLING_TEXTS.keepalivePing, file: 'plugins/cache-keepalive/hooks/register.ts' },
    { literal: SIBLING_TEXTS.keepaliveLast, file: 'plugins/cache-keepalive/hooks/register.ts' },
    { literal: SIBLING_TEXTS.afk, file: 'plugins/dialog-timeout/hooks/register.ts' },
    { literal: directiveText('${LOG}', '${TPL}'), file: 'plugins/session-log/scripts/directive.sh' },
  ]
}

function filesUnder(dir: string, base = ''): string[] {
  const abs = join(dir, base)
  if (!existsSync(abs)) return []
  return readdirSync(abs).flatMap(name => {
    const rel = base === '' ? name : `${base}/${name}`
    return statSync(join(dir, rel)).isDirectory() ? filesUnder(dir, rel) : [rel]
  })
}

// Every target the jobs produce, in order, and what keeps a job from running. A later job reads
// an earlier job's output rather than the disk, so a drifted copy is reported once, at its own target.
export function expectedTargets(root: string = ROOT): { targets: Map<string, string>; owned: Set<string>; missing: string[] } {
  const targets = new Map<string, string>()
  const owned = new Set<string>()
  const missing: string[] = []
  for (const job of JOBS) {
    if (!existsSync(join(root, job.plugin))) {
      missing.push(`missing plugin ${job.plugin} (${job.name})`)
      continue
    }
    const sources = new Map<string, string>()
    for (const rel of filesUnder(join(root, job.from))) sources.set(rel, readFileSync(join(root, job.from, rel), 'utf8'))
    for (const [path, text] of targets) if (path.startsWith(`${job.from}/`)) sources.set(path.slice(job.from.length + 1), text)
    const wanted = job.files ?? [...sources.keys()].filter(rel => rel.endsWith('.ts'))
    const absent = job.files === undefined && wanted.length === 0 ? [job.from] : wanted.filter(rel => !sources.has(rel)).map(rel => `${job.from}/${rel}`)
    if (absent.length > 0) {
      missing.push(...absent.map(path => `missing source ${path} (${job.name})`))
      continue
    }
    if (job.owns) owned.add(job.to)
    for (const rel of wanted) targets.set(`${job.to}/${rel}`, sources.get(rel)!)
  }
  for (const g of generated()) targets.set(g.path, g.text)
  return { targets, owned, missing }
}

function stale(root: string, targets: Map<string, string>, owned: Set<string>): string[] {
  return [...owned].flatMap(dir => filesUnder(join(root, dir)).map(rel => `${dir}/${rel}`)).filter(path => !targets.has(path))
}

function failedLiterals(root: string): string[] {
  return literalChecks().flatMap(c => {
    const abs = join(root, c.file)
    if (!existsSync(abs)) return [`missing ${c.file} (literal check)`]
    return readFileSync(abs, 'utf8').includes(c.literal) ? [] : [`literal "${c.literal}" is not in ${c.file}`]
  })
}

// Everything --check reports. `blocked`: what writing cannot fix (a missing source or plugin, a
// sibling text gone from its file); `drift`: the targets a write brings back in line.
export function syncProblems(root: string = ROOT): { blocked: string[]; drift: string[]; writes: Map<string, string>; removals: string[] } {
  const { targets, owned, missing } = expectedTargets(root)
  const drift: string[] = []
  const writes = new Map<string, string>()
  for (const [path, text] of targets) {
    const abs = join(root, path)
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined
    if (current === text) continue
    drift.push(`${current === undefined ? 'missing' : 'drifted'} ${path}`)
    writes.set(path, text)
  }
  const removals = stale(root, targets, owned)
  drift.push(...removals.map(path => `stale ${path}`))
  return { blocked: [...missing, ...failedLiterals(root)], drift, writes, removals }
}

function run(check: boolean, root: string = ROOT): number {
  const { blocked, drift, writes, removals } = syncProblems(root)
  for (const line of blocked) console.log(line)
  if (check) {
    for (const line of drift) console.log(line)
    return blocked.length > 0 || drift.length > 0 ? 1 : 0
  }
  for (const [path, text] of writes) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  for (const path of removals) rmSync(join(root, path))
  console.log(`synced, ${drift.length} changed`)
  return blocked.length > 0 ? 1 : 0
}

if (import.meta.main) process.exit(run(process.argv.includes('--check')))
