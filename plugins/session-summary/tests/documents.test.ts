import { expect, test } from 'claude-code/testing'
import type { Doc } from '../types'
import { absolutePath, capturedDocuments, clampOffset, fileRow, filesHeader, isDocumentPath, isOverFiles, mergeDocuments, shownDocuments } from '../hooks/documents.ts'
import { estimatedRows, paneHeight } from '../hooks/summary.ts'

const CWD = '/repo'
const assistant = (...toolUses: unknown[]) => ({ role: 'assistant', text: '', toolUses })
const wrote = (file_path: unknown, tool = 'Write') => assistant({ tool, input: { file_path } })
const sent = (...files: unknown[]) => assistant({ tool: 'SendUserFile', input: { files } })
const merge = (stored: readonly Doc[], messages: unknown[], now = 100) => mergeDocuments(stored, messages as never, CWD, now)
const paths = (docs: readonly Doc[]) => docs.map(d => d.path)
const doc = (path: string, touchedAt = 1, touches = 0): Doc => ({ path, touchedAt, touches })

test('document types join by case-free extension; a name that is only a dot-file or has none does not', () => {
  for (const path of ['a.md', 'a.TXT', 'x/a.html', 'a.pdf', 'a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.svg', 'a.webp']) expect(isDocumentPath(path)).toBe(true)
  for (const path of ['a.ts', 'a.py', '.md', 'md', 'a.md/b', 'dir.md/notes']) expect(isDocumentPath(path)).toBe(false)
})

test('a path is absolute with its dots folded', () => {
  expect(absolutePath('notes/./a/../plan.md', CWD)).toBe('/repo/notes/plan.md')
  expect(absolutePath('/x//y.md', CWD)).toBe('/x/y.md')
})

test('a Write or Edit of a document joins, newest first; of another type it does not; a send joins whatever its type', () => {
  const list = merge([], [wrote('a.md'), wrote('b.ts'), wrote('c.txt', 'Edit'), sent('d.ts', 7), wrote(9), wrote('')])
  expect(paths(list)).toEqual(['/repo/d.ts', '/repo/c.txt', '/repo/a.md'])
})

test('only a Write, Edit or send moves a listed file up: a Read, a command, or text naming it does not', () => {
  const list = [wrote('/repo/a.md'), wrote('/repo/b.md')]
  const naming = [
    assistant({ tool: 'Read', input: { file_path: '/repo/a.md' } }),
    assistant({ tool: 'Bash', input: { command: 'cat /repo/a.md' } }),
    { role: 'assistant', text: 'See /repo/a.md and a.md.', toolUses: [] },
    { role: 'user', text: '/repo/a.md', toolUses: [] },
  ]
  expect(paths(merge([], [...list, ...naming]))).toEqual(['/repo/b.md', '/repo/a.md'])
  expect(paths(merge([], [...list, wrote('/repo/a.md', 'Edit')]))).toEqual(['/repo/a.md', '/repo/b.md'])
  expect(paths(merge([], [...list, sent('/repo/a.md')]))).toEqual(['/repo/a.md', '/repo/b.md'])
})

test('a listed file of another type moves up on a Write or Edit, though that alone would not have listed it', () => {
  expect(paths(merge([], [sent('code.ts'), wrote('a.md'), wrote('code.ts', 'Edit')]))).toEqual(['/repo/code.ts', '/repo/a.md'])
})

test('a failed call is no touch', () => {
  expect(merge([], [assistant({ tool: 'Write', input: { file_path: 'a.md' }, isError: true })])).toEqual([])
  expect(paths(merge([], [wrote('a.md'), wrote('b.md'), assistant({ tool: 'Edit', input: { file_path: 'a.md' }, isError: true })]))).toEqual(['/repo/b.md', '/repo/a.md'])
})

test('a file the messages no longer hold stays, behind those they do, and a merge of the same messages changes nothing', () => {
  const stored = [doc('/repo/old1.md', 5), doc('/repo/old2.md', 4)]
  const once = merge(stored, [wrote('new.md'), sent('/repo/old2.md')], 50)
  expect(paths(once)).toEqual(['/repo/old2.md', '/repo/new.md', '/repo/old1.md'])
  expect(merge(once, [wrote('new.md'), sent('/repo/old2.md')], 90)).toEqual(once)
})

test('a new touch stamps the file; the same touches, a shrinking window and an unmoved newest file are told apart by the count', () => {
  const once = merge([], [wrote('a.md')], 10)
  expect(once).toEqual([{ path: '/repo/a.md', touchedAt: 10, touches: 1 }])
  expect(merge(once, [wrote('a.md')], 20)).toEqual(once)
  const again = merge(once, [wrote('a.md'), wrote('a.md', 'Edit')], 30)
  expect(again).toEqual([{ path: '/repo/a.md', touchedAt: 30, touches: 2 }])
  const trimmed = merge(again, [wrote('a.md', 'Edit')], 40)
  expect(trimmed).toEqual([{ path: '/repo/a.md', touchedAt: 30, touches: 1 }])
  expect(merge(trimmed, [wrote('a.md', 'Edit'), sent('a.md')], 50)[0]!.touchedAt).toBe(50)
})

