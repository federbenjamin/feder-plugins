import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteRequest, On } from 'claude-code'
import { READER_PROMPT, SYNTH_PROMPT } from '../hooks/derive-prompts'
import { ROW_GREP_PATTERN } from '../hooks/derive'

const T0 = Date.parse('2026-10-20T12:00:00Z')
const PROJECTS = '/home/u/.claude/projects'
const DIR = '/tmp/ss'
const done = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const typedRow = (text: string, ts: string) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const agentRow = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const TRANSCRIPT = [
  typedRow('fix the login bug', '2026-10-19T09:00:00Z'),
  agentRow('Fixed. Shall I rename the public API too?'),
  typedRow('ask me before you rename anything public', '2026-10-19T09:05:00Z'),
  agentRow('Understood.'),
  typedRow('smallest fix, root cause', '2026-10-19T09:10:00Z'),
]
const OLD_FILE = '# Decisions (derived 2026-10-01, 1 sessions, 2 turns, 2026-10-01 to 2026-10-01)\n'
const VALID = [
  '# Decisions (derived anything)',
  '',
  'Decide everything you can yourself. Bring only what is listed under "Bring to me" to the operator.',
  '',
  '## Bring to me',
  '- Ask before renaming a public API. -- "ask me before you rename anything public" (2026-10-19)',
  '## How to decide',
].join('\n')

