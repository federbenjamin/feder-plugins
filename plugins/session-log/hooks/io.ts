import type { EngineInterface } from 'claude-code'
import { logPaths } from './log'
import { renderView } from './render'
import { applyEvent, emptyState, foldStore, storeLine } from './store'
import type { LogEvent, LogState } from './store'

// The store's file I/O: one session's state loaded from its `.jsonl`, events appended to it, and
// the `.md` view rewritten after each append. The plugin is the only writer of both files.

// `text` is the store file as last read or written; '' with `hasStore` false before the first append.
export type Loaded = { id: string; dir: string; state: LogState; text: string; hasStore: boolean }

// What an append did beside storing the events: `legacy` when it moved a hand-kept log aside,
// `viewError` when the events are stored and the view could not be rewritten.
export type Appended = { legacy: boolean; viewError?: string }

export async function loadSession($: EngineInterface, dir: string, id: string): Promise<Loaded> {
  const { store } = logPaths(dir, id)
  const hasStore = await $.fs.exists(store)
  const text = hasStore ? await $.fs.read(store) : ''
  return { id, dir, state: hasStore ? foldStore(text) : emptyState(), text, hasStore }
}

async function move($: EngineInterface, from: string, to: string): Promise<boolean> {
  const out = await $.process.run(['mv', '-n', from, to])
  return out.exitCode === 0 && !(await $.fs.exists(from))
}

// Appends the events, then rewrites the view; rejects, with nothing stored, when the store cannot
// be written. The first append of a session whose `.md` was kept by hand moves that file aside
// once and names it in the store, and stores nothing when the move does not happen.
// The store is written whole through the file API, never piped to a process: the engine refuses a
// process call whose stdin names a Claude Code settings file, which a prompt or a reason can. It
// is written beside itself and moved into place, so a cut write leaves the last whole store.
export async function appendEvents($: EngineInterface, s: Loaded, events: readonly LogEvent[]): Promise<Appended> {
  if (events.length === 0) return { legacy: false }
  const paths = logPaths(s.dir, s.id)
  const all: LogEvent[] = [...events]
  const legacy = !s.hasStore && (await $.fs.exists(paths.view))
  if (legacy) {
    if (!(await move($, paths.view, paths.legacy))) throw new Error(`the log kept by hand could not be moved to ${paths.legacy}`)
    all.unshift({ t: 'legacy', at: events[0]!.at, path: paths.legacy })
  }
  const text = s.text + all.map(storeLine).join('')
  await $.fs.write(paths.incoming, text)
  const placed = await $.process.run(['mv', paths.incoming, paths.store])
  if (placed.exitCode !== 0) throw new Error(`the store could not be moved into place at ${paths.store}`)
  s.text = text
  s.hasStore = true
  for (const e of all) applyEvent(s.state, e)
  try {
    await $.fs.write(paths.view, renderView(s.state, s.id))
    return { legacy }
  } catch (err) {
    return { legacy, viewError: err instanceof Error ? err.message : String(err) }
  }
}

// A session's log as text: its view when it has a store, else the `.md` as it is (a log kept
// before the tools), else undefined.
export async function readLog($: EngineInterface, dir: string, id: string): Promise<string | undefined> {
  const paths = logPaths(dir, id)
  if (await $.fs.exists(paths.store)) return renderView(foldStore(await $.fs.read(paths.store)), id)
  if (await $.fs.exists(paths.view)) return $.fs.read(paths.view)
  return undefined
}
