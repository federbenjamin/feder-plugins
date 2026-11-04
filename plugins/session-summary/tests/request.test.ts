import { expect, test } from 'claude-code/testing'
import { DEFAULT_VARIANT, VARIANTS } from '../hooks/prompts.ts'
import { buildRequest, keptLastPrompt, newestPrompt, parseFileVerdict, parseReply, seedDocuments, seedFromCapture, withQueued } from '../hooks/summary.ts'

const previous = { title: 'Boundary tests', lastPrompt: 'You asked for boundary tests.', soFar: 'Finished the setup.', now: 'Writing boundary tests.' }

test('an unknown variant falls back to the default system text while preserving the complete request context', () => {
  const request = buildRequest({
    variant: 'removed-variant',
    source: 'session-log',
    previous,
    newestPrompt: 'add the edge case too',
    input: 'tail of the session log',
    status: 'ended',
    isTitleProvisional: true,
    candidates: [],
    superseded: new Set(),
    judgeable: [],
  })

  expect(request.system).toBe(VARIANTS[DEFAULT_VARIANT])
  expect(request.prompt).toContain('Status: ended')
  expect(request.prompt).toContain('Previous TITLE: Boundary tests (provisional: written from the first prompt alone)\n')
  expect(request.prompt).toContain('Previous LAST PROMPT: You asked for boundary tests.\nPrevious SO FAR: Finished the setup.')
  expect(request.prompt).toContain('Previous NOW: Writing boundary tests.')
  expect(request.prompt).toContain("Newest prompt:\nadd the edge case too\n\nThe session's own log (tail):\ntail of the session log\n\nFile candidates:\n(none)\n\nCurrent file list:\n(none)")
})

const base = { variant: 'edit', source: 'messages' as const, previous, newestPrompt: 'go', input: 'x', status: 'running' as const, isTitleProvisional: false }

test('the request lists the candidates, marking a superseded one, and the file list the reply may judge', () => {
  const { prompt } = buildRequest({ ...base, candidates: ['/repo/a.md', '/repo/old.md'], superseded: new Set(['/repo/old.md']), judgeable: ['/repo/b.md', '/repo/c.md'] })
  expect(prompt.endsWith('File candidates:\n- /repo/a.md\n- /repo/old.md (superseded)\n\nCurrent file list:\n- /repo/b.md\n- /repo/c.md')).toBe(true)
})

test('every variant carries the ADD and SUPERSEDED rule, with no narrowing, after the four texts', () => {
  const rule = `Also answer two more lines at the end. The message lists "File candidates": paths seen in this session's writes, edits, commands and messages.
ADD: from the candidates only, the files the person would want to open and read themselves: a plan, a report, a brief, a design doc, a diagram, a result they were pointed to. Not source code, config, tests, logs, an agent's own notes, or a path given only as an example. Comma-separated, or none.
SUPERSEDED: from "Current file list" only, the files a newer file has replaced, or that are no longer current, like a draft that shipped or a plan a later one replaced. Comma-separated, or none. A file stays useful unless something clearly replaced it.`
  for (const system of Object.values(VARIANTS)) expect(system.endsWith(rule)).toBe(true)
  for (const system of Object.values(VARIANTS)) expect(system).not.toMatch(/README|GLOSSARY/)
})

const allowed = { candidates: ['/repo/a.md', '/repo/b c.md', '/repo/d.md'], judgeable: ['/repo/old.md', '/repo/older.md'] }

test('ADD and SUPERSEDED read their comma-separated paths, each only from its own set', () => {
  expect(parseFileVerdict('NOW: x\nADD: /repo/a.md, /repo/b c.md\nSUPERSEDED: /repo/older.md', allowed)).toEqual({ add: ['/repo/a.md', '/repo/b c.md'], superseded: ['/repo/older.md'] })
  expect(parseFileVerdict('ADD: /repo/old.md, /invented.md, a.md\nSUPERSEDED: /repo/a.md, /invented.md', allowed)).toEqual({ add: [], superseded: [] })
})