function world(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u', STOPSTOPPING_DIR: DIR })
  const w = {
    store: new Map<string, unknown>(),
    projects: ['-work-app'],
    listing: { inFlight: 0, most: 0 },
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    spawned: [] as string[][],
    // Held until released: the reader call waits on it, so a test can act mid-run.
    readerGate: undefined as Promise<void> | undefined,
    files: new Map<string, string>(),
    writes: [] as string[],
    logged: [] as string[],
    asked: [] as string[],
    answer: 'Cancel',
    requests: [] as ModelCompleteRequest[],
    reader: '',
    synthesis: VALID,
    runs: [] as string[][],
  }
  on('store.get', async (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', async (_$, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 'sess-1' }))
  on('fs.exists', async (_$, e) => ({ value: e.path.endsWith('.log') || w.files.has(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    w.writes.push(e.path)
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    if (e.path === PROJECTS) return { value: w.projects.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
    if (!e.path.startsWith(`${PROJECTS}/`)) throw new Error('ENOENT')
    w.listing.most = Math.max(w.listing.most, ++w.listing.inFlight)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    w.listing.inFlight--
    if (e.path === `${PROJECTS}/-work-app`) {
      return {
        value: [
          { name: 'sess-a.jsonl', kind: 'file' as const, size: 1, mtimeMs: T0, isLink: false },
          { name: 'sess-a', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false },
        ],
      }
    }
    return { value: [] }
  })
  on('process.run', async (_$, e) => {
    w.runs.push([...e.argv])
    if (e.argv[0] === 'tee') w.logged.push(e.init?.stdin ?? '')
    if (e.argv[0] === 'rm' && e.argv[1] === '-f') w.files.delete(e.argv[2]!)
    return { value: done }
  })
  // The host's grep: the lines that match the pattern it is handed (plain alternation, where
  // grep -E and a JS RegExp agree), in pieces that cut a line in two.
  on('process.spawn', async function* (_$, e) {
    w.spawned.push([...e.argv])
    if (e.argv[0] !== 'grep' || e.argv[2] !== '-E') throw new Error('unexpected spawn')
    const pattern = new RegExp(e.argv[3]!)
    const lines = TRANSCRIPT.map(r => JSON.stringify(r)).filter(l => pattern.test(l))
    const text = lines.length > 0 ? `${lines.join('\n')}\n` : ''
    const cut = Math.floor(text.length / 2)
    yield { stream: 'stdout' as const, text: text.slice(0, cut) }
    yield { stream: 'stdout' as const, text: text.slice(cut) }
    return { value: { code: 0, signal: null } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const question = e.questions[0]!.question
    w.asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: w.answer } } }
  })
  on('model.complete', async (_$, e) => {
    w.requests.push(e)
    if (e.system === READER_PROMPT && w.readerGate) await w.readerGate
    return { value: { isAnswered: true as const, text: e.system === READER_PROMPT ? w.reader : w.synthesis, usage } }
  })
  on('ui.status', async (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  return { w, clock }
}

const run = (args: string) => ({ command: 'stop-judge', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })
const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/tmp', surface: isInteractive ? 'terminal' : null, isInteractive })
const finding = (quote: string, side = 'bring') => JSON.stringify({ side, topic: 'renaming', claim: 'Ask first.', quote, session: 'sess-a', turn: 2, strength: 'strong' })

test('derive refuses in a non-interactive session without asking', async ($, on) => {
  const { w } = world(on)
  await start($, false)
  expect((await $.command.run(run('derive'))).text).toBe('derive needs an interactive session')
  expect(w.asked).toEqual([])
  expect(w.requests).toEqual([])
})

test('Cancel logs derive-cancelled, calls no model and writes nothing', async ($, on) => {
  const { w } = world(on)
  await start($)
  expect((await $.command.run(run('derive'))).text).toBe('derive cancelled')
  expect(w.asked).toEqual(['1 sessions, 3 of 3 typed turns, ~$0.30. Run?'])
  expect(w.logged.map(l => l.split(' ')[1])).toEqual(['derive-cancelled'])
  expect(w.logged[0]).toContain(' derive-cancelled session=sess-1 ms=0 reason=sessions=1 turns=3\n')
  expect(w.requests).toEqual([])
  expect(w.writes).toEqual([])
})

test('Run reads, keeps only the verifiable quote, and writes .prev, the file, then last-run.json', async ($, on) => {
  const { w, clock } = world(on)
  w.answer = 'Run'
  w.files.set(`${DIR}/DECISIONS.md`, OLD_FILE)
  w.reader = [finding('ask me before you rename anything public'), finding('words nobody typed')].join('\n')
  await start($)
  expect((await $.command.run(run('derive'))).text).toBe('derive: 1 batches in the background; the status line counts them')
  for (let i = 0; i < 20 && !w.writes.includes(`${DIR}/last-run.json`); i++) await clock.settle()
  expect(w.requests.map(r => r.system)).toEqual([READER_PROMPT, SYNTH_PROMPT])
  expect(w.requests[0]).toMatchObject({ model: 'sonnet', maxTokens: 8000 })
  const synthInput = String(w.requests[1]?.prompt)
  expect(synthInput).toContain('ask me before you rename anything public')
  expect(synthInput).not.toContain('words nobody typed')
  expect(synthInput).toContain(OLD_FILE.trim())
  expect(w.writes).toEqual([`${DIR}/DECISIONS.md.prev`, `${DIR}/DECISIONS.md`, `${DIR}/last-run.json`])
  expect(w.files.get(`${DIR}/DECISIONS.md.prev`)).toBe(OLD_FILE)
  const file = w.files.get(`${DIR}/DECISIONS.md`) ?? ''
  expect(file.split('\n')[0]).toBe('# Decisions (derived 2026-10-20, 1 sessions, 3 turns, 2026-10-19 to 2026-10-19)')
  expect(file).toContain('- Ask before renaming a public API. -- "ask me before you rename anything public" (2026-10-19)')
  expect(JSON.parse(w.files.get(`${DIR}/last-run.json`) ?? '{}')).toMatchObject({ sessions: 1, turns: 3, batches: 1 })
  expect(w.logged.at(-1)).toMatch(/ derive session=sess-1 ms=0 reason=sessions=1 turns=3 batches=1 cost=\$\d+\.\d\d /)
})

test('an invalid synthesis is logged and the old file is kept', async ($, on) => {
  const { w, clock } = world(on)
  w.answer = 'Run'
  w.files.set(`${DIR}/DECISIONS.md`, OLD_FILE)
  w.reader = finding('ask me before you rename anything public')
  w.synthesis = 'Here is the file you asked for.'
  await start($)
  await $.command.run(run('derive'))
  for (let i = 0; i < 20 && !w.logged.some(l => l.includes('derive-error')); i++) await clock.settle()
  expect(w.logged.at(-1)).toMatch(/ derive-error session=sess-1 ms=0 reason=line 3: Here is the file you asked for\.\n$/)
  expect(w.writes).toEqual([])
  expect(w.files.get(`${DIR}/DECISIONS.md`)).toBe(OLD_FILE)
})

test('context off writes the flag file the SessionStart hook reads; context on removes it', async ($, on) => {
  const { w } = world(on)
  await start($)
  expect((await $.command.run(run('context off'))).text).toContain('context off')
  expect(w.writes).toEqual([`${DIR}/context-off`])
  expect((await $.command.run(run(''))).text).toContain('context: off')
  await $.command.run(run('context on'))
  expect(w.runs.at(-1)).toEqual(['rm', '-f', `${DIR}/context-off`])
  expect((await $.command.run(run(''))).text).toContain('context: on')
})

test('status reports context from the flag file the hook obeys, whoever made or removed it, and nothing stores a copy', async ($, on) => {
  const { w } = world(on)
  await start($)
  await $.command.run(run('context off'))
  w.files.delete(`${DIR}/context-off`) // removed by hand
  expect((await $.command.run(run(''))).text).toContain(' · context: on · ')
  w.files.set(`${DIR}/context-off`, '') // made by hand, or by the other install
  expect((await $.command.run(run(''))).text).toContain(' · context: off · ')
  await $.command.run(run('off'))
  await $.command.run(run('context on'))
  expect(w.store.get('settings')).toEqual({ isOff: true })
})

test('a derive run ending puts the judge-off marker set during the run back on the status line', async ($, on) => {
  const { w, clock } = world(on)
  w.answer = 'Run'
  w.reader = finding('ask me before you rename anything public')
  let release = () => {}
  w.readerGate = new Promise<void>(resolve => (release = resolve))
  await start($)
  await $.command.run(run('derive'))
  await $.command.run(run('off'))
  expect(w.statuses.at(-1)).toBe('stop-judge off · derive 0/1')
  release()
  for (let i = 0; i < 20 && !w.writes.includes(`${DIR}/last-run.json`); i++) await clock.settle()
  for (let i = 0; i < 5; i++) await clock.settle()
  expect(w.statuses).toContain('stop-judge off · derive 1/1')
  expect(w.toasts).toEqual(['derive done: 1 bullets'])
  expect(w.statuses.at(-1)).toBe('stop-judge off')
})

test('a failed derive run toasts the failure and clears its progress from the status line', async ($, on) => {
  const { w, clock } = world(on)
  w.answer = 'Run'
  w.reader = finding('ask me before you rename anything public')
  w.synthesis = 'Here is the file you asked for.'
  await start($)
  await $.command.run(run('derive'))
  for (let i = 0; i < 20 && w.toasts.length === 0; i++) await clock.settle()
  expect(w.toasts).toEqual(['derive failed: invalid file, old one kept'])
  expect(w.statuses.at(-1)).toBe(undefined)
})

test('the scan hands grep the row pattern, and the rows it matches carry the typed turns', async ($, on) => {
  const { w } = world(on)
  await start($)
  await $.command.run(run('derive'))
  expect(w.spawned).toEqual([['grep', '-a', '-E', ROW_GREP_PATTERN, `${PROJECTS}/-work-app/sess-a.jsonl`]])
  expect(w.asked).toEqual(['1 sessions, 3 of 3 typed turns, ~$0.30. Run?'])
})

test('session start logs the size of the file the hook prints, and nothing while context is off', async ($, on) => {
  const { w } = world(on)
  w.files.set(`${DIR}/DECISIONS.md`, VALID)
  await start($)
  expect(w.logged).toHaveLength(1)
  expect(w.logged[0]).toContain(` context session=sess-1 ms=0 reason=chars=${VALID.length}\n`)
  w.files.set(`${DIR}/context-off`, '')
  await start($)
  expect(w.logged).toHaveLength(1)
})

test('status takes the DECISIONS.md date from the header parseDecisions reads, and says undated for any other first line', async ($, on) => {
  const { w } = world(on)
  await start($)
  w.files.set(`${DIR}/DECISIONS.md`, `${OLD_FILE}\n- a line\n`)
  expect((await $.command.run(run(''))).text).toContain('DECISIONS.md: 2 lines (2026-10-01)')
  w.files.set(`${DIR}/DECISIONS.md`, '# Decisions (derived 2026-10-05)\n')
  expect((await $.command.run(run(''))).text).toContain('DECISIONS.md: 1 lines (undated)')
})

test('the scan lists the project folders POOL at once, and every folder still counts', async ($, on) => {
  const { w } = world(on)
  w.projects = ['-a', '-b', '-work-app', '-c', '-d', '-e']
  await start($)
  await $.command.run(run('derive'))
  expect(w.listing.most).toBe(4)
  expect(w.asked).toEqual(['1 sessions, 3 of 3 typed turns, ~$0.30. Run?'])
})
