import type { EngineInterface, Register } from 'claude-code'
import { callTool } from './calls'
import type { WriteTool } from './calls'
import { PLUGIN, SESSION_ID_RE, TYPED_CHARS_MAX } from './config'
import { appendEvents, loadSession, readLog } from './io'
import type { Loaded } from './io'
import { didFacts, isRecorded, outputText } from './recorder'
import { renderView } from './render'
import { PERSON_ORIGINS } from './shared/events'
import { sessionLogsDir } from './shared/firing'
import { record, stateDirs } from './shared/record'
import { clip } from './shared/text'
import type { LogEvent } from './store'
import { calledAs, OWN_TOOLS, READ_TOOL, TOOLS } from './tools'

// Keeps each main session's log: `session.start` registers the six tools, a `tool.call` hook per
// tool answers it from the store, `prompt.submit` keeps what the operator typed for the quote
// check, and a `tool.call` hook over every tool records what a finished call did. The store is
// `<dir>/session-logs/<session-id>.jsonl`; the `.md` beside it is a view written after each
// append. The SessionStart command hook in hooks.json prints the directive, since a mod's classic
// SessionStart hook is skipped on a machine with managed settings.

const SUBAGENT = "the session log is the main session's: a subagent keeps none and reports to its caller"
// A headless run's opening prompt is its operator's, as the terminal's composer is.
const isOperatorOrigin = (kind: string): boolean => PERSON_ORIGINS.has(kind) || kind === 'sdk'
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type Keeper = { loaded: Loaded | undefined; queue: Promise<unknown> }

// One write at a time, in call order: ids come from the state the write before left.
function serial<T>(k: Keeper, fn: () => Promise<T>): Promise<T> {
  const run = k.queue.then(fn, fn)
  k.queue = run.catch(() => undefined)
  return run
}

// The running session's state, loaded once per session id; undefined with no state folder.
async function sessionOf($: EngineInterface, k: Keeper): Promise<Loaded | undefined> {
  const { dir } = await stateDirs($)
  if (dir === '') return undefined
  const id = await $.session.id()
  if (k.loaded?.id !== id || k.loaded.dir !== dir) k.loaded = await loadSession($, dir, id)
  return k.loaded
}

async function append($: EngineInterface, s: Loaded, events: readonly LogEvent[]): Promise<void> {
  if ((await appendEvents($, s, events)) === 'legacy') await record($, PLUGIN, 'legacy', 'the hand-kept log was moved aside')
}

async function refuse($: EngineInterface, tool: string, why: string, startedAt: number): Promise<{ deny: string }> {
  await record($, PLUGIN, 'refused', `${tool}: ${why}`, Date.now() - startedAt)
  return { deny: why }
}

async function now($: EngineInterface): Promise<Date> {
  return new Date(await $.clock.now())
}

export const register: Register = on => {
  const k: Keeper = { loaded: undefined, queue: Promise.resolve() }

  on('session.start', async ($, e, next) => {
    const refused: string[] = []
    for (const tool of TOOLS) {
      try {
        await $.tool.register({ ...tool, isDeferred: false })
      } catch (err) {
        refused.push(tool.name)
        $.ui.toast(`${tool.name} not registered: ${message(err)}`)
      }
    }
    await record($, PLUGIN, 'tools', refused.length === 0 ? `registered=${TOOLS.length}` : `registered=${TOOLS.length - refused.length} refused=${refused.join(',')}`)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (isOperatorOrigin(e.origin.kind) && e.text.trim() !== '') {
      try {
        await serial(k, async () => {
          const s = await sessionOf($, k)
          if (s === undefined) return
          await append($, s, [{ t: 'typed', at: (await now($)).toISOString(), text: clip(e.text.trim(), TYPED_CHARS_MAX) }])
          await record($, PLUGIN, 'typed', `chars=${e.text.length}`)
        })
      } catch (err) {
        // the prompt enters all the same; a ruling that quotes it will be refused
        await record($, PLUGIN, 'failed', `typed: ${message(err)}`)
      }
    }
    return next(e)
  })

  for (const tool of TOOLS) {
    on('tool.call', { tool: calledAs(tool.name) }, async ($, e) => {
      const startedAt = Date.now()
      if (e.agentId !== undefined) return refuse($, tool.name, SUBAGENT, startedAt)
      try {
        return await serial(k, async () => {
          const s = await sessionOf($, k)
          if (s === undefined) return refuse($, tool.name, 'no state folder: HOME is not set', startedAt)
          if (tool.name === READ_TOOL) {
            const other = typeof e.session === 'string' ? e.session.trim() : ''
            if (other !== '' && !SESSION_ID_RE.test(other)) return refuse($, tool.name, 'session must be a session id', startedAt)
            const id = other === '' ? s.id : other
            const text = id === s.id && s.hasStore ? renderView(s.state, s.id) : await readLog($, s.dir, id)
            await record($, PLUGIN, 'read', `of=${id}${text === undefined ? ' none' : ''}`, Date.now() - startedAt)
            return { result: text ?? `no log for session ${id}` }
          }
          const name: WriteTool = tool.name
          const call = callTool(s.state, name, e, await now($))
          if ('refuse' in call) return refuse($, name, call.refuse, startedAt)
          await append($, s, call.events)
          await record($, PLUGIN, name.replace('_', '-'), call.reply, Date.now() - startedAt)
          return { result: call.reply }
        })
      } catch (err) {
        await record($, PLUGIN, 'failed', `${tool.name}: ${message(err)}`, Date.now() - startedAt)
        return { deny: `${tool.name} failed, nothing was recorded: ${message(err)}` }
      }
    })
  }

  // The recorder: after a call of the main session's succeeded, what it did goes in the store.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || OWN_TOOLS.has(e.tool) || !isRecorded(e.tool) || result.deny !== undefined || result.isError) return result
    try {
      await serial(k, async () => {
        const s = await sessionOf($, k)
        if (s === undefined) return
        const facts = didFacts({ tool: e.tool, input: e, output: outputText(result) }, { cwd: await $.session.cwd(), ownDir: sessionLogsDir(s.dir) })
        if (facts.length === 0) return
        const at = (await now($)).toISOString()
        await append(
          $,
          s,
          facts.map(f => ({ t: 'did' as const, at, ...f })),
        )
        await record($, PLUGIN, 'did', facts.map(f => f.kind).join(','))
      })
    } catch (err) {
      await record($, PLUGIN, 'failed', `did: ${message(err)}`)
    }
    return result
  })
}
