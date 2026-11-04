import type { SessionMessage } from 'claude-code'
import type { Doc } from '../types'
import { DOCUMENT_EXTENSIONS, FILE_CANDIDATE_CHECKS_MAX, FILE_CANDIDATES_MAX, FILES_ROWS, RECENT_FILE_MS } from './config.ts'
import { isSecretPath, shareUrl } from './links.ts'
import { isRecord } from './shared/typed.ts'

// The documents list's pure side, newest touch first: which paths the summary call may judge, what
// its verdict and a merge with the messages do to the list, and the rows the pane draws from it.

const EXTENSIONS: ReadonlySet<string> = new Set(DOCUMENT_EXTENSIONS)

// The session's own log is an agent's memory, not a document for the person.
const NOT_DOCUMENTS = /\/stopstopping\/session-logs\//

export function isDocumentPath(path: string): boolean {
  const name = path.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 && EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

// A path that never reaches the model as a file to judge.
function isWithheldPath(path: string): boolean {
  return isSecretPath(path) || NOT_DOCUMENTS.test(path)
}

// An absolute path with its `.` and `..` folded, so one file is one row and the secret filter reads it whole.
export function absolutePath(path: string, cwd: string): string {
  const full = path.startsWith('/') ? path : `${cwd}/${path}`
  const kept: string[] = []
  for (const part of full.split('/')) {
    if (part === '..') kept.pop()
    else if (part !== '' && part !== '.') kept.push(part)
  }
  return `/${kept.join('/')}`
}

const isFullPath = (path: string): boolean => path.startsWith('/') || path.startsWith('~/')

// Undefined for a `~` path with no HOME to expand it from.
function resolvedPath(path: string, cwd: string, home: string): string | undefined {
  if (!path.startsWith('~/')) return absolutePath(path, cwd)
  return home === '' ? undefined : absolutePath(`${home}${path.slice(1)}`, cwd)
}

// One start per run of path characters, so a long token costs one pass.
const PATH = /(?<![\w.\/~@+…-])((?:~|\.{0,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)*\.[a-zA-Z]\w{0,4})(?![\w\/-])/g

// The path-looking strings in text or a command, oldest first. A name with no folder is too often
// not a file (`node.js`, `e.g`), so it has to be a document's.
export function pathsIn(text: string): string[] {
  return [...text.matchAll(PATH)].map(m => m[1]!).filter(p => p.includes('/') || isDocumentPath(p))
}

// The paths one tool use touches: a Write or Edit's file, a SendUserFile's files.
function touchedBy(tool: string, input: unknown): string[] {
  if (!isRecord(input)) return []
  if (tool === 'Write' || tool === 'Edit') return typeof input.file_path === 'string' && input.file_path !== '' ? [input.file_path] : []
  if (tool === 'SendUserFile' && Array.isArray(input.files)) return input.files.filter((f): f is string => typeof f === 'string' && f !== '')
  return []
}

type Touch = { count: number; isSent: boolean }

// Each path's touches in the messages, in the order of its latest one: a successful Write, Edit or
// send, or an agent's message naming it by full path.
function touchesIn(messages: readonly SessionMessage[], cwd: string, home: string): Map<string, Touch> {
  const touches = new Map<string, Touch>()
  const touch = (raw: string, isSend: boolean) => {
    const path = resolvedPath(raw, cwd, home)
    if (path === undefined) return
    const seen = touches.get(path)
    touches.delete(path)
    touches.set(path, { count: (seen?.count ?? 0) + 1, isSent: isSend || seen?.isSent === true })
  }
  for (const message of messages) {
    for (const use of message.toolUses) {
      if (use.isError) continue
      for (const raw of touchedBy(use.tool, use.input)) touch(raw, use.tool === 'SendUserFile')
    }
    if (message.role === 'assistant') for (const raw of pathsIn(message.text).filter(isFullPath)) touch(raw, false)
  }
  return touches
}

// Every file current before every superseded one, each group in its own order.
const currentFirst = (docs: readonly Doc[]): Doc[] => [...docs.filter(d => !d.isSuperseded), ...docs.filter(d => d.isSuperseded)]

function renewed({ isSuperseded: _, ...doc }: Doc, touchedAt: number, touches: number): Doc {
  return { ...doc, touchedAt, touches }
}

// The stored list with the messages' new touches over it. A touch is new when its path's count goes
// up, since messages carry no time, so replaying the same messages changes nothing and a place the
// summary call gave a file holds. The engine hands over only the newest 4096 messages; a path they
// no longer name keeps its place. Only a sent file joins here.
export function mergeDocuments(stored: readonly Doc[], messages: readonly SessionMessage[], cwd: string, now: number, home = ''): Doc[] {
  const known = new Map<string, Doc>()
  for (const doc of stored) {
    const path = absolutePath(doc.path, cwd)
    if (!known.has(path)) known.set(path, { ...doc, path })
  }
  const touches = touchesIn(messages, cwd, home)
  const moved: Doc[] = []
  for (const [path, { count, isSent }] of touches) {
    const doc = known.get(path)
    if (doc === undefined) {
      if (isSent) moved.unshift({ path, touchedAt: now, touches: count })
    } else if (count > doc.touches) {
      known.delete(path)
      moved.unshift(renewed(doc, now, count))
    }
  }
  const rest = [...known.values()].map(doc => ({ ...doc, touches: touches.get(doc.path)?.count ?? 0 }))
  return currentFirst([...moved, ...rest])
}

// What the messages can offer the summary call, raw and oldest first. `named` may become a candidate:
// an agent's text, a Write, Edit or send, a command. `known` also holds what only helps place a bare
// name: the files it read and the person's text.
function scrapedPaths(messages: readonly SessionMessage[]): { named: string[]; known: string[] } {
  const named: string[] = []
  const known: string[] = []
  for (const message of messages) {
    const inText = pathsIn(message.text)
    known.push(...inText)
    if (message.role === 'assistant') named.push(...inText)
    for (const use of message.toolUses) {
      if (use.isError || !isRecord(use.input)) continue
      const paths = use.tool === 'Bash' && typeof use.input.command === 'string' ? pathsIn(use.input.command) : touchedBy(use.tool, use.input)
      named.push(...paths)
      known.push(...paths)
      if (use.tool === 'Read' && typeof use.input.file_path === 'string') known.push(use.input.file_path)
    }
  }
  return { named, known }
}

// Where a path may be, best first: a full path is itself; a relative or bare name is the most recent
// known full path ending in it, then the older ones, then the session's directory.
function placesOf(raw: string, knownNewestFirst: readonly string[], cwd: string, home: string): string[] {
  const path = resolvedPath(raw, cwd, home)
  if (path === undefined) return []
  if (isFullPath(raw)) return [path]
  const ending = `/${raw.replace(/^(?:\.\/)+/, '')}`
  return [...knownNewestFirst.filter(k => k.endsWith(ending)), path]
}

// The files the summary call may add, as absolute paths, newest last: each named path at the first
// place it exists, so a name for no file, an example's included, drops out. A file already current on
// the list is not offered: naming it again would only reshuffle the list. A superseded one is, since
// an ADD is one way back. A secret-looking path or the session log is never offered.
export async function fileCandidates(messages: readonly SessionMessage[], r: { cwd: string; home: string; listed: readonly Doc[]; exists: (path: string) => Promise<boolean> }): Promise<string[]> {
  const { named, known } = scrapedPaths(messages)
  const knownNewestFirst = [...new Set(known.filter(isFullPath).map(p => resolvedPath(p, r.cwd, r.home)).filter(p => p !== undefined))].reverse()
  const current = new Set(r.listed.filter(d => !d.isSuperseded).map(d => d.path))
  const checked = new Map<string, boolean>()
  const exists = async (path: string): Promise<boolean> => {
    const seen = checked.get(path)
    if (seen !== undefined) return seen
    const isThere = await r.exists(path)
    checked.set(path, isThere)
    return isThere
  }
  const found = new Set<string>()
  for (const raw of new Set([...named].reverse())) {
    if (found.size >= FILE_CANDIDATES_MAX || checked.size >= FILE_CANDIDATE_CHECKS_MAX) break
    for (const place of placesOf(raw, knownNewestFirst, r.cwd, r.home)) {
      if (!(await exists(place))) continue
      if (!isWithheldPath(place) && !current.has(place)) found.add(place)
      break
    }
  }
  return [...found].reverse()
}

// The list as the summary call may judge it: what can still be superseded, nothing withheld.
export function judgeablePaths(docs: readonly Doc[]): string[] {
  return docs.filter(d => !d.isSuperseded && !isWithheldPath(d.path)).map(d => d.path)
}

export type FileVerdict = { add: readonly string[]; superseded: readonly string[] }

export const NO_VERDICT: FileVerdict = Object.freeze({ add: [], superseded: [] })

// The summary call's verdict over the list. ADD puts a file on top, first named first, and clears its
// flag; SUPERSEDED flags a file, which sinks below every current one and is never removed. An added
// file takes its count from the messages the call read, so what it already held is no new touch.
export function judgedDocuments(docs: readonly Doc[], verdict: FileVerdict, r: { messages: readonly SessionMessage[]; cwd: string; home: string; now: number }): Doc[] {
  const touches = touchesIn(r.messages, r.cwd, r.home)
  const byPath = new Map(docs.map(d => [d.path, d]))
  const added = verdict.add.map(path => {
    const doc = byPath.get(path)
    return doc === undefined ? { path, touchedAt: r.now, touches: touches.get(path)?.count ?? 0 } : renewed(doc, r.now, doc.touches)
  })
  const isAdded = new Set(verdict.add)
  const isDemoted = new Set(verdict.superseded)
  const rest = docs.filter(d => !isAdded.has(d.path)).map(d => (isDemoted.has(d.path) ? { ...d, isSuperseded: true } : d))
  return currentFirst([...added, ...rest])
}

// The list as a capture holds it: no share, so no token. `documentsFrom` reads it back.
export function capturedDocuments(docs: readonly Doc[]): Doc[] {
  return docs.map(({ share: _, ...doc }) => doc)
}

// A capture's `files`: an entry an earlier version wrote is a bare path, touched when that call ran.
export function documentsFrom(files: unknown, at: number): Doc[] {
  if (!Array.isArray(files)) return []
  return files.flatMap((f): Doc[] => {
    if (typeof f === 'string') return [{ path: f, touchedAt: at, touches: 0 }]
    if (!isRecord(f) || typeof f.path !== 'string') return []
    const doc = { path: f.path, touchedAt: typeof f.touchedAt === 'number' ? f.touchedAt : at, touches: typeof f.touches === 'number' ? f.touches : 0 }
    return [f.isSuperseded === true ? { ...doc, isSuperseded: true } : doc]
  })
}

export function clampOffset(offset: number, total: number): number {
  return Math.max(0, Math.min(offset, total - FILES_ROWS))
}

export function shownDocuments(docs: readonly Doc[], offset: number): readonly Doc[] {
  const from = clampOffset(offset, docs.length)
  return docs.slice(from, from + FILES_ROWS)
}

export function filesHeader(offset: number, total: number): string {
  if (total <= FILES_ROWS) return 'FILES'
  const from = clampOffset(offset, total)
  return `FILES ${from + 1}–${from + FILES_ROWS} of ${total}`
}

// One mark per shown row, the thumb's position showing where the window sits; none when all fit.
export function scrollbarMarks(offset: number, total: number, rows: number): string[] {
  if (total <= rows) return []
  const size = Math.max(1, Math.round((rows * rows) / total))
  const start = Math.round((offset / (total - rows)) * (rows - size))
  return Array.from({ length: rows }, (_, i) => (i >= start && i < start + size ? '█' : '│'))
}

export function filesScrollbar(offset: number, total: number): string[] {
  return scrollbarMarks(clampOffset(offset, total), total, FILES_ROWS)
}

// Whether a wheel tick was over the section pinned to the bottom of what the body shows.
export function isOverFiles(r: { row: number | undefined; contentRows: number; bodyRows: number; total: number }): boolean {
  if (r.row === undefined || r.total === 0) return false
  const shown = Math.min(r.contentRows, r.bodyRows)
  return r.row >= shown - (1 + Math.min(r.total, FILES_ROWS)) && r.row < shown
}

// A path inside the session's directory reads `./` from it; any other keeps its last two segments.
export function fileLabel(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  const absolute = path.startsWith('/') ? path : `${root}${path}`
  return absolute.startsWith(root) ? `./${absolute.slice(root.length)}` : `…/${absolute.split('/').slice(-2).join('/')}`
}

export function fileHref(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

// A file that lately moved to the top of the list. A superseded one sank, so it has no dot.
export function isRecentFile(doc: Doc, now: number): boolean {
  return !doc.isSuperseded && now - doc.touchedAt <= RECENT_FILE_MS
}

export type FileRow = { label: string; href?: string; isSuperseded?: boolean }

// Links off: a file:// link, as the machine clicking resolves it. Links on: the https link while
// the file is shared, live and still there; else no link at all. Being superseded changes the look
// and never the link.
export function fileRow(doc: Doc, r: { cwd: string; linksBase: string; now: number; isPresent: boolean }): FileRow {
  const label = fileLabel(doc.path, r.cwd)
  const flag = doc.isSuperseded ? { isSuperseded: true } : {}
  const absolute = absolutePath(doc.path, r.cwd)
  if (r.linksBase === '') return { label, href: fileHref(absolute), ...flag }
  const isLive = doc.share !== undefined && doc.share.expiresAt > r.now && r.isPresent && !isSecretPath(absolute)
  return isLive ? { label, href: shareUrl(r.linksBase, doc.share!.token, absolute), ...flag } : { label, ...flag }
}
