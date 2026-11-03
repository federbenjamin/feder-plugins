// A launchd job's pure side: its names and its plist text. What runs it and when is the plugin's.

export type JobNames = { label: string; plist: string; logDir: string; log: string; domain: string; target: string }

export function jobNames(label: string, home: string, uid: string): JobNames {
  const logDir = `${home}/Library/Logs/${label}`
  return {
    label,
    plist: `${home}/Library/LaunchAgents/${label}.plist`,
    logDir,
    log: `${logDir}/run.log`,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${label}`,
  }
}

export function isMacOS(unameS: string): boolean {
  return unameS.trim() === 'Darwin'
}

function xmlString(text: string): string {
  return `<string>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`
}

// `trigger` holds the plist lines that say when the job runs, each with its indent.
export function plistText(j: { names: JobNames; argv: readonly string[]; home: string; env: readonly (readonly [string, string])[]; trigger: readonly string[] }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${xmlString(j.names.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...j.argv.map(arg => `    ${xmlString(arg)}`),
    '  </array>',
    `  <key>WorkingDirectory</key>${xmlString(j.home)}`,
    ...j.trigger,
    `  <key>StandardInPath</key>${xmlString('/dev/null')}`,
    `  <key>StandardOutPath</key>${xmlString(j.names.log)}`,
    `  <key>StandardErrorPath</key>${xmlString(j.names.log)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...j.env.map(([k, v]) => `    <key>${k}</key>${xmlString(v)}`),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}
