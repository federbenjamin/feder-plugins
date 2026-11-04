import { expect, test } from 'claude-code/testing'
import { buildInput, expandHome, namedDocs, planOf, readTurn } from '../hooks/input.ts'
import type { TranscriptRow } from '../hooks/shared/typed.ts'

const at = (minute: number) => `2026-10-20T12:${String(minute).padStart(2, '0')}:00.000Z`
const typed = (text: string, minute = 0): TranscriptRow => ({ type: 'user', timestamp: at(minute), message: { content: text }, origin: { kind: 'human' }, promptSource: 'typed' })
const says = (text: string, minute = 0): TranscriptRow => ({ type: 'assistant', timestamp: at(minute), message: { content: [{ type: 'text', text }] } })
const uses = (id: string, name: string, input: Record<string, unknown>, minute = 0): TranscriptRow => ({ type: 'assistant', timestamp: at(minute), message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}, row: Record<string, unknown> = {}): TranscriptRow => ({
  type: 'user',
  timestamp: at(1),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
  ...row,
})

const FINAL = 'Done. Want me to push?'
const sections = (text: string) => [...text.matchAll(/^## (.*)$/gm)].map(m => m[1])

test('the sections come in the tested order, and the message ends on the final and the instruction', () => {
  const rows = [typed('first', 0), says('First answer.', 1), typed('second', 2), uses('t1', 'Read', { file_path: 'a.ts' }, 3), says('Reading it.', 3), says(FINAL, 7)]
  const input = buildInput(readTurn(rows, FINAL), { path: '~/plan.md', body: 'The plan.' })
  expect(sections(input)).toEqual(['Recent conversation, oldest first', 'Operator message that opened the turn', 'Facts read from the transcript', 'What the agent did this turn', 'Plan document ~/plan.md, its opening', "Agent's final message"])
  expect(input).toBe(
    [
      '## Recent conversation, oldest first',
      '',
      'Operator: first',
      '',
      'Agent: First answer.',
      '',
      '## Operator message that opened the turn',
      '',
      'second',
      '',
      '## Facts read from the transcript',
      '',
      'Background jobs not yet reported: none',
      'Tool calls refused this turn: none',
      '',
      '## What the agent did this turn',
      '',
      '1 tool calls over 5 minutes.',
      '- Read: a.ts',
      '',
      'What it said along the way, the latest last:',
      '',
      'Reading it.',
      '',
      '## Plan document ~/plan.md, its opening',
      '',
      'The plan.',
      '',
      "## Agent's final message",
      '',
      FINAL,
      '',
      'One JSON line.',
    ].join('\n'),
  )
})

test('with nothing before the opening and no plan, only the sections that hold something are there', () => {
  const input = buildInput(readTurn([says(FINAL)], FINAL), null)
  expect(sections(input)).toEqual(['Operator message that opened the turn', 'Facts read from the transcript', 'What the agent did this turn', "Agent's final message"])
  expect(input).toContain('## Operator message that opened the turn\n\n(none captured)')
})

test('the last eight exchanges are recent, the first older message and the last three that ask to be consulted frame them', () => {
  const older = ['the very first ask', 'a plain note', 'discuss one', 'ask me two', 'one by one three', 'wait four', 'another plain note']
  const recent = Array.from({ length: 8 }, (_, i) => `recent ${i}`)
  const rows = [...older, ...recent, 'the opening'].flatMap((u, i) => [typed(u, i), says(`answer to ${u}`, i)])
  const turn = readTurn([...rows.slice(0, -1), says(FINAL, 30)], FINAL)
  expect(turn.older).toEqual(['the very first ask', 'ask me two', 'one by one three', 'wait four'])
  expect(turn.recent.map(e => e.operator)).toEqual(recent)
  expect(turn.recent[0]!.agent).toBe('answer to recent 0')
  expect(turn.opening).toBe('the opening')
})

test('an older message that both opens the session and asks to be consulted appears once', () => {
  const rows = [...['wait for me', ...Array.from({ length: 8 }, (_, i) => `r${i}`), 'open'].flatMap((u, i) => [typed(u, i), says('ok', i)]).slice(0, -1), says(FINAL, 30)]
  expect(readTurn(rows, FINAL).older).toEqual(['wait for me'])
})

test('each piece keeps to its limit, clipped at the end that matters', () => {
  const long = (c: string, n: number) => c.repeat(n)
  const rows = [
    typed(long('o', 1000), 0),
    says(long('a', 1000), 0),
    typed(long('p', 4000), 1),
    says(`early ${long('m', 1000)}`, 1),
    says(`later ${long('n', 1000)}`, 2),
    says(`latest ${long('l', 299)}`, 2),
    says(`head ${long('f', 5000)}`, 3),
  ]
  const final = `head ${long('f', 5000)}`
  const input = buildInput(readTurn(rows, final), { path: '~/plan.md', body: long('b', 4000) })
  expect(input).toContain(`Operator: ${long('o', 400)} […]\n\nAgent: […] ${long('a', 400)}\n\n`)
  expect(input).toContain(`that opened the turn\n\n${long('p', 3000)} […]\n\n`)
  expect(input).not.toContain('early')
  expect(input).toContain(`[…] ${long('n', 300)}\n\n[…] `)
  expect(input).toContain(`its opening\n\n${long('b', 3000)}\n\n`)
  expect(input).toContain(`final message\n\n${long('f', 4000)}\n\nOne JSON line.`)
  expect(input).not.toContain('head f')
})

test('an older framing message is clipped at 600', () => {
  const rows = [typed('x'.repeat(700), 0), says('ok', 0), ...Array.from({ length: 8 }, (_, i) => [typed(`r${i}`, i + 1), says('ok', i + 1)]).flat(), typed('open', 20), says(FINAL, 21)]
  expect(buildInput(readTurn(rows, FINAL), null)).toContain(`oldest first\n\n${'x'.repeat(600)} […]\n\n`)
})

test('only the last 30 tool calls are listed, under the count of them all', () => {
  const calls = Array.from({ length: 35 }, (_, i) => uses(`t${i}`, 'Read', { file_path: `f${i}.ts` }, 1))
  const input = buildInput(readTurn([typed('go', 0), ...calls, says(FINAL, 2)], FINAL), null)
  expect(input).toContain('35 tool calls over 2 minutes.\n(the last 30 of them)\n- Read: f5.ts\n')
  expect(input).not.toContain('f4.ts')
  expect(input).toContain('- Read: f34.ts\n\n')
})

test('a tool call reads as what it did, marked when it runs in the background', () => {
  const lines = (block: [string, Record<string, unknown>]) => readTurn([typed('go'), uses('t', block[0], block[1]), says(FINAL)], FINAL).actions[0]
  expect(lines(['Bash', { description: 'Run  the\ntests', command: 'x' }])).toBe('Bash: Run the tests')
  expect(lines(['Bash', { command: 'ls', run_in_background: true }])).toBe('Bash: ls (in background)')
  expect(lines(['Bash', { command: 'y'.repeat(200) }])).toBe(`Bash: ${'y'.repeat(100)}`)
  expect(lines(['Edit', { file_path: 'a.ts', old_string: 'secret' }])).toBe('Edit: a.ts')
  expect(lines(['NotebookEdit', { notebook_path: 'n.ipynb' }])).toBe('NotebookEdit: n.ipynb')
  expect(lines(['Agent', { description: 'Look around', prompt: 'long' }])).toBe('Agent: Look around (in background)')
  expect(lines(['Skill', { skill: 'build' }])).toBe('Skill: build')
  expect(lines(['Grep', { pattern: 'x' }])).toBe('Grep: {"pattern":"x"}')
  expect(lines(['Grep', { pattern: 'z'.repeat(200) }])).toHaveLength('Grep: '.length + 80)
})

test('a failed call says why, and the time is left out when a row has none', () => {
  const rows = [typed('go'), uses('t1', 'Bash', { command: 'false' }), result('t1', 'exit 1 '.repeat(30), { is_error: true }), says(FINAL)]
  expect(readTurn(rows, FINAL).actions[0]).toBe(`Bash: false — FAILED: ${'exit 1 '.repeat(30).trim().slice(0, 90)}`)
  const untimed: TranscriptRow[] = [{ type: 'assistant', message: { content: [{ type: 'text', text: FINAL }] } }]
  expect(buildInput(readTurn(untimed, FINAL), null)).toContain('0 tool calls.\n')
})

test('a job started in the background stays pending until something closes it', () => {
  const start = uses('job', 'Bash', { description: 'Build the app', run_in_background: true }, 1)
  const launched = result('job', 'started', {}, { toolUseResult: { backgroundTaskId: 'task-1', status: 'async_launched' } })
  const pendingOf = (...rows: TranscriptRow[]) => readTurn([typed('go', 0), start, launched, ...rows, says(FINAL, 2)], FINAL).pending
  expect(pendingOf()).toEqual(['Build the app'])
  expect(buildInput(readTurn([typed('go', 0), start, launched, says(FINAL, 2)], FINAL), null)).toContain('Background jobs not yet reported: Build the app\n')
  // Its notification names the tool use, in a row's text or in a queue operation.
  expect(pendingOf({ type: 'user', message: { content: '<task-notification><tool-use-id>job</tool-use-id></task-notification>' } })).toEqual([])
  expect(pendingOf({ type: 'queue-operation', content: '<tool-use-id>job</tool-use-id>' })).toEqual([])
  expect(pendingOf({ type: 'user', message: { content: [{ type: 'text', text: '<tool-use-id>job</tool-use-id>' }] } })).toEqual([])
  // A notification about another job closes nothing here.
  expect(pendingOf({ type: 'user', message: { content: '<tool-use-id>other</tool-use-id>' } })).toEqual(['Build the app'])
  // TaskStop of its task.
  expect(pendingOf(uses('s', 'TaskStop', { task_id: 'task-1' }, 2))).toEqual([])
})

test('a call that ran to its end is not a pending job, and a job past three hours is taken as gone', () => {
  const start = uses('job', 'Bash', { description: 'Build', run_in_background: true }, 1)
  const finished = result('job', 'done', {}, { toolUseResult: { status: 'completed' } })
  expect(readTurn([typed('go', 0), start, finished, says(FINAL, 2)], FINAL).pending).toEqual([])
  const notAsync = result('job', 'done', {}, { toolUseResult: {} })
  expect(readTurn([typed('go', 0), start, notAsync, says(FINAL, 2)], FINAL).pending).toEqual([])
  const launched = result('job', 'started', {}, { toolUseResult: { isAsync: true, agentId: 'a1' } })
  const late = { ...says(FINAL), timestamp: '2026-10-20T15:02:00.000Z' }
  expect(readTurn([typed('go', 0), start, launched, says(FINAL, 2)], FINAL).pending).toEqual(['Build'])
  expect(readTurn([typed('go', 0), start, launched, late], FINAL).pending).toEqual([])
})

test('an Agent call is a background job unless it says it is not', () => {
  const launched = result('a', 'started', {}, { toolUseResult: { isAsync: true, agentId: 'a1', status: 'async_launched' } })
  expect(readTurn([typed('go', 0), uses('a', 'Agent', { description: 'Review it' }, 1), launched, says(FINAL, 2)], FINAL).pending).toEqual(['Review it'])
  expect(readTurn([typed('go', 0), uses('a', 'Agent', { description: 'Review it', run_in_background: false }, 1), launched, says(FINAL, 2)], FINAL).pending).toEqual([])
})

test('a refused call of this turn is read from its row; a plain failure and an earlier turn\'s refusal are not', () => {
  const refusal = 'Permission to use Bash has been denied by the sandbox.'
  const rows = [typed('earlier', 0), uses('o', 'Bash', { command: 'rm' }, 0), result('o', 'denied long ago', { is_error: true }), says('ok', 0), typed('go', 1), uses('t', 'Bash', { command: 'rm' }, 1), result('t', refusal, { is_error: true }), uses('u', 'Bash', { command: 'false' }, 1), result('u', 'exit code 1', { is_error: true }), says(FINAL, 2)]
  expect(readTurn(rows, FINAL).refused).toEqual([refusal])
  expect(buildInput(readTurn(rows, FINAL), null)).toContain(`Tool calls refused this turn: ${refusal}\n`)
  const blocks = result('t', [{ type: 'text', text: 'The guard  refused\nit' }], { is_error: true })
  expect(readTurn([typed('go', 0), uses('t', 'Bash', {}, 1), blocks, says(FINAL, 2)], FINAL).refused).toEqual(['The guard refused it'])
  const notError = result('t', 'permission granted')
  expect(readTurn([typed('go', 0), uses('t', 'Bash', {}, 1), notError, says(FINAL, 2)], FINAL).refused).toEqual([])
})

test('the operator\'s words for the quote check are what they typed, not what the agent or a plugin wrote', () => {
  const plugin: TranscriptRow = { type: 'user', message: { content: 'automessage: user is /afk' }, origin: { kind: 'plugin' } }
  const turn = readTurn([typed('first ask', 0), says('Say go and I will.', 0), plugin, typed('second ask', 1), says(FINAL, 2)], FINAL)
  expect(turn.operatorText).toBe('first ask\nsecond ask')
})

test('with no row holding the final text, every row read comes before it', () => {
  const turn = readTurn([typed('go', 0), uses('t', 'Read', { file_path: 'a.ts' }, 1)], 'The answer the engine gave.')
  expect(turn.opening).toBe('go')
  expect(turn.actions).toEqual(['Read: a.ts'])
  expect(buildInput(turn, null)).toContain("## Agent's final message\n\nThe answer the engine gave.\n\n")
})

test('a named document is a Markdown file under the home folder, not a session log or a transcript', () => {
  const home = '/home/u'
  const texts = 'See ~/notes/plan.md and /home/u/docs/brief.md, not /etc/plan.md or docs/rel.md or ~/.claude/stopstopping/session-logs/x-plan.md or /home/u/.claude/projects/p/plan.md'
  expect(namedDocs(readTurn([typed(texts, 0), says('Done.', 1)], 'Done.'), home)).toEqual(['~/notes/plan.md', '/home/u/docs/brief.md'])
  expect(expandHome('~/notes/plan.md', home)).toBe('/home/u/notes/plan.md')
  expect(expandHome('/home/u/plan.md', home)).toBe('/home/u/plan.md')
})

test('the plan is the last plan-like document among the last five that exist', () => {
  expect(planOf([])).toBeNull()
  expect(planOf(['~/README.md', '~/notes.md'])).toBeNull()
  expect(planOf(['~/old-plan.md', '~/brief.md', '~/README.md'])).toBe('~/brief.md')
  expect(planOf(['~/plan.md', '~/1.md', '~/2.md', '~/3.md', '~/4.md', '~/5.md'])).toBeNull()
  expect(planOf(['~/SPEC.md', '~/design-doc.md'])).toBe('~/design-doc.md')
})

test('documents are read from the last three exchanges, the opening, the tool calls and the final, in that order', () => {
  const old = Array.from({ length: 4 }, (_, i) => [typed(`~/gone${i}.md`, i), says('ok', i)]).flat()
  const rows = [...old, typed('~/recent-a.md', 5), says('~/recent-b.md', 5), typed('~/open.md', 6), uses('t', 'Read', { file_path: '~/read.md' }, 6), says('~/final.md', 7)]
  expect(namedDocs(readTurn(rows, '~/final.md'), '/home/u')).toEqual(['~/gone2.md', '~/gone3.md', '~/recent-a.md', '~/recent-b.md', '~/open.md', '~/read.md', '~/final.md'])
})
