import { REPORT_FIRES } from './pipeline.ts'

// The nightly launchd job: its names, the plugin check it runs first, and its plist.

export type LaunchdNames = { label: string; plist: string; logDir: string; log: string; domain: string; target: string }

const LAUNCHD_LABEL = 'com.morning-report'

export function launchdNames(home: string, uid: string): LaunchdNames {
  const logDir = `${home}/Library/Logs/${LAUNCHD_LABEL}`
  return {
    label: LAUNCHD_LABEL,
    plist: `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    logDir,
    log: `${logDir}/run.log`,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${LAUNCHD_LABEL}`,
  }
}

export function isMacOS(unameS: string): boolean {
  return unameS.trim() === 'Darwin'
}

export const MANUAL_RUN_TEXT =
  'scheduled runs are macOS only; run `claude -p /morning-run` each morning by hand, or put that command in your own scheduler'

export type PlistInput = { claudePath: string; home: string; path: string; uid: string; hour: number; pluginName: string }

function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

function xmlString(text: string): string {
  return `<string>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`
}

// Reads `claude plugin list --json` on stdin and prints enabled, disabled or absent for the plugin
// named in argv[1]. Anything but a list of plugins exits non-zero, so a failed list never reads as absent.
const PLUGIN_STATE_PY = `import json, sys
plugins = json.load(sys.stdin)
if not (isinstance(plugins, list) and all(isinstance(p, dict) and isinstance(p.get("id"), str) and isinstance(p.get("enabled"), bool) for p in plugins)):
    sys.exit("claude plugin list --json printed no plugin list")
mine = [p["enabled"] for p in plugins if p["id"].startswith(sys.argv[1] + "@")]
state = "enabled" if any(mine) else "disabled" if mine else "absent"
print(state)`

const jobEnv = (home: string, path: string): [string, string][] => [
  ['HOME', home],
  ['PATH', path],
]

// Login variables launchd sets that the run's tools use (the ssh agent for a push, the temp folder); none picks a config.
const JOB_PASSTHROUGH = ['USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'SSH_AUTH_SOCK']

// launchd hands a job every variable of its domain (`launchctl setenv`) besides the plist's, and many
// variables change what claude reads (CLAUDE_CONFIG_DIR, CLAUDE_CODE_PLUGIN_DIRS, …). `env -i` drops them
// all, so the job and the schedule hook's check, both started through this, see one environment.
// The script rides as the outer shell's $1, so it stays as written.
function jobArgv(home: string, path: string, script: string): string[] {
  const keep = JOB_PASSTHROUGH.map(name => `\${${name}+"${name}=$${name}"}`)
  const set = jobEnv(home, path).map(([k, v]) => shellWord(`${k}=${v}`))
  const reset = ['exec', '/usr/bin/env', '-i', ...keep, ...set, '/bin/sh', '-c', '"$1"'].join(' ')
  return ['/bin/sh', '-c', reset, 'morning-report', script]
}

// Sets `state` from the plugin list, or exits 1 when the list fails or cannot be read.
function pluginStateLines(claudePath: string, pluginName: string): string[] {
  return [
    `list=$(${shellWord(claudePath)} plugin list --json) || { echo "morning-report: claude plugin list failed (exit $?); the job stays" >&2; exit 1; }`,
    `state=$(printf '%s' "$list" | python3 -c ${shellWord(PLUGIN_STATE_PY)} ${shellWord(pluginName)}) || { echo "morning-report: could not read claude plugin list; the job stays" >&2; exit 1; }`,
  ]
}

export type JobPluginCheck = { argv: string[]; cwd: string }

// The job's own plugin check, run where and with the environment the job runs in; prints the state.
export function jobPluginCheck({ claudePath, home, path, pluginName }: Omit<PlistInput, 'uid' | 'hour'>): JobPluginCheck {
  const script = [...pluginStateLines(claudePath, pluginName), `printf '%s\\n' "$state"`].join('; ')
  return { argv: jobArgv(home, path, script), cwd: home }
}

// The job runs the report only while the plugin is enabled, and removes itself only when a
// successful list lacks the plugin. `rm` goes before `bootout` because bootout kills this shell,
// so the log line that says why goes first of all.
export function renderPlist({ claudePath, home, path, uid, hour, pluginName }: PlistInput): string {
  const names = launchdNames(home, uid)
  const removing = `morning-report: claude plugin list --json does not list ${pluginName}; removing this job: rm -f ${names.plist}, then launchctl bootout ${names.target}`
  const script = [
    ...pluginStateLines(claudePath, pluginName),
    `if [ "$state" = enabled ]; then exec ${shellWord(claudePath)} -p /morning-run`,
    `elif [ "$state" != absent ]; then echo "morning-report: the plugin is $state; nothing run" >&2`,
    `else echo ${shellWord(removing)} >&2`,
    `rm -f ${shellWord(names.plist)} || exit 1`,
    `launchctl bootout ${shellWord(names.target)}`,
    'fi',
  ].join('; ')
  const fires = Array.from(
    { length: REPORT_FIRES },
    (_, i) => `    <dict><key>Hour</key><integer>${hour + i}</integer><key>Minute</key><integer>0</integer></dict>`,
  )
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${xmlString(names.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...jobArgv(home, path, script).map(arg => `    ${xmlString(arg)}`),
    '  </array>',
    `  <key>WorkingDirectory</key>${xmlString(home)}`,
    '  <key>StartCalendarInterval</key>',
    '  <array>',
    ...fires,
    '  </array>',
    '  <key>RunAtLoad</key><false/>',
    `  <key>StandardInPath</key>${xmlString('/dev/null')}`,
    `  <key>StandardOutPath</key>${xmlString(names.log)}`,
    `  <key>StandardErrorPath</key>${xmlString(names.log)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...jobEnv(home, path).map(([k, v]) => `    <key>${k}</key>${xmlString(v)}`),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}
