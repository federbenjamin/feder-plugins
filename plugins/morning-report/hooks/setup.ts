import type { EngineInterface, ProcessRunResult } from 'claude-code'
import { complete, extractWindow, readProfile, readPrompt, REPORT_MAX_TOKENS, REPORT_TIMEOUT_MS, SHORT_PROCESS_TIMEOUT_MS, summarizeSessions, type Config } from './io.ts'
import { isMacOS, jobPluginCheck, launchdNames, MANUAL_RUN_TEXT, renderPlist } from './launchd.ts'
import {
  batchSessions,
  consentLine,
  DAY_MS,
  localDate,
  noSessionsScan,
  notSummarized,
  parseSetupArgs,
  profileHeadingsBlock,
  REPORT_FIRES,
  SCAN_UNREADABLE,
  scanFileText,
  scanPrompt,
  SETUP_NO_PROFILE,
  SETUP_USAGE,
  stderrHead,
  SUMMARY_NO_PROFILE,
  type Extracted,
  type UsageByModel,
} from './pipeline.ts'

// /morning-setup: the interview and the scan it may call, and the launchd schedule and its removal.

// What `launchctl print` exits with when the domain holds no such service.
const LAUNCHCTL_NO_SERVICE = 113

let scanRunning = false

// The trimmed stdout, or '' when the command failed, so a caller checks one value.
async function readLine($: EngineInterface, argv: string[]): Promise<string> {
  const r = await $.process.run(argv)
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

// A command.run hook can't submit (the submit would wait on the turn the hook holds), so a
// timer submits once the command has returned.
function submitPrompt($: EngineInterface, command: string, text: string): void {
  const say = (message: string) => {
    try {
      $.ui.toast(`morning-report: ${message}`)
    } catch {
      // the hook's $ may be gone by the time the submit settles
    }
  }
  $.clock.after(0, () => {
    $.prompt.submit({ text }).then(
      r => {
        if (r.drop !== undefined) say(`/${command} prompt was dropped: ${r.drop}`)
      },
      (err: unknown) => say(`/${command} prompt failed: ${err instanceof Error ? err.message : String(err)}`),
    )
  })
}

type SetupWindow = { since: string; until: string; extracted: Extracted; consent: string }

// The window, its extract and the consent line, before any model call; undefined when it has no sessions.
async function setupWindow($: EngineInterface, cfg: Config, days: number): Promise<SetupWindow | undefined> {
  const now = Date.now()
  const since = new Date(now - days * DAY_MS).toISOString()
  const until = new Date(now).toISOString()
  const extracted = await extractWindow($, cfg, since, until)
  const { sessions } = extracted
  if (!sessions.length) return undefined
  const consent = consentLine(sessions.length, batchSessions(sessions).length, days, cfg.summaryModel, cfg.reportModel)
  return { since, until, extracted, consent }
}

// The preview only feeds the optional scan, so a failed extract still starts the interview, with nothing to read.
async function setupPreview($: EngineInterface, cfg: Config): Promise<{ preview: string; why: string }> {
  try {
    const window = await setupWindow($, cfg, cfg.setupDays)
    return { preview: window ? window.consent : noSessionsScan(cfg.setupDays), why: '' }
  } catch (err) {
    return { preview: SCAN_UNREADABLE, why: `; ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function startSetup($: EngineInterface, cfg: Config): Promise<{ text: string }> {
  const { preview, why } = await setupPreview($, cfg)
  const now = Date.now()
  const text = await readPrompt($, 'morning-setup.md', {
    DATA_DIR: cfg.dataDir,
    TODAY: localDate(now, new Date(now).getTimezoneOffset()),
    PREVIEW: preview,
    PROFILE_HEADINGS: profileHeadingsBlock(),
    PROFILE: (await readProfile($, cfg)) ?? SETUP_NO_PROFILE,
  })
  submitPrompt($, 'morning-setup', text)
  return { text: `starting the setup interview; ${preview}${why}` }
}

export async function runSetupScan($: EngineInterface, cfg: Config, days: number): Promise<{ text: string; ok: boolean }> {
  if (scanRunning) return { text: 'a setup scan is already running', ok: false }
  scanRunning = true
  const status = (line: string | undefined) => {
    try {
      $.ui.status(line)
    } catch {
      // the status line is progress only; the scan goes on without it
    }
  }
  try {
    const runsDir = `${cfg.dataDir}/runs`
    const scanPath = `${runsDir}/setup-scan.md`
    for (const argv of [['mkdir', '-p', runsDir], ['test', '-w', runsDir]]) {
      const r = await $.process.run(argv)
      const reason = stderrHead(r.stderr)
      if (r.exitCode !== 0) return { text: `setup scan failed: cannot write to ${runsDir}${reason ? `: ${reason}` : ''}`, ok: false }
    }
    const window = await setupWindow($, cfg, days)
    if (!window) return { text: noSessionsScan(days), ok: false }
    const { since, until, extracted, consent } = window
    status(`morning-report: ${consent}`)

    const usage: UsageByModel = {}
    const summarizer = await readPrompt($, 'summarizer.md', { PROFILE: SUMMARY_NO_PROFILE })
    const { failed, text } = await summarizeSessions($, cfg, summarizer, extracted.sessions, usage, (done, total) =>
      status(`morning-report: summarizing ${done}/${total}`),
    )
    const scan = await complete($, {
      model: cfg.reportModel,
      system: await readPrompt($, 'setup-scan.md', {}),
      prompt: scanPrompt({ since, until, days, summaries: text }),
      maxTokens: REPORT_MAX_TOKENS,
      timeoutMs: REPORT_TIMEOUT_MS,
    }, usage)
    await $.fs.write(scanPath, scanFileText(scan, failed, extracted.sessions.length))
    return { text: `${scanPath}${notSummarized(failed)}`, ok: true }
  } catch (err) {
    return { text: `setup scan failed: ${err instanceof Error ? err.message : String(err)}`, ok: false }
  } finally {
    status(undefined)
    scanRunning = false
  }
}

async function launchctl($: EngineInterface, ...args: string[]): Promise<ProcessRunResult> {
  return $.process.run(['launchctl', ...args], { timeoutMs: SHORT_PROCESS_TIMEOUT_MS })
}

async function mustRun($: EngineInterface, argv: string[]): Promise<void> {
  const r = await $.process.run(argv)
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${stderrHead(r.stderr)}`)
}

const twoDigits = (hour: number) => String(hour).padStart(2, '0')

const cannot = (verb: string, reason: string) => ({ text: `cannot ${verb}: ${reason}` })

async function runSchedule($: EngineInterface, cfg: Config): Promise<{ text: string }> {
  const os = await readLine($, ['uname', '-s'])
  if (!os) return cannot('schedule', '`uname -s` failed or printed nothing')
  if (!isMacOS(os)) return { text: MANUAL_RUN_TEXT }
  if (!cfg.home) return cannot('schedule', 'HOME is not set')
  const claudePath = await readLine($, ['which', 'claude'])
  if (!claudePath) return cannot('schedule', 'no claude on PATH (which claude found nothing)')
  const uid = await readLine($, ['id', '-u'])
  if (!uid) return cannot('schedule', '`id -u` failed or printed nothing')
  const path = (await $.env.get('PATH')) ?? ''
  if (!path) return cannot('schedule', 'PATH is not set')
  // The job sees only its own environment and folder; a plugin it cannot see would make it remove itself.
  const check = jobPluginCheck({ claudePath, home: cfg.home, path, pluginName: $.plugin.name })
  const view = await $.process.run(check.argv, { cwd: check.cwd, timeoutMs: SHORT_PROCESS_TIMEOUT_MS })
  const state = view.exitCode === 0 ? view.stdout.trim() : ''
  if (state !== 'enabled') {
    const seen = state ? `lists ${$.plugin.name} as ${state}` : `failed: ${stderrHead(view.stderr)}`
    return cannot(
      'schedule',
      `the job clears every variable but HOME, PATH and the login ones (launchctl setenv included) and runs from ${cfg.home}, and there \`claude plugin list --json\` ${seen}. Install and enable the plugin for your user (not one project, not under CLAUDE_CONFIG_DIR), then schedule again`,
    )
  }
  const names = launchdNames(cfg.home, uid)
  await mustRun($, ['mkdir', '-p', names.logDir])
  await $.fs.write(names.plist, renderPlist({ claudePath, home: cfg.home, path, uid, hour: cfg.reportHour, pluginName: $.plugin.name }))
  // bootstrap refuses a service that is already loaded; not loaded is the common case.
  await launchctl($, 'bootout', names.target)
  const boot = await launchctl($, 'bootstrap', names.domain, names.plist)
  if (boot.exitCode !== 0) return { text: `launchctl bootstrap failed: ${stderrHead(boot.stderr)}` }
  return {
    text: `scheduled: ${names.label} runs claude -p /morning-run at ${twoDigits(cfg.reportHour)}:00 and hourly until ${twoDigits(cfg.reportHour + REPORT_FIRES - 1)}:00 (${names.plist}; log ${names.log}). /morning-setup remove undoes it.`,
  }
}

// The plist is deleted only once launchctl no longer has the job, so a failed bootout can be retried.
async function runRemove($: EngineInterface, cfg: Config): Promise<{ text: string }> {
  if (!cfg.home) return cannot('remove', 'HOME is not set')
  // The plist and log paths do not depend on the uid, so a machine with nothing installed runs no process.
  // A log folder without a plist still goes through bootout: the job's self-removal deletes its plist
  // before its own bootout, so a failed bootout there leaves the job loaded with only its log folder.
  const { plist, logDir } = launchdNames(cfg.home, '')
  const hasPlist = await $.fs.exists(plist)
  if (!hasPlist && !(await $.fs.exists(logDir))) return { text: `nothing installed: no ${plist}` }
  const uid = await readLine($, ['id', '-u'])
  if (!uid) return cannot('remove', '`id -u` failed or printed nothing')
  const names = launchdNames(cfg.home, uid)
  const bootout = await launchctl($, 'bootout', names.target)
  if (bootout.exitCode !== 0 && (await launchctl($, 'print', names.target)).exitCode !== LAUNCHCTL_NO_SERVICE) {
    return { text: `launchctl bootout failed: ${stderrHead(bootout.stderr)}; nothing removed` }
  }
  if (hasPlist) await mustRun($, ['rm', '-f', names.plist])
  await mustRun($, ['rm', '-rf', names.logDir])
  if (!hasPlist && bootout.exitCode !== 0) {
    return { text: `nothing installed: no ${plist}; removed the leftover log folder ${logDir}` }
  }
  return {
    text: `removed the launchd job ${names.label}, ${names.plist} and ${names.logDir}. Your status, patterns, profile and run files are still in ${cfg.dataDir}; delete that folder yourself if you want them gone.`,
  }
}

export async function runSetup($: EngineInterface, cfg: Config, args: string): Promise<{ kind: string; text: string }> {
  const parsed = parseSetupArgs(args)
  switch (parsed.kind) {
    case 'interview':
      return { kind: parsed.kind, ...(await startSetup($, cfg)) }
    case 'schedule':
      return { kind: parsed.kind, ...(await runSchedule($, cfg)) }
    case 'remove':
      return { kind: parsed.kind, ...(await runRemove($, cfg)) }
    case 'usage':
      return { kind: parsed.kind, text: SETUP_USAGE }
  }
}
