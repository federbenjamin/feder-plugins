import { expect, test } from 'claude-code/testing'
import type { Doc } from '../types'
import { FILE_CANDIDATE_CHECKS_MAX, FILE_CANDIDATES_MAX, RECENT_FILE_MS } from '../hooks/config.ts'
import { hasNewTop, filesScrollbar, absolutePath, capturedDocuments, clampOffset, documentsFrom, fileCandidates, fileLabel, fileRow, filesHeader, isDocumentPath, isOverFiles, isRecentFile, judgeablePaths, judgedDocuments, mergeDocuments, pathsIn, shownDocuments } from '../hooks/documents.ts'
import { estimatedRows, paneHeight } from '../hooks/summary.ts'

const CWD = '/repo'
const assistant = (...toolUses: unknown[]) => ({ role: 'assistant', text: '', toolUses })
const said = (text: string) => ({ role: 'assistant', text, toolUses: [] })
const person = (text: string) => ({ role: 'user', text, toolUses: [] })
const wrote = (file_path: unknown, tool = 'Write') => assistant({ tool, input: { file_path } })
const ran = (command: string) => assistant({ tool: 'Bash', input: { command } })
const sent = (...files: unknown[]) => assistant({ tool: 'SendUserFile', input: { files } })
const merge = (stored: readonly Doc[], messages: unknown[], now = 100) => mergeDocuments(stored, messages as never, CWD, now)
const paths = (docs: readonly Doc[]) => docs.map(d => d.path)
const doc = (path: string, touchedAt = 1, touches = 0): Doc => ({ path, touchedAt, touches })
const demoted = (path: string, touchedAt = 1, touches = 0): Doc => ({ ...doc(path, touchedAt, touches), isSuperseded: true })

test('a document type goes by case-free extension; a name that is only a dot-file or has none is not one', () => {
  for (const path of ['a.md', 'a.TXT', 'x/a.html', 'a.pdf', 'a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.svg', 'a.webp']) expect(isDocumentPath(path)).toBe(true)
  for (const path of ['a.ts', 'a.py', '.md', 'md', 'a.md/b', 'dir.md/notes']) expect(isDocumentPath(path)).toBe(false)
})

test('a path is absolute with its dots folded', () => {
  expect(absolutePath('notes/./a/../plan.md', CWD)).toBe('/repo/notes/plan.md')
  expect(absolutePath('/x//y.md', CWD)).toBe('/x/y.md')
})

test('a send joins whatever its type, newest first; a Write or Edit of any type does not join', () => {
  expect(paths(merge([], [wrote('a.md'), wrote('c.txt', 'Edit'), sent('d.ts', 7), sent('e.md'), wrote(9), wrote('')]))).toEqual(['/repo/e.md', '/repo/d.ts'])
})

test('a Write, Edit, send or an agent message naming it by full path moves a listed file up: a Read, a command, a relative name, or the person naming it does not', () => {
  const stored = [doc('/repo/b.md', 1, 1), doc('/repo/a.md', 1, 1)]
  const before = [wrote('/repo/a.md'), wrote('/repo/b.md')]
  const naming = [
    assistant({ tool: 'Read', input: { file_path: '/repo/a.md' } }),
    assistant({ tool: 'Bash', input: { command: 'cat /repo/a.md' } }),
    said('See a.md.'),
    person('/repo/a.md'),
  ]
  expect(paths(merge(stored, [...before, ...naming]))).toEqual(['/repo/b.md', '/repo/a.md'])
  expect(paths(merge(stored, [...before, wrote('/repo/a.md', 'Edit')]))).toEqual(['/repo/a.md', '/repo/b.md'])
  expect(paths(merge(stored, [...before, sent('/repo/a.md')]))).toEqual(['/repo/a.md', '/repo/b.md'])
  expect(paths(merge(stored, [...before, said('See /repo/a.md.')]))).toEqual(['/repo/a.md', '/repo/b.md'])
})

test('an agent message naming an unlisted file by full path does not add it', () => {
  expect(merge([], [said('Written to /tmp/two.md')])).toEqual([])
})

