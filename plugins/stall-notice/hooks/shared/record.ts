import type { EngineInterface } from 'claude-code'
import { firingRecord, stateDir } from './firing.ts'

// The I/O half of the firing log, for every plugin's hooks: the state dir read from the
// environment, and the one append. firing.ts holds the pure half.

export async function stateDirs($: EngineInterface): Promise<{ home: string; dir: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  return { home, dir: stateDir(home, await $.env.get('STOPSTOPPING_DIR')) }
}

// Appends one line to `path`. tee appends in one write but cannot make the folder, so a
// missing file is first written empty. Rejects on a failed write.
export async function appendLine($: EngineInterface, path: string, line: string): Promise<void> {
  if (!(await $.fs.exists(path))) await $.fs.write(path, '')
  await $.process.run(['tee', '-a', path], { stdin: line })
}

// One line per firing in `<dir>/logs/<plugin>.log`; a failed write never stops the plugin.
// `reason` holds the fields after the outcome.
export async function record($: EngineInterface, plugin: string, outcome: string, reason: string, ms = 0): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    const override = await $.env.get('STOPSTOPPING_DIR')
    const entry = firingRecord({ home, override, plugin, outcome, session: await $.session.id(), ms, reason, now: new Date(await $.clock.now()) })
    if (entry === null) return
    await appendLine($, entry.path, entry.line)
  } catch {
    // the log is a convenience
  }
}
