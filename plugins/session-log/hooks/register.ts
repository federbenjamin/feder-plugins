import type { EngineInterface, Register } from 'claude-code'
import { firingLine, logPath } from './shared/firing.ts'
import { compactSessionLog, logPaths, templateText } from './log.ts'

// Keeps a session log per session under `<dir>/session-logs/`: `session.start` rewrites the
// template there, and a compaction of the main conversation moves settled lines to the archive
// beside the log. The SessionStart command hook in hooks.json prints the directive, since a
// mod's classic SessionStart hook is skipped on a machine with managed settings.

const PLUGIN = 'session-log'

// A compaction replaced the main conversation: not a subagent's own, not a skipped one, and not a
// `precompute`, which only keeps its summary for later.
export function isConversationReplaced(e: { trigger: string; agentId?: string }, result: { skip?: string }): boolean {
  return e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined
}

async function stopstoppingDir($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  return (await $.env.get('STOPSTOPPING_DIR')) || (home ? `${home}/.claude/stopstopping` : '')
}

// One line per firing in the shared log; a failed write never stops the session.
async function record($: EngineInterface, dir: string, outcome: string, reason: string): Promise<void> {
  try {
    const path = logPath(dir, PLUGIN)
    if (!(await $.fs.exists(path))) await $.fs.write(path, '')
    const line = firingLine(outcome, await $.session.id(), 0, reason, new Date(await $.clock.now()))
    await $.process.run(['tee', '-a', path], { stdin: line })
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
        await record($, dir, 'template', '')
      }
    } catch {
      // a session starts without its template
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!isConversationReplaced(e, result)) return result
    try {
      const dir = await stopstoppingDir($)
      if (dir === '') return result
      const id = await $.session.id()
      const paths = logPaths(dir, id)
      if (!(await $.fs.exists(paths.log))) return result
      const log = await $.fs.read(paths.log)
      const archive = (await $.fs.exists(paths.archive)) ? await $.fs.read(paths.archive) : null
      const pruned = compactSessionLog(log, archive, { sessionId: id, now: new Date(await $.clock.now()) })
      if (!pruned.ok) {
        await record($, dir, 'prune-skipped', `missing ${pruned.missing.join(', ')}`)
        return result
      }
      // The archive first: a crash between the two leaves a line in both places, never in neither.
      if (pruned.archive !== null && pruned.moved > 0) await $.fs.write(paths.archive, pruned.archive)
      await $.fs.write(paths.log, pruned.log)
      await record($, dir, 'prune', `moved=${pruned.moved} archive=${paths.archive}`)
      for (const w of pruned.warnings) await record($, dir, 'prune-warning', w)
    } catch {
      // a failed prune leaves the log as it was; the next compaction tries again
    }
    return result
  })
}
