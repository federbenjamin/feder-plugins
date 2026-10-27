import type { EngineInterface, PluginOptions } from 'claude-code'
import { pool } from './shared/pool.ts'
import { isPermanent, retryDelayS } from './shared/retry.ts'
import {
  addUsage,
  batchSessions,
  describeFailure,
  expandHome,
  fillTemplate,
  intOption,
  parseExtracted,
  REPORT_HOUR,
  sessionBlock,
  SETUP_DAYS,
  stderrHead,
  summaryOutcome,
  type Extracted,
  type PromptName,
  type PromptValues,
  type Session,
  type Summary,
  type UsageByModel,
} from './pipeline.ts'

// The I/O both the nightly run and the setup share: the options, the data folder, the prompt
// files, the extract, and the model calls with their retries.

const SUMMARY_CONCURRENCY = 12
const SUMMARY_TIMEOUT_MS = 300_000
const EXTRACT_TIMEOUT_MS = 300_000
export const REPORT_TIMEOUT_MS = 600_000
// The report model's thinking counts against this cap; 16000 cut an answer mid-sentence.
export const REPORT_MAX_TOKENS = 32_000
export const SHORT_PROCESS_TIMEOUT_MS = 60_000

export type Config = {
  dataDir: string
  summaryModel: string
  reportModel: string
  sessionLogsDir: string
  notifyCommand: string
  gitCommit: boolean
  setupDays: number
  home: string
  reportHour: number
}

// The engine fills each option's default from plugin.json and checks its type before the module loads.
export async function resolveConfig($: EngineInterface, options: PluginOptions): Promise<Config> {
  const home = (await $.env.get('HOME')) ?? ''
  return {
    dataDir: expandHome(options.dataDir as string, home).replace(/\/$/, ''),
    summaryModel: options.summaryModel as string,
    reportModel: options.reportModel as string,
    sessionLogsDir: expandHome(options.sessionLogsDir as string, home),
    notifyCommand: options.notifyCommand as string,
    gitCommit: options.gitCommit as boolean,
    setupDays: intOption(options.setupDays, SETUP_DAYS),
    home,
    reportHour: intOption(options.reportHour, REPORT_HOUR),
  }
}

export async function readOr($: EngineInterface, path: string, fallback: string): Promise<string> {
  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : fallback
}

export async function listNames($: EngineInterface, dir: string): Promise<string[]> {
  return (await $.fs.exists(dir)) ? (await $.fs.list(dir)).map(e => e.name) : []
}

export async function readPrompt<N extends PromptName>($: EngineInterface, name: N, values: PromptValues<N>): Promise<string> {
  return fillTemplate(String(await $.fs.read(`${$.plugin.root}/prompts/${name}`)), values)
}

export async function readProfile($: EngineInterface, cfg: Config): Promise<string | undefined> {
  return (await readOr($, `${cfg.dataDir}/profile.md`, '')).trim() || undefined
}

// Commits everything under dataDir (a folder of a git repo) and pushes. A failure is reported,
// never fatal: the files are already written.
export async function commitData($: EngineInterface, cfg: Config, message: string): Promise<string> {
  const git = (...args: string[]) => $.process.run(['git', '-C', cfg.dataDir, ...args], { timeoutMs: SHORT_PROCESS_TIMEOUT_MS })
  const add = await git('add', '-A', '--', '.')
  if (add.exitCode !== 0) return `git add failed: ${stderrHead(add.stderr)}`
  const staged = await git('diff', '--cached', '--quiet', '--', '.')
  if (staged.exitCode === 0) return 'nothing new to commit'
  const commit = await git('commit', '-q', '-m', message, '--', '.')
  if (commit.exitCode !== 0) return `git commit failed: ${stderrHead(commit.stderr)}`
  const push = await git('push', '-q')
  return push.exitCode === 0 ? 'committed and pushed' : `committed; push failed: ${stderrHead(push.stderr)}`
}

export async function notify($: EngineInterface, cfg: Config, message: string) {
  if (cfg.notifyCommand) await $.process.run([cfg.notifyCommand, message]).catch(() => undefined)
}

export type CompleteRequest = { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }

export class PermanentFailure extends Error {}

// Retries back off with a `sleep` child process: a $ call in flight doesn't count against the
// hook's 10 s budget, where a $.clock.sleep would.
export async function complete($: EngineInterface, req: CompleteRequest, usage: UsageByModel): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await $.model.complete(req)
    addUsage(usage, req.model, r.usage)
    if (r.isAnswered) return r.text
    const delay = retryDelayS(r, attempt)
    if (delay === undefined) {
      const message = describeFailure(req.model, r)
      throw isPermanent(r) ? new PermanentFailure(message) : new Error(message)
    }
    await $.process.run(['sleep', String(delay)], { timeoutMs: (delay + 10) * 1000 })
  }
}

// A session whose summary still fails after retries is reported as missing; a permanent
// error (auth, billing, a bad model id) rethrows, which stops the pool.
async function summarize($: EngineInterface, cfg: Config, system: string, batch: Session[], usage: UsageByModel): Promise<Summary> {
  const ids = batch.map(s => s.id)
  const req: CompleteRequest = {
    model: cfg.summaryModel,
    system,
    prompt: batch.map(sessionBlock).join('\n\n'),
    maxTokens: Math.min(1500 * batch.length, 8000),
    timeoutMs: SUMMARY_TIMEOUT_MS,
  }
  try {
    return { ids, text: await complete($, req, usage) }
  } catch (err) {
    if (err instanceof PermanentFailure) throw err
    return { ids, failed: err instanceof Error ? err.message : String(err) }
  }
}

export async function extractWindow($: EngineInterface, cfg: Config, since: string, until: string): Promise<Extracted> {
  const argv = ['python3', `${$.plugin.root}/scripts/extract.py`, '--since', since, '--until', until]
  if (cfg.sessionLogsDir) argv.push('--session-logs', cfg.sessionLogsDir)
  const ex = await $.process.run(argv, { timeoutMs: EXTRACT_TIMEOUT_MS })
  if (ex.exitCode !== 0) throw new Error(`extract failed: ${ex.stderr.slice(0, 300)}`)
  if (ex.isStdoutTruncated) throw new Error('extract output was cut at 4 MiB; lower OUTPUT_CAP in scripts/extract.py')
  return parseExtracted(ex.stdout)
}

export async function summarizeSessions(
  $: EngineInterface,
  cfg: Config,
  system: string,
  sessions: Session[],
  usage: UsageByModel,
  onBatch?: (done: number, total: number) => void,
): Promise<{ failed: number; text: string[] }> {
  const batches = batchSessions(sessions)
  let done = 0
  const summaries = await pool(batches, SUMMARY_CONCURRENCY, async b => {
    const summary = await summarize($, cfg, system, b, usage)
    onBatch?.(++done, batches.length)
    return summary
  })
  return summaryOutcome(summaries)
}
