import { expect, test } from 'claude-code/testing'
import { batches, packSessions, ROW_GREP_PATTERN, selectCandidates, typedTurnsOf } from '../hooks/derive.ts'
import type { Session } from '../hooks/derive.ts'

const turn = (ts: string, text: string, before = '(session start)') => ({ ts, text, before })

test('only newest top-level transcript files from non-scratch projects are candidates', () => {
  const candidates = selectCandidates(
    [
      {
        name: 'ordinary-project',
        files: [
          { name: 'old.jsonl', kind: 'file', mtimeMs: 10 },
          { name: 'new.jsonl', kind: 'file', mtimeMs: 30 },
          { name: 'nested.jsonl', kind: 'directory', mtimeMs: 40 },
          { name: 'copy.jsonl.bak', kind: 'file', mtimeMs: 50 },
        ],
      },
      { name: '-tmp-reader-run', files: [{ name: 'ignored.jsonl', kind: 'file', mtimeMs: 99 }] },
      { name: '-private-var-scratch', files: [{ name: 'also-ignored.jsonl', kind: 'file', mtimeMs: 98 }] },
    ],
    '/projects',
  )

  expect(candidates).toEqual([
    { project: 'ordinary-project', path: '/projects/ordinary-project/new.jsonl', id: 'new', mtimeMs: 30 },
    { project: 'ordinary-project', path: '/projects/ordinary-project/old.jsonl', id: 'old', mtimeMs: 10 },
  ])
})

test('only typed rows retain the preceding agent action and compaction boundary', () => {
  const { turns, compactions } = typedTurnsOf([
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I inspected the current state.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls fixtures' } },
          { type: 'tool_use', name: 'Read', input: { file_path: 'rules.md' } },
        ],
      },
    }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-20T09:00:00.000Z' }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-10-20T09:01:00.000Z',
      message: { content: 'Keep the boundary case.' },
      origin: { kind: 'human' },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-10-20T09:02:00.000Z',
      message: { content: 'STOP JUDGE — machine prompt' },
      origin: { kind: 'plugin', name: 'stop-judge', asUser: true },
      promptSource: 'system',
      turnOrigin: 'system',
    }),
    JSON.stringify({
      type: 'attachment',
      timestamp: '2026-10-20T09:03:00.000Z',
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        prompt: 'One queued follow-up.',
        origin: { kind: 'human' },
      },
    }),
    'not JSON',
  ])

  expect(compactions).toEqual(['2026-10-20T09:00:00.000Z'])
  expect(turns).toEqual([
    {
      ts: '2026-10-20T09:01:00.000Z',
      text: 'Keep the boundary case.',
      before: 'TEXT: I inspected the current state.\nTOOL Bash: ls fixtures\nTOOL Read: rules.md',
    },
    {
      ts: '2026-10-20T09:03:00.000Z',
      text: 'One queued follow-up.',
      before: 'TEXT: I inspected the current state.\nTOOL Bash: ls fixtures\nTOOL Read: rules.md',
    },
  ])
})

test('an over-limit agent text and tool input keep their head and tail around the elision marker', () => {
  const { turns } = typedTurnsOf([
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: `  \n${'H'.repeat(500)}${'T'.repeat(500)}\n  ` },
          { type: 'tool_use', name: 'Bash', input: { command: ` ${'c'.repeat(200)}${'d'.repeat(200)} ` } },
        ],
      },
    }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-20T09:01:00.000Z', message: { content: 'Go on.' }, origin: { kind: 'human' } }),
  ])

  expect(turns.map(t => t.before)).toEqual([`TEXT: ${'H'.repeat(300)}\n…\n${'T'.repeat(300)}\nTOOL Bash: ${'c'.repeat(150)}\n…\n${'d'.repeat(150)}`])
})

test('an over-limit typed turn reaches the batch text and operatorText as the same head-and-tail clip', () => {
  const long: Session = { id: 'long', project: 'project-a', turns: [turn('2026-10-20T09:00:00.000Z', `${'a'.repeat(1500)}${'z'.repeat(1500)}`)] }
  const clipped = `${'a'.repeat(1250)}\n…\n${'z'.repeat(1250)}`

  const [batch] = batches([long], 10, 100_000)

  expect(batch!.operatorText).toBe(clipped)
  expect(batch!.text).toContain(`### operator typed\n${clipped}\n`)
})

test('a session-start prompt carries an explicit empty preceding-action marker', () => {
  const { turns } = typedTurnsOf([
    JSON.stringify({
      type: 'user',
      timestamp: '2026-10-20T09:01:00.000Z',
      message: { content: 'Start with this request.' },
      origin: { kind: 'human' },
    }),
  ])

  expect(turns).toEqual([turn('2026-10-20T09:01:00.000Z', 'Start with this request.')])
})