test('a full path under ~ is the same file as its expansion, and with no HOME it is no touch', () => {
  const stored = [doc('/tmp/x.md', 1, 0), doc('/home/me/a.md', 1, 0)]
  const messages = [said('See ~/a.md')] as never
  expect(paths(mergeDocuments(stored, messages, CWD, 5, '/home/me'))).toEqual(['/home/me/a.md', '/tmp/x.md'])
  expect(paths(mergeDocuments(stored, messages, CWD, 5, ''))).toEqual(['/tmp/x.md', '/home/me/a.md'])
})

test('a listed file of another type moves up on a Write or Edit', () => {
  expect(paths(merge([doc('/repo/a.md', 1, 1), doc('/repo/code.ts', 1, 1)], [sent('code.ts'), sent('a.md'), wrote('code.ts', 'Edit')]))).toEqual(['/repo/code.ts', '/repo/a.md'])
})

test('a failed call is no touch', () => {
  expect(merge([], [assistant({ tool: 'SendUserFile', input: { files: ['a.md'] }, isError: true })])).toEqual([])
  const stored = [doc('/repo/b.md', 1, 0), doc('/repo/a.md', 1, 0)]
  expect(paths(merge(stored, [assistant({ tool: 'Edit', input: { file_path: 'a.md' }, isError: true })]))).toEqual(['/repo/b.md', '/repo/a.md'])
})

test('a file the messages no longer hold stays, behind those they do, and a merge of the same messages changes nothing', () => {
  const stored = [doc('/repo/old1.md', 5), doc('/repo/old2.md', 4)]
  const once = merge(stored, [sent('new.md'), sent('/repo/old2.md')], 50)
  expect(paths(once)).toEqual(['/repo/old2.md', '/repo/new.md', '/repo/old1.md'])
  expect(merge(once, [sent('new.md'), sent('/repo/old2.md')], 90)).toEqual(once)
})

test('a new touch stamps the file; the same touches, a shrinking window and an unmoved newest file are told apart by the count', () => {
  const once = merge([], [sent('a.md')], 10)
  expect(once).toEqual([{ path: '/repo/a.md', touchedAt: 10, touches: 1 }])
  expect(merge(once, [sent('a.md')], 20)).toEqual(once)
  const again = merge(once, [sent('a.md'), wrote('a.md', 'Edit')], 30)
  expect(again).toEqual([{ path: '/repo/a.md', touchedAt: 30, touches: 2 }])
  const trimmed = merge(again, [wrote('a.md', 'Edit')], 40)
  expect(trimmed).toEqual([{ path: '/repo/a.md', touchedAt: 30, touches: 1 }])
  expect(merge(trimmed, [wrote('a.md', 'Edit'), sent('a.md')], 50)[0]!.touchedAt).toBe(50)
})

test('a place the summary call gave a file holds over a replay of touches that are not new', () => {
  const messages = [sent('a.md'), sent('b.md')]
  const once = merge([], messages, 10)
  const judged = judgedDocuments(once, { add: ['/repo/c.md'], superseded: [] }, { messages: messages as never, cwd: CWD, home: '', now: 20 })
  expect(paths(judged)).toEqual(['/repo/c.md', '/repo/b.md', '/repo/a.md'])
  expect(merge(judged, messages, 30)).toEqual(judged)
})

test('a merge keeps a share, folds a relative path a capture held into its absolute row, and a capture line drops the share', () => {
  const share = { token: 't', expiresAt: 9 }
  expect(merge([{ ...doc('/repo/a.md'), share }], [])[0]!.share).toEqual(share)
  expect(paths(merge([doc('notes/a.md'), doc('/repo/notes/a.md')], []))).toEqual(['/repo/notes/a.md'])
  expect(capturedDocuments([{ ...doc('/repo/a.md'), share }])).toEqual([doc('/repo/a.md')])
})

test('the offset is clamped to what the list can scroll', () => {
  expect([clampOffset(-1, 12), clampOffset(0, 12), clampOffset(7, 12), clampOffset(8, 12)]).toEqual([0, 0, 7, 7])
  expect([clampOffset(5, 5), clampOffset(5, 2), clampOffset(5, 0)]).toEqual([0, 0, 0])
  const docs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(p => doc(p))
  expect(paths(shownDocuments(docs, 1))).toEqual(['b', 'c', 'd', 'e', 'f'])
  expect(paths(shownDocuments(docs, 99))).toEqual(['d', 'e', 'f', 'g', 'h'])
})

