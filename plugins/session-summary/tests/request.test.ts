import { expect, test } from 'claude-code/testing'
import { DEFAULT_VARIANT, VARIANTS } from '../hooks/prompts.ts'
import { buildRequest, fileCandidates, parseReply, seedFromCapture } from '../hooks/summary.ts'

const previous = { soFar: 'Finished the setup.', now: 'Writing boundary tests.', files: ['src/old.ts'] }

const assistant = (toolUses: unknown[]) => ({ role: 'assistant', text: '', toolUses })

test('a later command makes an earlier written file the newest candidate', () => {
  const messages = [
    assistant([{ name: 'Write', input: { file_path: 'src/first.ts' } }]),
    assistant([{ name: 'Edit', input: { file_path: 'src/second.ts' } }]),
    assistant([{ name: 'Bash', input: { command: 'node --check src/first.ts' } }]),
  ]

  expect(fileCandidates(messages as never, 8)).toEqual(['src/second.ts', 'src/first.ts'])
})

test('uploaded files join written candidates without duplication and retain their most recent use', () => {
  const messages = [
    assistant([{ name: 'Write', input: { file_path: 'src/one.ts' } }]),
    assistant([{ name: 'SendUserFile', input: { files: ['notes/plan.md', 'src/one.ts', 7] } }]),
    assistant([{ name: 'Edit', input: { file_path: 9 } }]),
  ]

  expect(fileCandidates(messages as never, 8)).toEqual(['notes/plan.md', 'src/one.ts'])
})

test('candidate limits keep the newest files in chronological order', () => {
  const messages = [
    assistant([{ name: 'Write', input: { file_path: 'src/one.ts' } }]),
    assistant([{ name: 'Edit', input: { file_path: 'src/two.ts' } }]),
    assistant([{ name: 'Write', input: { file_path: 'src/three.ts' } }]),
  ]

  expect(fileCandidates(messages as never, 2)).toEqual(['src/two.ts', 'src/three.ts'])
})

test('an unknown variant falls back to the default system text while preserving the complete request context', () => {
  const request = buildRequest({
    variant: 'removed-variant',
    source: 'session-log',
    previous,
    input: 'tail of the session log',
    candidates: ['src/first.ts', 'notes/plan.md'],
    status: 'ended',
  })

  expect(request.system).toBe(VARIANTS[DEFAULT_VARIANT])
  expect(request.prompt).toContain('Status: ended')
  expect(request.prompt).toContain('Previous SO FAR: Finished the setup.')
  expect(request.prompt).toContain('Previous NOW: Writing boundary tests.')
  expect(request.prompt).toContain('Previous FILES: src/old.ts')
  expect(request.prompt).toContain('Candidate files (newest last):\n- src/first.ts\n- notes/plan.md')
  expect(request.prompt).toContain("The session's own log (tail):\ntail of the session log")
})

test('a complete reply keeps only candidate files in the model order', () => {
  const parsed = parseReply(
    'SO FAR: implementation complete\nNOW: waiting for review\nFILES: notes/plan.md, outside.txt, src/first.ts',
    previous,
    ['src/first.ts', 'notes/plan.md'],
    'running',
  )

  expect(parsed).toEqual({
    soFar: 'implementation complete',
    now: 'waiting for review',
    files: ['notes/plan.md', 'src/first.ts'],
    outcome: 'summary',
  })
})

test('a partial reply preserves only the fields it omitted', () => {
  const parsed = parseReply('SO FAR: narrowed the fix\nFILES: none', previous, ['src/first.ts'], 'running')

  expect(parsed).toEqual({ soFar: 'narrowed the fix', now: previous.now, files: [], outcome: 'parse-partial' })
})

test('a reply with no recognized fields retains running files but clears them after the session ends', () => {
  expect(parseReply('The model did not follow the form.', previous, [], 'running')).toEqual({ ...previous, outcome: 'parse-failed' })
  expect(parseReply('The model did not follow the form.', previous, [], 'ended')).toEqual({
    soFar: previous.soFar,
    now: previous.now,
    files: [],
    outcome: 'parse-failed',
  })
})

test('the final valid capture seeds a sanitized summary after malformed newer-looking lines', () => {
  const text = [
    JSON.stringify({ soFar: 'earlier', now: 'ignored', files: ['src/ignored.ts'], at: '2026-10-20T10:00:00Z', status: 'ended', source: 'session-log', variant: 'rewrite' }),
    '{broken json}',
    JSON.stringify({ soFar: 'saved work', now: 'ready to ship', files: ['src/one.ts', 3], at: 'not-a-date', status: 'wrong', source: 'unknown', variant: 8 }),
    '',
  ].join('\n')

  expect(seedFromCapture(text)).toEqual({
    soFar: 'saved work',
    now: 'ready to ship',
    files: ['src/one.ts'],
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