test('a capped derivation takes the newest turns that fit while all removes that cap', () => {
  const newest: Session = {
    id: 'newest',
    project: 'project-a',
    turns: [turn('2026-10-20T11:00:00.000Z', 'new one'), turn('2026-10-20T11:01:00.000Z', 'new two')],
  }
  const sparse: Session = { id: 'sparse', project: 'project-b', turns: [turn('2026-10-20T10:00:00.000Z', 'only one')] }
  const older: Session = {
    id: 'older',
    project: 'project-c',
    turns: [turn('2026-10-20T09:00:00.000Z', 'old one'), turn('2026-10-20T09:01:00.000Z', 'old two')],
  }

  expect(packSessions([newest, sparse, older], 3)).toEqual({
    kept: [{ ...newest }, { ...older, turns: [older.turns[1]!] }],
    turns: 3,
  })
  expect(packSessions([newest, sparse, older], null)).toEqual({ kept: [newest, older], turns: 4 })
})

test('batches split a long session at the turn ceiling without losing its operator text', () => {
  const source: Session = {
    id: 'alpha',
    project: 'project-a',
    turns: [
      turn('2026-10-20T09:00:00.000Z', 'first operator message', 'TEXT: first action'),
      turn('2026-10-20T09:01:00.000Z', 'second operator message', 'TEXT: second action'),
      turn('2026-10-20T09:02:00.000Z', 'third operator message', 'TEXT: third action'),
    ],
  }

  const packed = batches([source], 2, 10_000)

  expect(packed.map(batch => ({ sessions: batch.sessions, turns: batch.turns }))).toEqual([
    { sessions: ['alpha'], turns: 2 },
    { sessions: ['alpha'], turns: 1 },
  ])
  expect(packed[0]!.operatorText).toContain('first operator message')
  expect(packed[0]!.operatorText).toContain('second operator message')
  expect(packed[1]!.operatorText).toBe('third operator message')
  expect(packed[0]!.text).toContain("# session alpha")
  expect(packed[0]!.text).toContain("## turn 1 — 2026-10-20T09:00:00.000Z")
  expect(packed[0]!.text).toContain("### agent's preceding action\nTEXT: first action")
  expect(packed[0]!.text).not.toContain('Decisions log:')
})

test('a character ceiling starts the next session in a fresh batch even when turns fit', () => {
  const one: Session = { id: 'one', project: 'project-a', turns: [turn('2026-10-20T09:00:00.000Z', 'first')] }
  const two: Session = { id: 'two', project: 'project-b', turns: [turn('2026-10-20T09:01:00.000Z', 'second')] }

  const packed = batches([one, two], 10, 1)

  expect(packed.map(batch => ({ sessions: batch.sessions, turns: batch.turns, operatorText: batch.operatorText }))).toEqual([
    { sessions: ['one'], turns: 1, operatorText: 'first' },
    { sessions: ['two'], turns: 1, operatorText: 'second' },
  ])
})

test('the row pattern the host grep gets matches every row shape typedTurnsOf reads, so filtering by it keeps every turn', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Shall I?' }] } },
    { type: 'user', timestamp: '2026-10-20T09:00:00Z', message: { role: 'user', content: 'typed turn' }, origin: { kind: 'human' }, promptSource: 'typed' },
    { type: 'attachment', timestamp: '2026-10-20T09:01:00Z', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'queued turn', origin: { kind: 'human' } } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-20T09:02:00Z' },
    { type: 'progress', timestamp: '2026-10-20T09:03:00Z', data: { kind: 'tick' } },
  ].map(r => JSON.stringify(r))
  const pattern = new RegExp(ROW_GREP_PATTERN)
  expect(lines.map(l => pattern.test(l))).toEqual([true, true, true, true, false])
  const all = typedTurnsOf(lines)
  expect(all.turns.map(t => t.text)).toEqual(['typed turn', 'queued turn'])
  expect(all.compactions).toEqual(['2026-10-20T09:02:00Z'])
  expect(typedTurnsOf(lines.filter(l => pattern.test(l)))).toEqual(all)
})

test('a sidechain agent message is not the action before a typed turn', () => {
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'main ask' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } },
    { type: 'user', timestamp: '2026-10-20T09:00:00Z', message: { role: 'user', content: 'yes' } },
  ].map(r => JSON.stringify(r))
  expect(typedTurnsOf(rows).turns).toEqual([{ ts: '2026-10-20T09:00:00Z', text: 'yes', before: 'TEXT: main ask' }])
})
