import type { EngineInterface } from 'claude-code'
import { logPaths } from './log'
import { renderView } from './render'
import { applyEvent, emptyState, foldStore, storeLine } from './store'
import type { LogEvent, LogState } from './store'

// The store's file I/O: one session's state loaded from its `.jsonl`, events appended to it, and
// the `.md` view rewritten after each append. The plugin is the only writer of both files.

// `text` is the store file as last read or written; '' with `hasStore` false before the first append.
export type Loaded = { id: string; dir: string; state: LogState; text: string; hasStore: boolean }

export async function loadSession($: EngineInterface, dir: string, id: string): Promise<Loaded> {
  const { store } = logPaths(dir, id)
  const hasStore = await $.fs.exists(store)
  const text = hasStore ? await $.fs.read(store) : ''
  return { id, dir, state: hasStore ? foldStore(text) : emptyState(), text, hasStore }
}

// Appends the events, then rewrites the view. The first append of a session whose `.md` was kept
// by hand moves that file aside once and names it in the store. Returns 'legacy' when it did.
// The store is written whole through the file API, never piped to a process: the engine refuses a
// process call whose stdin names a Claude Code settings file, which a prompt or a reason can.
export async function appendEvents($: EngineInterface, s: Loaded, events: readonly LogEvent[]): Promise<'legacy' | undefined> {
  if (events.length === 0) return undefined
  const paths = logPaths(s.dir, s.id)
  const all: LogEvent[] = [...events]
  let moved: 'legacy' | undefined
  if (!s.hasStore && (await $.fs.exists(paths.view))) {
    await $.process.run(['mv', '-n', paths.view, paths.legacy])
    all.unshift({ t: 'legacy', at: events[0]!.at, path: paths.legacy })
    moved = 'legacy'
  }
  const text = s.text + all.map(storeLine).join('')
  await $.fs.write(paths.store, text)
  s.text = text
  s.hasStore = true
  for (const e of all) applyEvent(s.state, e)
  await $.fs.write(paths.view, renderView(s.state, s.id))
  return moved
}

// A session's log as text: its view when it has a store, else the `.md` as it is (a log kept
// before the tools), else undefined.
export async function readLog($: EngineInterface, dir: string, id: string): Promise<string | undefined> {
  const paths = logPaths(dir, id)
  if (await $.fs.exists(paths.store)) return renderView(foldStore(await $.fs.read(paths.store)), id)
  if (await $.fs.exists(paths.view)) return $.fs.read(paths.view)
  return undefined
}
