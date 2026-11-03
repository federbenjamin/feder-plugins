import type { EngineInterface, ProcessRunResult } from 'claude-code'
import type { JobNames } from './launchd.ts'
import { stderrHead } from './text.ts'

// The I/O half of a launchd job, for every plugin that installs one: load it, unload it, and the
// one-line reads the install needs. launchd.ts holds the pure half.

const LAUNCHCTL_TIMEOUT_MS = 60_000
// What `launchctl print` exits with when the domain holds no such service.
const LAUNCHCTL_NO_SERVICE = 113

async function launchctl($: EngineInterface, ...args: string[]): Promise<ProcessRunResult> {
  return $.process.run(['launchctl', ...args], { timeoutMs: LAUNCHCTL_TIMEOUT_MS })
}

// The trimmed stdout, or '' when the command failed, so a caller checks one value.
export async function readLine($: EngineInterface, argv: string[]): Promise<string> {
  const r = await $.process.run(argv)
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

// Writes the plist and loads the job; '' when it loaded, else why not. bootstrap refuses a service
// that is already loaded, so bootout goes first; not loaded is the common case.
export async function loadJob($: EngineInterface, names: JobNames, plist: string): Promise<string> {
  await $.fs.write(names.plist, plist)
  await launchctl($, 'bootout', names.target)
  const boot = await launchctl($, 'bootstrap', names.domain, names.plist)
  return boot.exitCode === 0 ? '' : `launchctl bootstrap failed: ${stderrHead(boot.stderr)}`
}

// `failure` is '' once launchctl no longer has the job; `wasLoaded` says this call unloaded it.
export async function unloadJob($: EngineInterface, names: JobNames): Promise<{ failure: string; wasLoaded: boolean }> {
  const bootout = await launchctl($, 'bootout', names.target)
  if (bootout.exitCode === 0) return { failure: '', wasLoaded: true }
  if ((await launchctl($, 'print', names.target)).exitCode === LAUNCHCTL_NO_SERVICE) return { failure: '', wasLoaded: false }
  return { failure: `launchctl bootout failed: ${stderrHead(bootout.stderr)}`, wasLoaded: false }
}