test('none, a missing line, an empty line and a repeat change nothing; wrapping quotes and Windows line ends are read through', () => {
  const nothing = { add: [], superseded: [] }
  expect(parseFileVerdict('ADD: none\nSUPERSEDED: None', allowed)).toEqual(nothing)
  expect(parseFileVerdict('TITLE: a\nNOW: b', allowed)).toEqual(nothing)
  expect(parseFileVerdict('ADD:\nSUPERSEDED: /repo/old.md', allowed)).toEqual({ add: [], superseded: ['/repo/old.md'] })
  expect(parseFileVerdict('ADD: /repo/a.md, /repo/a.md\nNOW: b', allowed)).toEqual({ add: ['/repo/a.md'], superseded: [] })
  expect(parseFileVerdict('ADD: `/repo/a.md`, "/repo/d.md"\r\nSUPERSEDED: /repo/old.md\r\n', allowed)).toEqual({ add: ['/repo/a.md', '/repo/d.md'], superseded: ['/repo/old.md'] })
})

test('a reply is complete at its four lines, and a FILES line from an older form changes nothing', () => {
  const expected = { title: 'Boundary tests', lastPrompt: 'You asked for the edge case.', soFar: 'implementation complete', now: 'waiting for review', outcome: 'summary' }
  const reply = 'TITLE: Boundary tests\nLAST PROMPT: You asked for the edge case.\nSO FAR: implementation complete\nNOW: waiting for review'

  expect(parseReply(reply, previous)).toEqual(expected)
  expect(parseReply(`${reply}\nFILES: notes/plan.md`, previous)).toEqual(expected)
})

test('a partial reply preserves only the fields it omitted', () => {
  expect(parseReply('SO FAR: narrowed the fix', previous)).toEqual({ ...previous, soFar: 'narrowed the fix', outcome: 'parse-partial' })
})

test('a reply with no recognized fields preserves every previous value', () => {
  expect(parseReply('The model did not follow the form.', previous)).toEqual({ ...previous, outcome: 'parse-failed' })
  expect(parseReply('FILES: notes/plan.md', previous)).toEqual({ ...previous, outcome: 'parse-failed' })
})

test('the final valid capture seeds a sanitized summary after malformed newer-looking lines', () => {
  const text = [
    JSON.stringify({ soFar: 'earlier', now: 'ignored', files: ['src/ignored.ts'], at: '2026-10-20T10:00:00Z', status: 'ended', source: 'session-log', variant: 'rewrite' }),
    '{broken json}',
    JSON.stringify({ soFar: 'saved work', now: 'ready to ship', files: ['src/one.ts', 3], at: 'not-a-date', status: 'wrong', source: 'unknown', variant: 8 }),
    '',
  ].join('\n')

  expect(seedFromCapture(text)).toEqual({
    title: '',
    lastPrompt: '',
    soFar: 'saved work',
    now: 'ready to ship',
    at: 0,
    status: 'running',
    source: 'messages',
    variant: 'edit',
  })
})

test('a capture without a complete text summary cannot seed stale state', () => {
  expect(seedFromCapture('{"soFar":"only one field"}\nnot json')).toBeNull()
  expect(seedFromCapture(' \n\n')).toBeNull()
})

test('a capture from the session-log source seeds that source and its variant', () => {
  const line = JSON.stringify({ soFar: 'read the log', now: 'waiting', files: [], at: '2026-10-20T10:00:00Z', status: 'ended', source: 'session-log', variant: 'append' })

  expect(seedFromCapture(line)).toEqual({ title: '', lastPrompt: '', soFar: 'read the log', now: 'waiting', at: Date.parse('2026-10-20T10:00:00Z'), status: 'ended', source: 'session-log', variant: 'append' })
})

