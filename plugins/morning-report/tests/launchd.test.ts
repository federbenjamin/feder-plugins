import { test, expect } from 'claude-code/testing'
import { REPORT_FIRES, REPORT_HOUR } from '../hooks/pipeline.ts'
import { launchdNames, renderPlist } from '../hooks/launchd.ts'

test('launchd names use the portable label consistently across the plist, log, domain, and target', async () => {
  expect(launchdNames('/home/x', '501')).toEqual({
    label: 'com.morning-report',
    plist: '/home/x/Library/LaunchAgents/com.morning-report.plist',
    logDir: '/home/x/Library/Logs/com.morning-report',
    log: '/home/x/Library/Logs/com.morning-report/run.log',
    domain: 'gui/501',
    target: 'gui/501/com.morning-report',
  })
})

const PLIST_INPUT = {
  claudePath: '/home/a b/.local/bin/claude',
  home: '/home/a b',
  path: '/home/a b/.local/bin:/usr/bin:/bin',
  uid: '501',
  hour: 5,
  pluginName: 'morning-report',
}

const firedHours = (plist: string) => [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map(m => Number(m[1]))

const scriptOf = (plist: string) => /<string>([^<]*)<\/string>\n {2}<\/array>/.exec(plist)![1]!

test('rendered plist fires five hours from the report hour, with the names, paths and environment launchd needs', async () => {
  const plist = renderPlist(PLIST_INPUT)
  expect(plist.endsWith('\n')).toBe(true)
  expect(plist.split('<key>Label</key><string>com.morning-report</string>').length).toBe(2)
  expect(firedHours(plist)).toEqual([5, 6, 7, 8, 9])
  expect(plist.split('<key>Minute</key><integer>0</integer>').length).toBe(6)
  expect(plist).toContain(
    '<key>ProgramArguments</key>\n  <array>\n    <string>/bin/sh</string>\n    <string>-c</string>\n' +
      `    <string>exec /usr/bin/env -i \${USER+"USER=$USER"} \${LOGNAME+"LOGNAME=$LOGNAME"} \${SHELL+"SHELL=$SHELL"} \${TMPDIR+"TMPDIR=$TMPDIR"} \${SSH_AUTH_SOCK+"SSH_AUTH_SOCK=$SSH_AUTH_SOCK"} 'HOME=/home/a b' 'PATH=/home/a b/.local/bin:/usr/bin:/bin' /bin/sh -c "$1"</string>\n` +
      '    <string>morning-report</string>\n    <string>list=$(',
  )
  expect(plist).toContain('<key>WorkingDirectory</key><string>/home/a b</string>')
  expect(plist).toContain('<key>PATH</key><string>/home/a b/.local/bin:/usr/bin:/bin</string>')
  expect(plist).toContain('<key>HOME</key><string>/home/a b</string>')
  expect(plist).toContain('<key>StandardOutPath</key><string>/home/a b/Library/Logs/com.morning-report/run.log</string>')
  expect(plist).toContain('<key>StandardErrorPath</key><string>/home/a b/Library/Logs/com.morning-report/run.log</string>')
  expect(firedHours(renderPlist({ ...PLIST_INPUT, hour: 19 }))).toEqual([19, 20, 21, 22, 23])
  const latest = firedHours(renderPlist({ ...PLIST_INPUT, hour: REPORT_HOUR.max }))
  expect(latest.length).toBe(REPORT_FIRES)
  expect(latest.at(-1)).toBe(23)
  expect(renderPlist({ ...PLIST_INPUT, home: '/home/o&brien' })).toContain('<key>HOME</key><string>/home/o&amp;brien</string>')
})

test('rendered plist script runs the report only for an enabled plugin and deletes the plist before bootout only when the list lacks it', async () => {
  const names = launchdNames(PLIST_INPUT.home, PLIST_INPUT.uid)
  const script = scriptOf(renderPlist(PLIST_INPUT))
  expect(script.startsWith(
    `list=$('/home/a b/.local/bin/claude' plugin list --json) || { echo "morning-report: claude plugin list failed (exit $?); the job stays" &gt;&amp;2; exit 1; }; state=$(printf '%s' "$list" | python3 -c 'import json, sys\n`,
  )).toBe(true)
  expect(script.endsWith(
    `print(state)' 'morning-report') || { echo "morning-report: could not read claude plugin list; the job stays" &gt;&amp;2; exit 1; }; ` +
      `if [ "$state" = enabled ]; then exec '/home/a b/.local/bin/claude' -p /morning-run; ` +
      `elif [ "$state" != absent ]; then echo "morning-report: the plugin is $state; nothing run" &gt;&amp;2; ` +
      `else echo 'morning-report: claude plugin list --json does not list morning-report; removing this job: rm -f ${names.plist}, then launchctl bootout ${names.target}' &gt;&amp;2; ` +
      `rm -f '${names.plist}' || exit 1; launchctl bootout '${names.target}'; fi`,
  )).toBe(true)
  expect(script.indexOf(`rm -f '${names.plist}'`)).toBeLessThan(script.indexOf(`launchctl bootout '`))
  expect(script).not.toMatch(/[<>]/)
  expect(script.replaceAll(/&(amp|lt|gt);/g, '')).not.toContain('&')
  const quoted = scriptOf(renderPlist({ ...PLIST_INPUT, claudePath: "/opt/o'k/claude" }))
  expect(quoted).toContain(`list=$('/opt/o'\\''k/claude' plugin list --json)`)
  expect(quoted).toContain(`then exec '/opt/o'\\''k/claude' -p /morning-run;`)
})