test('the header gives the position only past five files', () => {
  expect([filesHeader(0, 2), filesHeader(0, 5), filesHeader(0, 6), filesHeader(3, 12), filesHeader(99, 12)]).toEqual(['FILES', 'FILES', 'FILES 1–5 of 6', 'FILES 4–8 of 12', 'FILES 8–12 of 12'])
})

test('a wheel tick is over the section only on its rows at the bottom of what the body shows', () => {
  const dock = { contentRows: 40, bodyRows: 40, total: 12 }
  expect([33, 34, 39, 40, -1].map(row => isOverFiles({ ...dock, row }))).toEqual([false, true, true, false, false])
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
  expect(estimatedRows(null, 40, 9)).toBe(8)
  const view = { title: 'T', isRunning: true, age: '', now: 'x'.repeat(80), soFar: 'y', asked: '' }
  expect(estimatedRows(view, 40, 0)).toBe(3 + 1 + 3 + 3)
  expect(estimatedRows({ ...view, soFar: 'y'.repeat(190) }, 40, 0, { soFar: true, asked: false })).toBe(3 + 1 + 3 + 2)
})

const row = (d: Doc, over: Partial<Parameters<typeof fileRow>[1]> = {}) => fileRow(d, { cwd: CWD, linksBase: 'https://host.example:1', now: 100, isPresent: true, ...over })
const shared = (path: string, expiresAt = 200): Doc => ({ ...doc(path), share: { token: 'tok', expiresAt } })

test('with links off a row is a file:// link, whatever its share or file says', () => {
  expect(row(shared('/repo/a b.md', 1), { linksBase: '', isPresent: false })).toEqual({ label: './a b.md', href: 'file:///repo/a%20b.md' })
  expect(row(doc('/repo/.env'), { linksBase: '' })).toEqual({ label: './.env', href: 'file:///repo/.env' })
})

test('with links on a live shared file links over https under its repo-relative label', () => {
  expect(row(shared('/repo/notes/a b.md'))).toEqual({ label: './notes/a b.md', href: 'https://host.example:1/tok/a%20b.md' })
})

test('with links on a row past expiry, gone, unshared or secret-looking has no link', () => {
  expect(row(shared('/repo/a.md', 100))).toEqual({ label: './a.md' })
  expect(row(shared('/repo/a.md'), { isPresent: false })).toEqual({ label: './a.md' })
  expect(row(doc('/repo/a.md'))).toEqual({ label: './a.md' })
  expect(row(shared('/repo/.env'))).toEqual({ label: './.env' })
})

test('a superseded row says so and keeps its link while the file is live', () => {
  const flagged = (d: Doc): Doc => ({ ...d, isSuperseded: true })
  expect(row(flagged(shared('/repo/a.md')))).toEqual({ label: './a.md', href: 'https://host.example:1/tok/a.md', isSuperseded: true })
  expect(row(flagged(doc('/repo/a.md')), { linksBase: '' })).toEqual({ label: './a.md', href: 'file:///repo/a.md', isSuperseded: true })
  expect(row(flagged(shared('/repo/a.md', 100)))).toEqual({ label: './a.md', isSuperseded: true })
})

test('a label inside the session directory reads ./ from it, also at its deepest; one outside keeps its last two segments', () => {
  expect(fileLabel('/repo/notes/deep/plan.md', '/repo')).toBe('./notes/deep/plan.md')
  expect(fileLabel('/repo/plan.md', '/repo/')).toBe('./plan.md')
  expect(fileLabel('/repository/plan.md', '/repo')).toBe('…/repository/plan.md')
  expect(fileLabel('/other/deep/dir/c.md', '/repo')).toBe('…/dir/c.md')
})

test('the dot marks a file touched within the window, up to its edge, and never a superseded one', () => {
  const at = 1_000_000
  expect(isRecentFile(doc('/a.md', at), at)).toBe(true)
  expect(isRecentFile(doc('/a.md', at), at + RECENT_FILE_MS)).toBe(true)
  expect(isRecentFile(doc('/a.md', at), at + RECENT_FILE_MS + 1)).toBe(false)
  expect(isRecentFile(demoted('/a.md', at), at)).toBe(false)
})

