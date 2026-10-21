import type { EngineInterface, Register } from 'claude-code'
import { isConversationReplaced } from './shared/events.ts'
import { firingRecord, stateDir } from './shared/firing.ts'
import { compactSessionLog, logPaths, pruneReason, templateText } from './log.ts'

// Keeps a session log per session under `<dir>/session-logs/`: `session.start` rewrites the
// template there, and a compaction of the main conversation moves settled lines to the archive
// beside the log. The SessionStart command hook in hooks.json prints the directive, since a
// mod's classic SessionStart hook is skipped on a machine with managed settings.

const PLUGIN = 'session-log'

async function stopstoppingDir($: EngineInterface): Promise<string> {
  return stateDir(await $.env.get('HOME'), await $.env.get('STOPSTOPPING_DIR'))
}

// One line per firing in the shared log; a failed write never stops the session.
async function record($: EngineInterface, outcome: string, reason: string): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    const override = await $.env.get('STOPSTOPPING_DIR')
    const entry = firingRecord({ home, override, plugin: PLUGIN, outcome, session: await $.session.id(), ms: 0, reason, now: new Date(await $.clock.now()) })
    if (entry === null) return
    if (!(await $.fs.exists(entry.path))) await $.fs.write(entry.path, '')
    await $.process.run(['tee', '-a', entry.path], { stdin: entry.line })
  } catch {
    // the log is a convenience
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const dir = await stopstoppingDir($)
      if (dir !== '') {
        await $.fs.write(logPaths(dir, await $.session.id()).template, templateText())
        await record($, 'template', '')
      }
    } catch {
      // a session starts without its template
    }
    return next(e)
  })

  // Every compaction that replaced the conversation logs one prune line: `prune`, `prune-skipped`
  // or `prune-failed`. directive.sh reads the newest of them, so an earlier prune never passes
  // for this one.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!isConversationReplaced(e, result)) return result
    const dir = await stopstoppingDir($).catch(() => '')
    if (dir === '') return result
    try {
      const id = await $.session.id()
      const paths = logPaths(dir, id)
      if (!(await $.fs.exists(paths.log))) {
        await record($, 'prune-skipped', 'no log')
        return result
      }
      const log = await $.fs.read(paths.log)
      const archive = (await $.fs.exists(paths.archive)) ? await $.fs.read(paths.archive) : null
      const pruned = compactSessionLog(log, archive, { sessionId: id, now: new Date(await $.clock.now()) })
      if (!pruned.ok) {
        await record($, 'prune-skipped', `missing ${pruned.missing.join(', ')}`)
        return result
      }
      // The archive first: a crash between the two leaves a line in both places, never in neither.
      if (pruned.archive !== null && pruned.moved > 0) await $.fs.write(paths.archive, pruned.archive)
      await $.fs.write(paths.log, pruned.log)
      await record($, 'prune', pruneReason(pruned.moved, paths.archive))
      for (const w of pruned.warnings) await record($, 'prune-warning', w)
    } catch (error) {
      // the log is left as it was; the next compaction tries again
      await record($, 'prune-failed', error instanceof Error ? error.message : 'prune failed')
    }
    return result
  })
}
