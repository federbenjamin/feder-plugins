// Writes the generated copies (a plugin cannot import across its folder, and a symlink is refused
// by the loader): shared/ into each plugin, the judge into tools/eval.
//   node scripts/sync-shared.ts           write every target
//   node scripts/sync-shared.ts --check   write nothing; exit 1 on a drifted, missing or stale
//                                         target, or a sibling text that left its plugin
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SIBLING_TEXTS } from '../shared/typed.ts'

const ROOT = join(import.meta.dirname, '..')
const PARTS = ['dialog-timeout', 'cache-keepalive', 'stop-judge', 'session-log'] as const

export type Job = {
  name: string
  from: string // a folder under the repo root
  to: string // a folder under the repo root
  needs?: string // a path that must exist besides `from`: the target's own plugin, so a part's build never writes another part's folder
  include?: (rel: string) => boolean
  owns?: boolean // `to` holds only generated files: any other file in it is stale
}

const isTs = (rel: string) => rel.endsWith('.ts')

export const JOBS: readonly Job[] = [
  ...PARTS.map(p => ({ name: `shared -> ${p}`, from: 'shared', to: `plugins/${p}/hooks/shared`, needs: `plugins/${p}`, include: isTs, owns: true })),
  { name: 'judge -> eval', from: 'plugins/stop-judge/hooks', to: 'tools/eval/hooks/judge', needs: 'tools/eval/hooks', include: rel => rel === 'judge.ts' || rel === 'prompt.ts', owns: true },
  { name: 'judge shared -> eval', from: 'plugins/stop-judge/hooks/shared', to: 'tools/eval/hooks/judge/shared', needs: 'tools/eval/hooks', include: isTs },
]

// Sibling texts that must stay verbatim in the plugin that sends them (shared/typed.ts reads
// them back); the judge's nudge is checked once judge.ts exists.
export function literalChecks(): { literal: string; file: string }[] {
  const checks = [
    { literal: SIBLING_TEXTS.keepalivePing, file: 'plugins/cache-keepalive/hooks/register.ts' },
    { literal: SIBLING_TEXTS.keepaliveLast, file: 'plugins/cache-keepalive/hooks/register.ts' },
    { literal: SIBLING_TEXTS.afk, file: 'plugins/dialog-timeout/hooks/register.ts' },
    { literal: SIBLING_TEXTS.nudge, file: 'plugins/stop-judge/hooks/judge.ts' },
  ]
  return checks.filter(c => c.file !== 'plugins/stop-judge/hooks/judge.ts' || existsSync(join(ROOT, c.file)))
}

function filesUnder(dir: string, base = ''): string[] {
  const abs = join(dir, base)
  if (!existsSync(abs)) return []
  return readdirSync(abs).flatMap(name => {
    const rel = base === '' ? name : `${base}/${name}`
    return statSync(join(dir, rel)).isDirectory() ? filesUnder(dir, rel) : [rel]
  })
}

// Every target the jobs produce, in order. A later job reads an earlier job's output rather than
// the disk, so a drifted copy is reported once, at its own target.
export function expectedTargets(): { targets: Map<string, string>; skipped: string[]; owned: Set<string> } {
  const targets = new Map<string, string>()
  const skipped: string[] = []
  const owned = new Set<string>()
  for (const job of JOBS) {
    const from = join(ROOT, job.from)
    const isThere = (path: string) => existsSync(join(ROOT, path)) || [...targets.keys()].some(t => t.startsWith(`${path}/`))
    const missing = [job.from, job.needs].find(path => path !== undefined && !isThere(path))
    if (missing !== undefined) {
      skipped.push(`${job.name}: ${missing} not there yet`)
      continue
    }
    if (job.owns) owned.add(job.to)
    const sources = new Map<string, string>()
    for (const rel of filesUnder(from)) sources.set(`${job.from}/${rel}`, readFileSync(join(from, rel), 'utf8'))
    for (const [path, text] of targets) if (path.startsWith(`${job.from}/`)) sources.set(path, text)
    for (const [path, text] of sources) {
      const rel = path.slice(job.from.length + 1)
      if (job.include && !job.include(rel)) continue
      targets.set(`${job.to}/${rel}`, text)
    }
  }
  return { targets, skipped, owned }
}

function stale(targets: Map<string, string>, owned: Set<string>): string[] {
  return [...owned].flatMap(dir => filesUnder(join(ROOT, dir)).map(rel => `${dir}/${rel}`)).filter(path => !targets.has(path))
}

function run(check: boolean): number {
  const { targets, skipped, owned } = expectedTargets()
  for (const line of skipped) console.log(`skip ${line}`)
  const problems: string[] = []
  for (const [path, text] of targets) {
    const abs = join(ROOT, path)
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined
    if (current === text) continue
    problems.push(`${current === undefined ? 'missing' : 'drifted'} ${path}`)
    if (!check) {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
    }
  }
  for (const path of stale(targets, owned)) {
    problems.push(`stale ${path}`)
    if (!check) rmSync(join(ROOT, path))
  }
  const failed = literalChecks().filter(c => !readFileSync(join(ROOT, c.file), 'utf8').includes(c.literal))
  for (const c of failed) console.log(`literal "${c.literal}" is not in ${c.file}`)
  if (check) {
    for (const p of problems) console.log(p)
    return problems.length > 0 || failed.length > 0 ? 1 : 0
  }
  console.log(`synced ${targets.size} files, ${problems.length} changed`)
  return failed.length > 0 ? 1 : 0
}

if (import.meta.main) process.exit(run(process.argv.includes('--check')))