test('the scrollbar shows where the window sits, and is absent when every file fits', () => {
  expect(filesScrollbar(0, 5)).toEqual([])
  expect(filesScrollbar(0, 6)).toEqual(['█', '█', '█', '█', '│'])
  expect(filesScrollbar(1, 6)).toEqual(['│', '█', '█', '█', '█'])
  expect(filesScrollbar(0, 12)).toEqual(['█', '█', '│', '│', '│'])
  expect(filesScrollbar(7, 12)).toEqual(['│', '│', '│', '█', '█'])
  expect(filesScrollbar(99, 40)).toEqual(['│', '│', '│', '│', '█'])
})

test('a string looks like a path with a folder and an extension, or as a bare document name', () => {
  const text = 'See `~/docs/report-2.md`, /tmp/a/plan.md. Also README.md, ./n/b.ts:12, ../c.txt and a/b/c.md.'
  expect(pathsIn(text)).toEqual(['~/docs/report-2.md', '/tmp/a/plan.md', 'README.md', './n/b.ts', '../c.txt', 'a/b/c.md'])
  expect(pathsIn('node.js, e.g. v1.2.3, https://example.com/a/b.md, example.com, package.json, a/b/, and/or.')).toEqual([])
})

const candidates = (messages: unknown[], r: { files?: string[]; listed?: readonly Doc[]; home?: string; cwd?: string } = {}) => {
  const files = new Set(r.files ?? [])
  return fileCandidates(messages as never, { cwd: r.cwd ?? CWD, home: r.home ?? '/home/me', listed: r.listed ?? [], exists: async p => files.has(p) })
}

test('candidates come from Write, Edit and send inputs, commands and agent text, newest last', async () => {
  const files = ['/repo/w.ts', '/repo/e.md', '/repo/s.bin', '/repo/c.md', '/repo/t.md']
  expect(await candidates([wrote('/repo/w.ts'), wrote('/repo/e.md', 'Edit'), sent('/repo/s.bin'), ran('cat /repo/c.md'), said('See /repo/t.md')], { files })).toEqual(files)
})

test('a Read, Grep, Glob, a failed call, or the person naming a file makes no candidate', async () => {
  const files = ['/repo/a.md']
  expect(await candidates([assistant({ tool: 'Read', input: { file_path: '/repo/a.md' } }), assistant({ tool: 'Grep', input: { path: '/repo/a.md', pattern: 'x' } }), assistant({ tool: 'Glob', input: { pattern: '/repo/a.md' } }), person('look at /repo/a.md')], { files })).toEqual([])
  expect(await candidates([assistant({ tool: 'Write', input: { file_path: '/repo/a.md' }, isError: true }), assistant({ tool: 'Bash', input: { command: 'cat /repo/a.md' }, isError: true })], { files })).toEqual([])
})

test('a file named many ways is one candidate, at its newest mention', async () => {
  const files = ['/repo/a.md', '/repo/b.md']
  expect(await candidates([said('/repo/a.md'), said('/repo/b.md'), ran('cat ./a.md'), said('a.md')], { files })).toEqual(['/repo/b.md', '/repo/a.md'])
})

test('a secret-looking path and the session log never become candidates, however they are named', async () => {
  const files = ['/repo/.env.local', '/repo/secrets/plan.md', '/repo/plan.md', '/s/id_rsa.pub', '/h/.claude/stopstopping/session-logs/s.md', '/repo/ok.md']
  expect(await candidates([wrote('/repo/.env.local'), ran('cat secrets/plan.md /s/id_rsa.pub'), said('/h/.claude/stopstopping/session-logs/s.md'), said('/repo/ok.md')], { files })).toEqual(['/repo/ok.md'])
  expect(await candidates([said('/repo/secrets/plan.md'), said('plan.md')], { files })).toEqual([])
})

test('a bare name resolves to the most recent known full path ending in it, then the session directory', async () => {
  const files = ['/one/README.md', '/two/README.md', '/repo/README.md']
  expect(await candidates([said('/one/README.md'), said('/two/README.md'), said('README.md')], { files: ['/two/README.md', '/one/README.md', '/repo/README.md'] })).toEqual(['/one/README.md', '/two/README.md'])
  expect(await candidates([said('README.md')], { files })).toEqual(['/repo/README.md'])
})

