import type { SessionMessage } from 'claude-code'
import type { Doc } from '../types'
import { DOCUMENT_EXTENSIONS, FILES_ROWS } from './config.ts'
import { isSecretPath, shareUrl } from './links.ts'
import { isRecord } from './shared/typed.ts'

// The documents list's pure side, newest touch first: what joins it, how a merge with the
// messages moves it, and the rows the pane draws from it.

const EXTENSIONS: ReadonlySet<string> = new Set(DOCUMENT_EXTENSIONS)

// The session's own log is an agent's memory, not a document for the person.
const NOT_DOCUMENTS = /\/stopstopping\/session-logs\//

export function isDocumentPath(path: string): boolean {
  if (NOT_DOCUMENTS.test(path)) return false
  const name = path.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 && EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
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

function moveToFront(list: string[], path: string): void {
  const i = list.indexOf(path)
  if (i !== -1) list.splice(i, 1)
  list.unshift(path)
}

// The documents an agent's message points the person to, by a full path: a report often reaches
// them this way whatever made it, a shell redirect included. A relative name is too often a mention.
const POINTED_PATH = /(?<![\w.\/~-])(~?\/[\w.@+-]+(?:\/[\w.@+-]+)*)/g

export function pointedDocuments(text: string, home: string): string[] {
  const paths = [...text.matchAll(POINTED_PATH)].map(m => m[1]!.replace(/\.+$/, ''))
  return paths.filter(isDocumentPath).flatMap(p => (!p.startsWith('~') ? [p] : home === '' ? [] : [`${home}${p.slice(1)}`]))
}

// The paths one tool use touches: a Write or Edit's file, a SendUserFile's files.
function touchedBy(tool: string, input: unknown): string[] {
  if (!isRecord(input)) return []
  if (tool === 'Write' || tool === 'Edit') return typeof input.file_path === 'string' && input.file_path !== '' ? [input.file_path] : []
  if (tool === 'SendUserFile' && Array.isArray(input.files)) return input.files.filter((f): f is string => typeof f === 'string' && f !== '')
  return []
}

// The stored list with the messages replayed over it, oldest first. The engine hands over only the
// newest 4096 messages, so a path they no longer name keeps its place behind those they do, which
// is its true order: its last touch came before them. Replaying the same messages changes nothing,
// and a path's touch count going up is what says a touch is new, since messages carry no time.
export function mergeDocuments(stored: readonly Doc[], messages: readonly SessionMessage[], cwd: string, now: number, home = ''): Doc[] {
  const known = new Map<string, Doc>()
  for (const doc of stored) {
    const path = absolutePath(doc.path, cwd)
    if (!known.has(path)) known.set(path, { ...doc, path })
  }
  const order = [...known.keys()]
  const counts = new Map<string, number>()
  const touch = (path: string) => {
    moveToFront(order, path)
    counts.set(path, (counts.get(path) ?? 0) + 1)
  }
  for (const message of messages) {
    for (const use of message.toolUses) {
      if (use.isError) continue
      for (const raw of touchedBy(use.tool, use.input)) {
        const path = absolutePath(raw, cwd)
        // Only a Write or Edit of a file not on the list is held to the document types.
        if (use.tool !== 'SendUserFile' && !order.includes(path) && !isDocumentPath(path)) continue
        touch(path)
      }
    }
    if (message.role === 'assistant') for (const raw of pointedDocuments(message.text, home)) touch(absolutePath(raw, cwd))
  }
  return order.map(path => {
    const doc = known.get(path)
    const touches = counts.get(path) ?? 0
    if (doc === undefined) return { path, touchedAt: now, touches }
    return touches > doc.touches ? { ...doc, touchedAt: now, touches } : { ...doc, touches }
  })
}

// The list as a capture holds it: no share, so no token. `documentsFrom` reads it back.
export function capturedDocuments(docs: readonly Doc[]): Doc[] {
  return docs.map(({ path, touchedAt, touches }) => ({ path, touchedAt, touches }))
}

// A capture's `files`: an entry an earlier version wrote is a bare path, touched when that call ran.
export function documentsFrom(files: unknown, at: number): Doc[] {
  if (!Array.isArray(files)) return []
  return files.flatMap((f): Doc[] => {
    if (typeof f === 'string') return [{ path: f, touchedAt: at, touches: 0 }]
    if (!isRecord(f) || typeof f.path !== 'string') return []
    return [{ path: f.path, touchedAt: typeof f.touchedAt === 'number' ? f.touchedAt : at, touches: typeof f.touches === 'number' ? f.touches : 0 }]
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
export function filesScrollbar(offset: number, total: number): string[] {
  if (total <= FILES_ROWS) return []
  const size = Math.max(1, Math.round((FILES_ROWS * FILES_ROWS) / total))
  const start = Math.round((clampOffset(offset, total) / (total - FILES_ROWS)) * (FILES_ROWS - size))
  return Array.from({ length: FILES_ROWS }, (_, i) => (i >= start && i < start + size ? '█' : '│'))
}

// Whether a wheel tick was over the section pinned to the bottom of what the body shows.
export function isOverFiles(r: { row: number | undefined; contentRows: number; bodyRows: number; total: number }): boolean {
  if (r.row === undefined || r.total === 0) return false
  const shown = Math.min(r.contentRows, r.bodyRows)
  return r.row >= shown - (1 + Math.min(r.total, FILES_ROWS)) && r.row < shown
}

// A path inside the session's directory reads relative to it; any other keeps its last two segments.
export function fileLabel(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  const absolute = path.startsWith('/') ? path : `${root}${path}`
  return absolute.startsWith(root) ? absolute.slice(root.length) : `…/${absolute.split('/').slice(-2).join('/')}`
}

export function fileHref(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

export type FileRow = { label: string; href?: string }

// Links off: a file:// link, as the machine clicking resolves it. Links on: the https link while
// the file is shared, live and still there; else no link at all.
export function fileRow(doc: Doc, r: { cwd: string; linksBase: string; now: number; isPresent: boolean }): FileRow {
  const label = fileLabel(doc.path, r.cwd)
  const absolute = absolutePath(doc.path, r.cwd)
  if (r.linksBase === '') return { label, href: fileHref(absolute) }
  const isLive = doc.share !== undefined && doc.share.expiresAt > r.now && r.isPresent && !isSecretPath(absolute)
  return isLive ? { label, href: shareUrl(r.linksBase, doc.share!.token, absolute) } : { label }
}