test('a merge keeps a share, folds a relative path a capture held into its absolute row, and a capture line drops the share', () => {
  const share = { token: 't', expiresAt: 9 }
  expect(merge([{ ...doc('/repo/a.md'), share }], [])[0]!.share).toEqual(share)
  expect(paths(merge([doc('notes/a.md'), doc('/repo/notes/a.md')], []))).toEqual(['/repo/notes/a.md'])
  expect(capturedDocuments([{ ...doc('/repo/a.md'), share }])).toEqual([doc('/repo/a.md')])
})

test('the offset is clamped to what the list can scroll', () => {
  expect([clampOffset(-1, 12), clampOffset(0, 12), clampOffset(9, 12), clampOffset(10, 12)]).toEqual([0, 0, 9, 9])
  expect([clampOffset(5, 3), clampOffset(5, 2), clampOffset(5, 0)]).toEqual([0, 0, 0])
  const docs = ['a', 'b', 'c', 'd', 'e'].map(p => doc(p))
  expect(paths(shownDocuments(docs, 1))).toEqual(['b', 'c', 'd'])
  expect(paths(shownDocuments(docs, 99))).toEqual(['c', 'd', 'e'])
})

test('the header gives the position only past three files', () => {
  expect([filesHeader(0, 2), filesHeader(0, 3), filesHeader(0, 4), filesHeader(3, 12), filesHeader(99, 12)]).toEqual(['FILES', 'FILES', 'FILES 1–3 of 4', 'FILES 4–6 of 12', 'FILES 10–12 of 12'])
})

test('a wheel tick is over the section only on its rows at the bottom of what the body shows', () => {
  const dock = { contentRows: 40, bodyRows: 40, total: 12 }
  expect([35, 36, 39, 40, -1].map(row => isOverFiles({ ...dock, row }))).toEqual([false, true, true, false, false])
  expect(isOverFiles({ ...dock, row: undefined })).toBe(false)
  const inline = { contentRows: 10, bodyRows: 40, total: 2 }
  expect([6, 7, 9, 10].map(row => isOverFiles({ ...inline, row }))).toEqual([false, true, true, false])
  expect(isOverFiles({ contentRows: 40, bodyRows: 40, total: 0, row: 39 })).toBe(false)
})

test('a dock holds the tree to its rows; inline the tree takes what it needs, held to the room only when it would outgrow it', () => {
  expect(paneHeight({ placement: 'dock', bodyRows: 30, estimated: 5 })).toBe(30)
  expect(paneHeight({ placement: 'inline', bodyRows: 30, estimated: 5 })).toBe(undefined)
  expect(paneHeight({ placement: 'inline', bodyRows: 10, estimated: 11 })).toBe(10)
  expect(estimatedRows(null, 40, 0)).toBe(1)
  expect(estimatedRows(null, 40, 9)).toBe(6)
  const view = { title: 'T', isRunning: true, age: '', now: 'x'.repeat(80), soFar: 'y', asked: '' }
  expect(estimatedRows(view, 40, 0)).toBe(3 + 1 + 3 + 3)
})

const row = (d: Doc, over: Partial<Parameters<typeof fileRow>[1]> = {}) => fileRow(d, { cwd: CWD, linksBase: 'https://host.example:1', now: 100, isPresent: true, ...over })
const shared = (path: string, expiresAt = 200): Doc => ({ ...doc(path), share: { token: 'tok', expiresAt } })

test('with links off a row is a file:// link, whatever its share or file says', () => {
  expect(row(shared('/repo/a b.md', 1), { linksBase: '', isPresent: false })).toEqual({ label: 'a b.md', href: 'file:///repo/a%20b.md' })
  expect(row(doc('/repo/.env'), { linksBase: '' })).toEqual({ label: '.env', href: 'file:///repo/.env' })
})

test('with links on a live shared file links over https under its repo-relative label', () => {
  expect(row(shared('/repo/notes/a b.md'))).toEqual({ label: 'notes/a b.md', href: 'https://host.example:1/tok/a%20b.md' })
})

test('with links on a row past expiry, gone, unshared or secret-looking has no link', () => {
  expect(row(shared('/repo/a.md', 100))).toEqual({ label: 'a.md' })
  expect(row(shared('/repo/a.md'), { isPresent: false })).toEqual({ label: 'a.md' })
  expect(row(doc('/repo/a.md'))).toEqual({ label: 'a.md' })
  expect(row(shared('/repo/.env'))).toEqual({ label: '.env' })
})