test('a capture seeds the documents it held, and one from before the list its bare paths, touched when that call ran', () => {
  const at = '2026-10-20T10:00:00Z'
  const doc = { path: '/repo/plan.md', touchedAt: 5, touches: 2 }

  expect(seedDocuments(JSON.stringify({ soFar: 'x', now: 'y', at, files: [doc, 7, { touches: 1 }] }))).toEqual([doc])
  expect(seedDocuments(JSON.stringify({ soFar: 'x', now: 'y', at, files: ['/repo/old.md', 3] }))).toEqual([{ path: '/repo/old.md', touchedAt: Date.parse(at), touches: 0 }])
  expect(seedDocuments(JSON.stringify({ soFar: 'x', now: 'y', at }))).toEqual([])
  expect(seedDocuments(JSON.stringify({ soFar: 'x', now: 'y', at, files: [{ ...doc, isSuperseded: true }] }))).toEqual([{ ...doc, isSuperseded: true }])
  expect(seedDocuments('not json')).toEqual([])
})

test('an empty label keeps its previous text instead of reading the next label line', () => {
  expect(parseReply('SO FAR: a\nNOW:', previous)).toEqual({ ...previous, soFar: 'a', outcome: 'parse-partial' })
  expect(parseReply('SO FAR:\nNOW: checking the tests', previous)).toEqual({ ...previous, now: 'checking the tests', outcome: 'parse-partial' })
  // The request's "(none yet)" copied back is an empty text, not a title.
  expect(parseReply('TITLE: none yet\nLAST PROMPT: (none yet)\nSO FAR: (none yet)\nNOW: starting', previous)).toEqual({ title: '', lastPrompt: '', soFar: '', now: 'starting', outcome: 'summary' })
})

test('a label holding only spaces counts as absent, and blank labels alone fail the parse', () => {
  expect(parseReply('SO FAR: \t \nNOW: b', previous)).toEqual({ ...previous, now: 'b', outcome: 'parse-partial' })
  expect(parseReply('SO FAR:\nNOW:  ', previous)).toEqual({ ...previous, outcome: 'parse-failed' })
})

test('a reply with Windows line ends reads each value from its own line', () => {
  expect(parseReply('SO FAR: a\r\nNOW:\r\n', previous)).toEqual({ ...previous, soFar: 'a', outcome: 'parse-partial' })
})

test('withQueued puts each mid-turn prompt back after the messages that preceded it, clamped to the list', () => {
  const m = (text: string) => ({ role: 'assistant' as const, text, toolUses: [] })
  const out = withQueued([m('a'), m('b'), m('c')], [{ text: 'late', after: 9 }, { text: 'first', after: 1 }, { text: 'second', after: 2 }])
  expect(out.map(x => `${x.role}:${x.text}`)).toEqual(['assistant:a', 'user:first', 'assistant:b', 'user:second', 'assistant:c', 'user:late'])
  expect(withQueued([m('a')], [])).toEqual([m('a')])
})

test('the newest prompt is the last typed user message in the whole session, not a note or the agent', () => {
  const messages = [
    { role: 'user', text: 'fix both scripts', toolUses: [] },
    { role: 'assistant', text: 'Next: kill the servers.', toolUses: [] },
    { role: 'user', text: '<task-notification>done</task-notification>', toolUses: [] },
  ]

  expect(newestPrompt(messages as never, 1_500)).toBe('fix both scripts')
  expect(newestPrompt([] as never, 1_500)).toBe('')
})

test('LAST PROMPT stays as written while its prompt is unchanged, and follows a new one', () => {
  const kept = { summarized: 'investigate the artifacts', previous: 'You asked to investigate the artifacts.', replied: 'You asked to build the fix.' }

  expect(keptLastPrompt({ ...kept, newest: 'investigate the artifacts' })).toBe('You asked to investigate the artifacts.')
  expect(keptLastPrompt({ ...kept, newest: 'ship it' })).toBe('You asked to build the fix.')
  expect(keptLastPrompt({ ...kept, newest: 'investigate the artifacts', previous: '' })).toBe('You asked to build the fix.')
})