test('a known path the file is no longer at falls to the next place, and a name at none drops out', async () => {
  expect(await candidates([said('/gone/plan.md'), said('plan.md')], { files: ['/repo/plan.md'] })).toEqual(['/repo/plan.md'])
  expect(await candidates([said('For example /tmp/example/report.md or report.md')], { files: [] })).toEqual([])
})

test('a known path has to end in the whole name, and a Read or the person can supply it without being a candidate', async () => {
  expect(await candidates([said('/x/myplan.md'), said('plan.md')], { files: ['/repo/plan.md'] })).toEqual(['/repo/plan.md'])
  const read = assistant({ tool: 'Read', input: { file_path: '/other/repo/notes/plan.md' } })
  expect(await candidates([read, said('notes/plan.md')], { files: ['/other/repo/notes/plan.md', '/repo/notes/plan.md'] })).toEqual(['/other/repo/notes/plan.md'])
  expect(await candidates([person('see /mine/plan.md'), said('plan.md')], { files: ['/mine/plan.md'] })).toEqual(['/mine/plan.md'])
})

test('~ expands from HOME, a relative path folds against the session directory, and with no HOME a ~ path drops out', async () => {
  expect(await candidates([said('~/docs/a.md'), ran('cat ../up/b.md')], { files: ['/home/me/docs/a.md', '/up/b.md'] })).toEqual(['/home/me/docs/a.md', '/up/b.md'])
  expect(await candidates([said('~/docs/a.md')], { files: ['/home/me/docs/a.md'], home: '' })).toEqual([])
})

test('a current listed file is not offered again, a superseded one is, and a rejected one stays offered', async () => {
  const files = ['/repo/a.md', '/repo/b.md', '/repo/c.md']
  const messages = [said('/repo/a.md /repo/b.md /repo/c.md')]
  expect(await candidates(messages, { files, listed: [doc('/repo/a.md'), demoted('/repo/b.md')] })).toEqual(['/repo/b.md', '/repo/c.md'])
  expect(await candidates(messages, { files, listed: [doc('/repo/a.md'), demoted('/repo/b.md')] })).toEqual(['/repo/b.md', '/repo/c.md'])
})

test('the candidates are the newest ones up to the cap, and the checks on disk stop at theirs', async () => {
  const names = Array.from({ length: FILE_CANDIDATES_MAX + 5 }, (_, i) => `/repo/f${i}.md`)
  const found = await candidates(names.map(n => said(n)), { files: names })
  expect(found).toEqual(names.slice(5))

  let checks = 0
  const many = Array.from({ length: FILE_CANDIDATE_CHECKS_MAX + 50 }, (_, i) => said(`/gone/f${i}.md`))
  await fileCandidates(many as never, { cwd: CWD, home: '', listed: [], exists: async () => (checks++, false) })
  expect(checks).toBe(FILE_CANDIDATE_CHECKS_MAX)
})

test('only current files that are not withheld can be judged superseded', () => {
  expect(judgeablePaths([doc('/repo/a.md'), demoted('/repo/b.md'), doc('/repo/.env'), doc('/h/stopstopping/session-logs/s.md')])).toEqual(['/repo/a.md'])
})

const judge = (docs: readonly Doc[], verdict: { add?: string[]; superseded?: string[] }, messages: unknown[] = [], now = 50) => judgedDocuments(docs, { add: verdict.add ?? [], superseded: verdict.superseded ?? [] }, { messages: messages as never, cwd: CWD, home: '', now })

test('ADD puts files on top, first named first, stamped, with the touches the messages already hold', () => {
  const list = judge([doc('/repo/old.md', 1, 1)], { add: ['/repo/a.md', '/repo/b.md'] }, [wrote('/repo/a.md'), wrote('/repo/a.md', 'Edit')])
  expect(list).toEqual([{ path: '/repo/a.md', touchedAt: 50, touches: 2 }, { path: '/repo/b.md', touchedAt: 50, touches: 0 }, doc('/repo/old.md', 1, 1)])
})

test('an added file moves up again only on a touch that came after the call read the messages', () => {
  const messages = [wrote('/repo/a.md')]
  const list = judge([doc('/repo/old.md', 1, 0)], { add: ['/repo/a.md'] }, messages)
  expect(merge(list, messages, 60)).toEqual(list)
  const later = merge([doc('/repo/z.md', 2, 1), ...list], [...messages, sent('/repo/z.md'), wrote('/repo/a.md', 'Edit')], 70)
  expect(later[0]).toEqual({ path: '/repo/a.md', touchedAt: 70, touches: 2 })
})

test('SUPERSEDED sinks a file below every current one, keeping its share and stamp, and never removes it', () => {
  const share = { token: 't', expiresAt: 9 }
  const list = judge([{ ...doc('/repo/a.md', 3, 1), share }, doc('/repo/b.md'), demoted('/repo/c.md')], { superseded: ['/repo/a.md'] })
  expect(paths(list)).toEqual(['/repo/b.md', '/repo/a.md', '/repo/c.md'])
  expect(list[1]).toEqual({ path: '/repo/a.md', touchedAt: 3, touches: 1, share, isSuperseded: true })
})

test('new files added later stay above the superseded ones', () => {
  expect(paths(judge([doc('/repo/a.md'), demoted('/repo/b.md')], { add: ['/repo/c.md'] }))).toEqual(['/repo/c.md', '/repo/a.md', '/repo/b.md'])
  expect(paths(merge([doc('/repo/a.md'), demoted('/repo/b.md')], [sent('/repo/c.md')]))).toEqual(['/repo/c.md', '/repo/a.md', '/repo/b.md'])
})

test('a later touch or ADD clears the flag and brings the file back to the top; a replayed touch does not', () => {
  const stored = [doc('/repo/a.md', 1, 1), demoted('/repo/b.md', 1, 1)]
  const before = [wrote('/repo/a.md'), wrote('/repo/b.md')]
  expect(merge(stored, before, 60)).toEqual(stored)
  expect(merge(stored, [...before, wrote('/repo/b.md', 'Edit')], 60)).toEqual([{ path: '/repo/b.md', touchedAt: 60, touches: 2 }, doc('/repo/a.md', 1, 1)])
  expect(judge(stored, { add: ['/repo/b.md'] }, before, 60)).toEqual([{ path: '/repo/b.md', touchedAt: 60, touches: 1 }, doc('/repo/a.md', 1, 1)])
})

test('an empty verdict leaves the list as it stood', () => {
  const stored = [doc('/repo/a.md', 1, 1), demoted('/repo/b.md', 1, 1)]
  expect(judge(stored, {})).toEqual(stored)
})

test('the flag survives a capture and a resume, and a capture from before it reads as current', () => {
  const list = [doc('/repo/a.md', 1, 1), { ...demoted('/repo/b.md', 2, 1), share: { token: 't', expiresAt: 9 } }]
  const captured = capturedDocuments(list)
  expect(captured).toEqual([doc('/repo/a.md', 1, 1), demoted('/repo/b.md', 2, 1)])
  expect(documentsFrom(JSON.parse(JSON.stringify(captured)), 0)).toEqual(captured)
  expect(documentsFrom([{ path: '/repo/old.md', touchedAt: 1, touches: 1 }, '/repo/older.md'], 5)).toEqual([doc('/repo/old.md', 1, 1), doc('/repo/older.md', 5, 0)])
})

test('a truncated label in a message is not a path', () => {
  expect(pathsIn('See …/build/ship.md and …ssion-summary/plan.md, then /tmp/a/real.md')).toEqual(['/tmp/a/real.md'])
})

test('a new file on top, or the top file touched again, is a new top; an unchanged top or an empty list is not', () => {
  const doc = { path: '/a.md', touchedAt: 1, touches: 1 }
  expect(hasNewTop(doc, { ...doc, path: '/b.md' })).toBe(true)
  expect(hasNewTop(doc, { ...doc, touchedAt: 2 })).toBe(true)
  expect(hasNewTop(undefined, doc)).toBe(true)
  expect(hasNewTop(doc, { ...doc, touches: 2 })).toBe(false)
  expect(hasNewTop(doc, undefined)).toBe(false)
})
