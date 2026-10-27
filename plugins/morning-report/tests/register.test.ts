import { test, expect, mock, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { jobPluginCheck, launchdNames, MANUAL_RUN_TEXT, renderPlist } from '../hooks/launchd.ts'
import { SCAN_NO_SESSIONS, SCAN_UNREADABLE, SETUP_NO_PROFILE, SETUP_USAGE, SUMMARY_NO_PROFILE, type Session } from '../hooks/pipeline.ts'

const DATA = '/data'
const RUNS = `${DATA}/runs`
const SCAN_PATH = `${RUNS}/setup-scan.md`
const OPTIONS = { options: { dataDir: DATA, setupDays: 1 } }
const TOOL = 'mcp__morning-report__morning_setup_scan'
const DAY_MS = 24 * 3600_000

const PROMPTS: Record<string, string> = {
  'summarizer.md': 'SUMMARIZER profile={{PROFILE}}',
  'setup-scan.md': 'SCAN SYSTEM',
  'morning-setup.md': 'SETUP preview={{PREVIEW}} profile={{PROFILE}}',
  'status.md': 'STATUS SYSTEM',
  'patterns.md': 'PATTERNS watch={{WATCH_FOR}}',
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const small = (id: string): Session => ({ id, project: '/p', start: 's', end: 'e', typed: 1, active_minutes: 5, text: `small ${id}` })
const big = (id: string): Session => ({ ...small(id), text: `big ${id} ${'x'.repeat(3_000)}` })

const extractOf = (sessions: Session[]) =>
  JSON.stringify({ sessions, active_minutes: 5 * sessions.length, projects: sessions.length ? [{ project: '/p', active_minutes: 5 * sessions.length }] : [] })

type Proc = { exitCode: number; stdout?: string; stderr?: string }
type ModelCall = { model: string; system: string; prompt: string }
type ModelAnswer = { isAnswered: true; text: string } | { isAnswered: false }

const HOME = '/home'
const ENV = { HOME, PATH: '/usr/bin:/bin' }

type World = {
  extract?: string | Proc | Error
  profile?: string | Error
  files?: Record<string, string>
  mtimes?: Record<string, number>
  env?: Record<string, string>
  proc?: (argv: readonly string[]) => Proc | undefined
  model?: (call: ModelCall) => ModelAnswer | Promise<ModelAnswer>
  submit?: (text: string) => Promise<{ drop: string } | { text: string }>
  registerTool?: Error
  home?: Error
}

type ToolSeen = { name: string; description: string; inputSchema: unknown }

type Seen = {
  argv: string[][]
  cwds: (string | undefined)[]
  models: ModelCall[]
  writes: Map<string, string>
  submits: string[]
  toasts: string[]
  status: (string | undefined)[]
  tools: ToolSeen[]
  // The firing-log lines appended under the state dir, kept apart from the data writes.
  log: string[]
}

const STATE_DIR = `${HOME}/.claude/stopstopping`

function world(on: On, w: World = {}): Seen {
  const seen: Seen = { argv: [], cwds: [], models: [], writes: new Map(), submits: [], toasts: [], status: [], tools: [], log: [] }
  on('session.id', async () => ({ value: 'sess-1' }))
  const files: Record<string, string> = { ...w.files }
  if (typeof w.profile === 'string') files[`${DATA}/profile.md`] = w.profile
  const homeFails = w.home
  if (homeFails) on('env.get', async () => ({ deny: homeFails.message }) as never)
  else mock.env(on, w.env ?? ENV)
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'tee' && e.argv[2]?.startsWith(STATE_DIR)) {
      seen.log.push(e.init?.stdin ?? '')
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    seen.argv.push([...e.argv])
    seen.cwds.push(e.init?.cwd)
    const own = w.proc?.(e.argv)
    const given = w.extract
    if (!own && e.argv[0] === 'python3' && given instanceof Error) return { deny: given.message } as never
    const extract: Proc = typeof given === 'string' || given === undefined || given instanceof Error ? { exitCode: 0, stdout: typeof given === 'string' ? given : extractOf([]) } : given
    const r = own ?? (e.argv[0] === 'python3' ? extract : { exitCode: 0 })
    return { value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', async (_$, e) => ({ value: e.path in files || (e.path === `${DATA}/profile.md` && w.profile instanceof Error) }))
  on('fs.list', async (_$, e) => ({
    value: Object.keys(files)
      .filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/'))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }) as never)
  on('fs.stat', async (_$, e) => ({ value: { kind: 'file', size: 0, mtimeMs: w.mtimes?.[e.path] ?? 0 } }) as never)
  on('fs.read', async (_$, e) => {
    if (e.path === `${DATA}/profile.md` && w.profile instanceof Error) return { deny: w.profile.message }
    const prompt = /\/prompts\/([^/]+)$/.exec(e.path)?.[1]
    if (prompt !== undefined && prompt in PROMPTS) return { value: PROMPTS[prompt]! }
    if (e.path in files) return { value: files[e.path]! }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.write', async (_$, e) => {
    if (e.path.startsWith(STATE_DIR)) return { value: undefined }
    seen.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('model.complete', async (_$, e) => {
    const call = { model: e.model, system: e.system ?? '', prompt: e.prompt }
    seen.models.push(call)
    const answer = (await w.model?.(call)) ?? { isAnswered: true, text: '# Setup scan\nbody' }
    return {
      value: answer.isAnswered
        ? { isAnswered: true, text: answer.text, usage: USAGE }
        : { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE },
    } as never
  })
  on('ui.status', async (_$, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => {
    seen.submits.push(e.text)
    return (await (w.submit?.(e.text) ?? Promise.resolve({ text: e.text }))) as never
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', async (_$, e) => {
    if (w.registerTool) return { deny: w.registerTool.message } as never
    seen.tools.push({ name: e.name, description: e.description, inputSchema: e.inputSchema })
    return { value: { tool: `mcp__morning-report__${e.name}` } } as never
  })
  return seen
}

const setup = async ($: Engine, args = '') =>
  (await $.command.run({ command: 'morning-setup', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text

const scan = async ($: Engine, input: Record<string, unknown> = { days: 1 }): Promise<unknown> => {
  const r = await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_1', ...input })
  return r.deny !== undefined ? `deny: ${r.deny}` : r.result
}

const ran = (seen: Seen, program: string) => seen.argv.filter(a => a[0] === program).length

// The days each extract window spans, read off its --since and --until.
const windowDays = (seen: Seen) =>
  seen.argv
    .filter(a => a[0] === 'python3')
    .map(a => (Date.parse(a[a.indexOf('--until') + 1]!) - Date.parse(a[a.indexOf('--since') + 1]!)) / DAY_MS)

const PREVIEW_TWO = '2 sessions over the last 1 day: 2 summary calls on sonnet, then 1 opus call'

test('/morning-setup submits the interview at once with the preview filled, and makes no model call and writes nothing', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { extract: extractOf([small('a'), big('b')]) })
  expect(await setup($)).toBe(`starting the setup interview; ${PREVIEW_TWO}`)
  await clock.settle()
  expect(seen.submits).toEqual([`SETUP preview=${PREVIEW_TWO} profile=${SETUP_NO_PROFILE}`])
  expect(seen.models).toEqual([])
  expect(seen.writes.size).toBe(0)
  expect(windowDays(seen)).toEqual([1])
})

test('/morning-setup with blank arguments starts the same interview and runs no scan', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { extract: extractOf([small('a'), big('b')]), profile: 'mine', files: { [SCAN_PATH]: '# Setup scan' } })
  for (const args of ['', '  ']) {
    expect(await setup($, args)).toBe(`starting the setup interview; ${PREVIEW_TWO}`)
  }
  await clock.settle()
  expect(seen.submits).toEqual(Array(2).fill(`SETUP preview=${PREVIEW_TWO} profile=mine`))
  expect(seen.models).toEqual([])
  expect(seen.writes.size).toBe(0)
  expect(windowDays(seen)).toEqual([1, 1])
})

test('/morning-setup over an empty window fills the no-sessions preview and makes no model call', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  expect(await setup($)).toBe('starting the setup interview; (no sessions in the last 1 day)')
  await clock.settle()
  expect(seen.submits).toEqual([`SETUP preview=(no sessions in the last 1 day) profile=${SETUP_NO_PROFILE}`])
  expect(seen.submits[0]!.startsWith(`SETUP preview=${SCAN_NO_SESSIONS}`)).toBe(true)
  expect(seen.models).toEqual([])
})

for (const [why, extract, reason] of [
  ['exits non-zero', { exitCode: 1, stderr: 'boom' }, 'extract failed: boom'],
  ['cannot start', new Error('python3: command not found'), 'morning-report: $.process.run: python3: command not found'],
  ['prints a changed shape', JSON.stringify({ sessions: [], active_minutes: 0, projects: [{ project: '/p' }] }), 'extract output: projects[0].active_minutes is missing or not a number'],
] as const) {
  test(`/morning-setup whose extract ${why} still submits the interview with nothing to read, and names the reason`, OPTIONS, async ($, on) => {
    const clock = mock.clock(on)
    const seen = world(on, { extract, profile: 'mine' })
    expect(await setup($)).toBe(`starting the setup interview; ${SCAN_UNREADABLE}; ${reason}`)
    await clock.settle()
    expect(seen.submits).toEqual([`SETUP preview=${SCAN_UNREADABLE} profile=mine`])
    expect(seen.submits[0]!.startsWith(`SETUP preview=${SCAN_NO_SESSIONS}`)).toBe(true)
    expect(seen.models).toEqual([])
    expect(seen.writes.size).toBe(0)
  })
}

test('a dropped interview prompt shows a toast naming the command', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { submit: async () => ({ drop: 'busy' }) })
  await setup($)
  await clock.settle()
  expect(seen.toasts).toEqual(['morning-report: /morning-setup prompt was dropped: busy'])
})

test('a rejected interview prompt shows a toast naming the command', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { submit: async () => Promise.reject(new Error('no session')) })
  await setup($)
  await clock.settle()
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]!.startsWith('morning-report: /morning-setup prompt failed: ')).toBe(true)
})

test('the scan tool writes the scan, returns its path, and submits nothing', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { extract: extractOf([small('a')]), profile: 'my profile' })
  expect(await scan($)).toBe(SCAN_PATH)
  await clock.settle()
  expect(seen.models.map(c => c.system)).toEqual([`SUMMARIZER profile=${SUMMARY_NO_PROFILE}`, 'SCAN SYSTEM'])
  expect(seen.writes.get(SCAN_PATH)).toBe('# Setup scan\nbody\n')
  expect(seen.submits).toEqual([])
  expect(seen.status[0]).toBe('morning-report: 1 session over the last 1 day: 1 summary call on sonnet, then 1 opus call')
  expect(seen.status.at(-1)).toBeUndefined()
})

test('the scan tool reads the days it is given, not setupDays, clamped to 1-7', { options: { dataDir: DATA, setupDays: 7 } }, async ($, on) => {
  const seen = world(on, { extract: extractOf([small('a')]) })
  for (const days of [1, 3, 12, 0, 2.5]) expect(await scan($, { days })).toBe(SCAN_PATH)
  expect(windowDays(seen)).toEqual([1, 3, 7, 1, 2])
  expect(seen.models.filter(c => c.model === 'opus').map(c => /\((\d+) days?\)/.exec(c.prompt)?.[1])).toEqual(['1', '3', '7', '1', '2'])
})

test('a scan with a few sessions not summarized says so in its result and in the scan file', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    extract: extractOf([small('a'), small('b'), small('c'), big('d'), big('e')]),
    model: c => (c.prompt.includes('session d') ? { isAnswered: false } : { isAnswered: true, text: c.model === 'opus' ? '# Setup scan\nbody' : 'ok' }),
  })
  const result = scan($)
  for (let i = 0; i < 20; i++) await clock.settle()
  expect(await result).toBe(`${SCAN_PATH} (1 session not summarized)`)
  expect(seen.writes.get(SCAN_PATH)).toContain('1 of 5 sessions could not be summarized, so Habits covers only part of the window')
  expect(seen.submits).toEqual([])
})

test('a scan fails when the failed batch holds most of the sessions, though it is one batch of three', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    extract: extractOf([small('a'), small('b'), small('c'), big('d'), big('e')]),
    model: c => (c.prompt.includes('session a') ? { isAnswered: false } : { isAnswered: true, text: 'ok' }),
  })
  const result = scan($)
  for (let i = 0; i < 20; i++) await clock.settle()
  expect(await result).toBe('setup scan failed: 3 of 5 summaries failed: sonnet call failed: api-error 529 overloaded')
  expect(seen.writes.has(SCAN_PATH)).toBe(false)
  expect(seen.submits).toEqual([])
})

test('the scan tool over an empty window returns the no-sessions text and makes no model call', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  expect(await scan($)).toBe('(no sessions in the last 1 day)')
  await clock.settle()
  expect(seen.models).toEqual([])
  expect(seen.submits).toEqual([])
  expect(seen.writes.has(SCAN_PATH)).toBe(false)
})

for (const [failing, why] of [
  ['mkdir', 'mkdir: /data/runs: File exists'],
  ['test', ''],
] as const) {
  test(`a scan whose runs folder cannot be written (${failing} fails) stops before the extract and any model call`, OPTIONS, async ($, on) => {
    const seen = world(on, {
      extract: extractOf([small('a')]),
      proc: argv => (argv[0] === failing ? { exitCode: 1, stderr: why } : undefined),
    })
    const result = await scan($)
    expect(result).toBe(`setup scan failed: cannot write to ${RUNS}${why ? `: ${why}` : ''}`)
    expect(ran(seen, 'python3')).toBe(0)
    expect(seen.models).toEqual([])
    expect(await scan($)).toBe(result)
  })
}

test('a second scan while one runs is refused, and the next one after it ends runs', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  let calls = 0
  const seen = world(on, {
    extract: extractOf([small('a')]),
    model: async c => {
      if (c.model === 'sonnet' && calls++ === 0) await held
      return { isAnswered: true, text: '# Setup scan\nbody' }
    },
  })
  const first = scan($)
  while (seen.models.length === 0) await clock.settle()
  expect(await scan($, { days: 2 })).toBe('a setup scan is already running')
  release()
  expect(await first).toBe(SCAN_PATH)
  expect(await scan($)).toBe(SCAN_PATH)
  expect(seen.models.filter(c => c.model === 'opus').length).toBe(2)
})

test('a scan that fails clears the running flag, so the next scan runs', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  let fail = true
  world(on, {
    extract: extractOf([small('a')]),
    model: c => (c.model === 'opus' && fail ? { isAnswered: false } : { isAnswered: true, text: '# Setup scan\nbody' }),
  })
  const first = scan($)
  for (let i = 0; i < 20; i++) await clock.settle()
  expect(await first).toBe('setup scan failed: opus call failed: api-error 529 overloaded')
  fail = false
  expect(await scan($)).toBe(SCAN_PATH)
})

test('/morning-setup with an argument other than schedule or remove gets the usage line and starts no extract and no model call', OPTIONS, async ($, on) => {
  const seen = world(on, { extract: extractOf([small('a')]) })
  for (const args of ['scan', 'scan 1', 'goals', 'schedule now']) {
    expect(await setup($, args)).toBe(SETUP_USAGE)
  }
  expect(ran(seen, 'python3')).toBe(0)
  expect(seen.models).toEqual([])
})

test('an extract whose shape changed fails the scan, naming the key, before any model call', OPTIONS, async ($, on) => {
  const seen = world(on, {
    extract: JSON.stringify({ sessions: [small('a')], active_minutes: 5, projects: [{ project: '/p', minutes: 5 }] }),
  })
  expect(await scan($)).toBe('setup scan failed: extract output: projects[0].active_minutes is missing or not a number')
  expect(seen.models).toEqual([])
})

test('a setup whose config cannot be read answers with its failure line, from the command and from the tool', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { extract: extractOf([small('a')]), home: new Error('no env') })
  const command = await setup($)
  expect(command?.startsWith('morning-setup failed: ')).toBe(true)
  expect(command).toContain('no env')
  const tool = await scan($)
  expect(typeof tool === 'string' && tool.startsWith('setup scan failed: ')).toBe(true)
  expect(tool).toContain('no env')
  await clock.settle()
  expect(ran(seen, 'python3')).toBe(0)
  expect(seen.models).toEqual([])
  expect(seen.submits).toEqual([])
})

const START = { cwd: '/', surface: null, isInteractive: true }

test('session.start registers the morning_setup_scan tool with a days input of 1 to 7', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine' })
  on('session.start', async () => ({ cwd: '/' }))
  await $.session.start(START)
  expect(seen.tools.map(t => t.name)).toEqual(['morning_setup_scan'])
  expect(seen.tools[0]!.inputSchema).toEqual({
    type: 'object',
    properties: { days: { type: 'integer', minimum: 1, maximum: 7 } },
    required: ['days'],
    additionalProperties: false,
  })
  expect(seen.tools[0]!.description).toContain('/morning-setup')
  expect(seen.toasts).toEqual([])
})

test('session.start whose tool registration is refused says so and still calls next', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine', registerTool: new Error('name taken') })
  let reached = false
  on('session.start', async () => {
    reached = true
    return { cwd: '/' }
  })
  await $.session.start(START)
  expect(reached).toBe(true)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]!.startsWith('morning_setup_scan not registered: ')).toBe(true)
})

test('session.start with an unreadable profile still calls next and says the profile could not be read', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: new Error('EISDIR: illegal operation on a directory') })
  let reached = false
  on('session.start', async () => {
    reached = true
    return { cwd: '/' }
  })
  await $.session.start(START)
  expect(reached).toBe(true)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]!.startsWith(`morning-report: could not read ${DATA}/profile.md: `)).toBe(true)
  expect(seen.toasts[0]).toContain('EISDIR')
})

test('session.start says to run /morning-setup only when there is no profile', OPTIONS, async ($, on) => {
  const seen = world(on)
  on('session.start', async () => ({ cwd: '/' }))
  await $.session.start(START)
  expect(seen.toasts).toEqual(['morning-report: run /morning-setup to start'])
})

test('session.start with a profile shows no setup toast', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine' })
  on('session.start', async () => ({ cwd: '/' }))
  await $.session.start(START)
  expect(seen.toasts).toEqual([])
})

const SUMMARY = '## a — did a thing'
const touched = (day: string) => `## parser\n- repo: p (\`/p\`)\n- what: the parser\n- landed: the lexer\n- left: the grammar\n- waits on: the agent\n- last touched: ${day}`
const PATTERNS_ANSWER = '### Going well\n- asked once (session aaaaaaaa)\n\n### Not working\n- Nothing seen.'
const PROFILE = '## Watch for\n- re-asking'
type Answers = { status?: string; patterns?: string }
// The status and patterns calls answer by their system prompt; the summary calls answer SUMMARY.
const answers = (a: Answers = {}) => (call: ModelCall): ModelAnswer => ({
  isAnswered: true,
  text: call.system.startsWith('STATUS') ? (a.status ?? touched(TODAY_LOCAL())) : call.system.startsWith('PATTERNS') ? (a.patterns ?? PATTERNS_ANSWER) : SUMMARY,
})
// The firing log stamps its line with the engine clock, which a test must set.
const runWorld = (on: On, w: World) => {
  mock.clock(on, { now: Date.now() })
  return world(on, w)
}
const callsOf = (seen: Seen, prefix: string) => seen.models.filter(m => m.system.startsWith(prefix))

const morningRun = async ($: Engine, args = ''): Promise<string> =>
  (await $.command.run({ command: 'morning-run', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text ?? ''

const TODAY_LOCAL = () => {
  const now = Date.now()
  return new Date(now - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}
const daysBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10)

test('/morning-run writes the summaries, the dated status, status.md, the patterns entry and the run record, then state.json, and no narrative', OPTIONS, async ($, on) => {
  const seen = runWorld(on, { extract: extractOf([small('a'), small('b')]), profile: PROFILE, files: { [RUNS]: '' }, model: answers() })
  const today = TODAY_LOCAL()
  expect(await morningRun($)).toBe(`wrote ${DATA}/status.md (1 stream) and ${DATA}/patterns.md`)
  expect([...seen.writes.keys()]).toEqual([
    `${RUNS}/${today}-summaries.md`,
    `${RUNS}/${today}-status.md`,
    `${DATA}/status.md`,
    `${DATA}/patterns.md`,
    `${RUNS}/${today}-run.json`,
    `${DATA}/state.json`,
  ])
  expect(seen.writes.has(`${DATA}/${today}.md`)).toBe(false)
  const status = seen.writes.get(`${DATA}/status.md`)!
  expect(status).toBe(seen.writes.get(`${RUNS}/${today}-status.md`)!)
  expect(status.startsWith(`# Status — ${today}\n`)).toBe(true)
  expect(status).toContain(touched(today))
  expect(seen.writes.get(`${DATA}/patterns.md`)).toContain(`## ${today}\n\n### Going well\n- asked once (session aaaaaaaa)\n\n### Not working\n- Nothing seen.`)
  const record = JSON.parse(seen.writes.get(`${RUNS}/${today}-run.json`)!)
  expect([record.sessions, record.streams, record.dropped, record.patterns]).toEqual([2, 1, 0, 'written'])
  expect(record.projects).toEqual([{ project: '/p', active_minutes: 10 }])
  expect(JSON.parse(seen.writes.get(`${DATA}/state.json`)!).reportDate).toBe(today)
  expect(callsOf(seen, 'STATUS').length).toBe(1)
  expect(callsOf(seen, 'PATTERNS').map(c => c.system)).toEqual(['PATTERNS watch=- re-asking'])
  expect(seen.models.find(c => c.system.startsWith('SUMMARIZER'))!.system).toBe(`SUMMARIZER profile=${PROFILE}`)
  expect(seen.log.map(l => l.split(' ')[1])).toEqual(['run-written'])
})

for (const [why, files] of [
  ['its run record exists', (today: string) => ({ [`${RUNS}/${today}-run.json`]: '{}' })],
  ['state.json names today', (today: string) => ({ [`${DATA}/state.json`]: JSON.stringify({ watermark: 'w', prevWatermark: 'p', reportDate: today }) })],
] as const) {
  test(`a second run on a day whose ${why} says already written and reads no session`, OPTIONS, async ($, on) => {
    const today = TODAY_LOCAL()
    const seen = runWorld(on, { extract: extractOf([small('a')]), profile: PROFILE, files: { [RUNS]: '', ...files(today) }, model: answers() })
    expect(await morningRun($)).toBe(`${today} already written (${RUNS}/${today}-run.json); /morning-run --force redoes it`)
    expect(ran(seen, 'python3')).toBe(0)
    expect(seen.models).toEqual([])
    expect(seen.writes.size).toBe(0)
    expect(seen.log.map(l => l.split(' ')[1])).toEqual(['run-already'])
  })
}

test('a forced rerun carries the newest earlier status, never its own day, and replaces its patterns entry', OPTIONS, async ($, on) => {
  const today = TODAY_LOCAL()
  const yesterday = daysBefore(today, 1)
  const patterns = `# Patterns\n\nheader\n\n## ${yesterday}\n\n### Going well\n- old\n\n### Not working\n- old\n\n## ${today}\n\n### Going well\n- first run\n\n### Not working\n- first run`
  const seen = runWorld(on, {
    extract: extractOf([small('a')]),
    profile: PROFILE,
    files: {
      [RUNS]: '',
      [`${RUNS}/${today}-run.json`]: '{}',
      [`${RUNS}/${today}-status.md`]: '## today-only-stream\n- last touched: 2026-01-01',
      [`${RUNS}/${daysBefore(today, 3)}-status.md`]: '## older-stream\n- last touched: 2026-01-01',
      [`${RUNS}/${yesterday}-status.md`]: `# Status — ${yesterday}\n\nintro\n\n## carried\n- what: kept\n- last touched: ${yesterday}`,
      [`${DATA}/patterns.md`]: patterns,
    },
    model: answers(),
  })
  await morningRun($, '--force')
  const prompt = callsOf(seen, 'STATUS')[0]!.prompt
  expect(prompt).toContain(`# Previous status (${yesterday})\n## carried\n- what: kept\n- last touched: ${yesterday}`)
  expect(prompt).not.toContain('today-only-stream')
  expect(prompt).not.toContain('older-stream')
  const written = seen.writes.get(`${DATA}/patterns.md`)!
  expect(written.split(`## ${today}`).length).toBe(2)
  expect(written).not.toContain('first run')
  expect(written).toContain('- asked once')
  expect(written.indexOf(`## ${yesterday}`)).toBeLessThan(written.indexOf(`## ${today}`))
})

test('a run with no profile still writes the status, makes no patterns call, and says why', OPTIONS, async ($, on) => {
  const today = TODAY_LOCAL()
  const seen = runWorld(on, { extract: extractOf([small('a')]), files: { [RUNS]: '' }, model: answers() })
  expect(await morningRun($)).toBe(`wrote ${DATA}/status.md (1 stream) and patterns skipped (no profile.md)`)
  expect(callsOf(seen, 'PATTERNS')).toEqual([])
  expect(seen.models.find(c => c.system.startsWith('SUMMARIZER'))!.system).toBe(`SUMMARIZER profile=${SUMMARY_NO_PROFILE}`)
  expect(seen.writes.has(`${DATA}/patterns.md`)).toBe(false)
  expect(seen.writes.get(`${DATA}/status.md`)).toContain(touched(today))
  expect(JSON.parse(seen.writes.get(`${RUNS}/${today}-run.json`)!).patterns).toBe('skipped: no profile.md')
})

test('a profile with no Watch for list skips the patterns call', OPTIONS, async ($, on) => {
  const seen = runWorld(on, { extract: extractOf([small('a')]), profile: '## Working on\nthings\n\n## Watch for\n(none)', files: { [RUNS]: '' }, model: answers() })
  expect(await morningRun($)).toBe(`wrote ${DATA}/status.md (1 stream) and patterns skipped (no Watch for list in profile.md)`)
  expect(callsOf(seen, 'PATTERNS')).toEqual([])
})

for (const [why, a, reason] of [
  ['a status answer with no stream block', { status: 'Sorry, I ran out of room.' }, 'no stream block'],
  ['a status block without its last touched date', { status: '## parser\n- what: the parser' }, 'without a "last touched: YYYY-MM-DD" line (parser)'],
  ['a patterns answer without its lists', { patterns: 'All good.' }, 'lacks its Going well or Not working list'],
] as const) {
  test(`${why} fails the run, writes nothing, and keeps the watermark`, OPTIONS, async ($, on) => {
    const seen = runWorld(on, { extract: extractOf([small('a')]), profile: PROFILE, files: { [RUNS]: '' }, model: answers(a) })
    const text = await morningRun($)
    expect(text.startsWith('failed: ')).toBe(true)
    expect(text).toContain(reason)
    expect(seen.writes.size).toBe(0)
    expect(seen.log.map(l => l.split(' ')[1])).toEqual(['run-failed'])
  })
}

test('a quiet window makes no model call beyond none, carries the previous streams, and drops one silent for 30 days', OPTIONS, async ($, on) => {
  const today = TODAY_LOCAL()
  const yesterday = daysBefore(today, 1)
  const old = daysBefore(today, 30)
  const seen = runWorld(on, {
    profile: PROFILE,
    files: { [RUNS]: '', [`${RUNS}/${yesterday}-status.md`]: `## fresh\n- last touched: ${yesterday}\n\n## stale\n- last touched: ${old}` },
    model: answers(),
  })
  expect(await morningRun($)).toBe(`wrote ${DATA}/status.md (1 stream, 1 dropped) and patterns skipped (no sessions)`)
  expect(seen.models).toEqual([])
  const status = seen.writes.get(`${DATA}/status.md`)!
  expect(status).toContain(`## fresh\n- last touched: ${yesterday}`)
  expect(status).not.toContain('## stale')
  expect(status).toContain(`## Dropped\n- stale: last touched ${old}; dropped ${today}`)
  expect(seen.writes.has(`${DATA}/patterns.md`)).toBe(false)
})

test('a backfill writes that day\'s summaries only: no status, patterns, run record or state', OPTIONS, async ($, on) => {
  const seen = runWorld(on, { extract: extractOf([small('a')]), profile: PROFILE, files: { [RUNS]: '' }, model: answers() })
  expect(await morningRun($, '--backfill 2026-10-13 --until 2026-10-13T05:00:00Z')).toBe(`backfilled ${RUNS}/2026-10-13-summaries.md`)
  expect([...seen.writes.keys()]).toEqual([`${RUNS}/2026-10-13-summaries.md`])
  expect(callsOf(seen, 'STATUS')).toEqual([])
  expect(callsOf(seen, 'PATTERNS')).toEqual([])
  expect(seen.log.map(l => l.split(' ')[1])).toEqual(['run-backfill'])
})

test('the status prompt joins each session to its folder and the date of its last message', OPTIONS, async ($, on) => {
  const end = new Date().toISOString()
  const seen = runWorld(on, { extract: extractOf([{ ...small('abc'), project: '/work/abc', end }]), files: { [RUNS]: '' }, model: answers() })
  await morningRun($)
  expect(callsOf(seen, 'STATUS')[0]!.prompt).toContain(`- abc: /work/abc, last message ${TODAY_LOCAL()}`)
})

const NAMES = launchdNames(HOME, '501')
const MAC: Record<string, Proc> = {
  'uname -s': { exitCode: 0, stdout: 'Darwin\n' },
  'which claude': { exitCode: 0, stdout: '/bin/claude\n' },
  'id -u': { exitCode: 0, stdout: '501\n' },
  '/bin/sh -c': { exitCode: 0, stdout: 'enabled\n' },
}
// A Mac whose commands answer as MAC does, except the ones `over` names by their first two words.
const mac = (over: Record<string, Proc> = {}) => (argv: readonly string[]) => {
  const key = argv.slice(0, 2).join(' ')
  return over[key] ?? MAC[key]
}
const launchctlCalls = (seen: Seen) => seen.argv.filter(a => a[0] === 'launchctl').map(a => a.slice(1))

test('schedule on a system that is not macOS prints the manual line and runs nothing else', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac({ 'uname -s': { exitCode: 0, stdout: 'Linux\n' } }) })
  expect(await setup($, 'schedule')).toBe(MANUAL_RUN_TEXT)
  expect(seen.argv).toEqual([['uname', '-s']])
  expect(seen.writes.size).toBe(0)
})

for (const [why, w, text] of [
  ['uname -s fails', { proc: mac({ 'uname -s': { exitCode: 1, stdout: 'Darwin\n' } }) }, 'cannot schedule: `uname -s` failed or printed nothing'],
  ['uname -s prints nothing', { proc: mac({ 'uname -s': { exitCode: 0, stdout: '\n' } }) }, 'cannot schedule: `uname -s` failed or printed nothing'],
  ['which claude fails', { proc: mac({ 'which claude': { exitCode: 1 } }) }, 'cannot schedule: no claude on PATH (which claude found nothing)'],
  ['which claude prints nothing', { proc: mac({ 'which claude': { exitCode: 0, stdout: ' \n' } }) }, 'cannot schedule: no claude on PATH (which claude found nothing)'],
  ['id -u fails', { proc: mac({ 'id -u': { exitCode: 1, stdout: '501\n' } }) }, 'cannot schedule: `id -u` failed or printed nothing'],
  ['id -u prints nothing', { proc: mac({ 'id -u': { exitCode: 0, stdout: '' } }) }, 'cannot schedule: `id -u` failed or printed nothing'],
  ['HOME is unset', { proc: mac(), env: { PATH: ENV.PATH } }, 'cannot schedule: HOME is not set'],
  ['HOME is empty', { proc: mac(), env: { ...ENV, HOME: '' } }, 'cannot schedule: HOME is not set'],
  ['PATH is unset', { proc: mac(), env: { HOME } }, 'cannot schedule: PATH is not set'],
] as const) {
  test(`schedule refuses when ${why}, and writes no plist and calls no launchctl`, OPTIONS, async ($, on) => {
    const seen = world(on, w)
    expect(await setup($, 'schedule')).toBe(text)
    expect(seen.writes.size).toBe(0)
    expect(launchctlCalls(seen)).toEqual([])
    expect(ran(seen, 'mkdir')).toBe(0)
  })
}

const JOB_VIEW = (seen: string) =>
  `cannot schedule: the job clears every variable but HOME, PATH and the login ones (launchctl setenv included) and runs from ${HOME}, and there \`claude plugin list --json\` ${seen}. Install and enable the plugin for your user (not one project, not under CLAUDE_CONFIG_DIR), then schedule again`

for (const [why, check, text] of [
  ['the job would see no such plugin', { exitCode: 0, stdout: 'absent\n' }, JOB_VIEW('lists morning-report as absent')],
  ['the job would see the plugin disabled', { exitCode: 0, stdout: 'disabled\n' }, JOB_VIEW('lists morning-report as disabled')],
  ['the job would see the plugin list fail', { exitCode: 1, stdout: '', stderr: ' morning-report: claude plugin list failed (exit 2); the job stays\n' }, JOB_VIEW('failed: morning-report: claude plugin list failed (exit 2); the job stays')],
] as const) {
  test(`schedule refuses when ${why}, and writes no plist and calls no launchctl`, OPTIONS, async ($, on) => {
    const seen = world(on, { proc: mac({ '/bin/sh -c': check }) })
    expect(await setup($, 'schedule')).toBe(text)
    expect(seen.writes.size).toBe(0)
    expect(launchctlCalls(seen)).toEqual([])
    expect(ran(seen, 'mkdir')).toBe(0)
  })
}

test('schedule reports a failed bootstrap with the head of its stderr', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac({ 'launchctl bootstrap': { exitCode: 5, stderr: '  Bootstrap failed: 5: Input/output error\n' } }) })
  expect(await setup($, 'schedule')).toBe('launchctl bootstrap failed: Bootstrap failed: 5: Input/output error')
  expect(launchctlCalls(seen)).toEqual([['bootout', NAMES.target], ['bootstrap', NAMES.domain, NAMES.plist]])
})

test('schedule writes the plist, reloads the job, and its text names the hours the plist fires', { options: { ...OPTIONS.options, reportHour: 19 } }, async ($, on) => {
  const seen = world(on, { proc: mac() })
  const text = await setup($, 'schedule')
  const plist = seen.writes.get(NAMES.plist)!
  expect(plist).toBe(renderPlist({ claudePath: '/bin/claude', home: HOME, path: ENV.PATH, uid: '501', hour: 19, pluginName: 'morning-report' }))
  const hours = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map(m => m[1]!.padStart(2, '0'))
  expect(/ at (\d\d):00 and hourly until (\d\d):00 /.exec(text ?? '')?.slice(1)).toEqual([hours[0], hours.at(-1)])
  expect(text).toBe(
    `scheduled: com.morning-report runs claude -p /morning-run at 19:00 and hourly until 23:00 (${NAMES.plist}; log ${NAMES.log}). /morning-setup remove undoes it.`,
  )
  const check = jobPluginCheck({ claudePath: '/bin/claude', home: HOME, path: ENV.PATH, pluginName: 'morning-report' })
  const at = seen.argv.findIndex(a => a[0] === '/bin/sh')
  expect([seen.argv[at], seen.cwds[at]]).toEqual([check.argv, check.cwd])
  expect(at).toBeLessThan(seen.argv.findIndex(a => a[0] === 'mkdir'))
  expect(seen.argv.find(a => a[0] === 'mkdir')).toEqual(['mkdir', '-p', NAMES.logDir])
  expect(launchctlCalls(seen)).toEqual([['bootout', NAMES.target], ['bootstrap', NAMES.domain, NAMES.plist]])
})

const REMOVED = `removed the launchd job com.morning-report, ${NAMES.plist} and ${NAMES.logDir}. Your status, patterns, profile and run files are still in ${DATA}; delete that folder yourself if you want them gone.`

test('remove with nothing installed says so and runs no process', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac() })
  expect(await setup($, 'remove')).toBe(`nothing installed: no ${NAMES.plist}`)
  expect(seen.argv).toEqual([])
})

test('remove with no HOME refuses and runs no process', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac(), env: { PATH: ENV.PATH }, files: { [NAMES.plist]: '' } })
  expect(await setup($, 'remove')).toBe('cannot remove: HOME is not set')
  expect(seen.argv).toEqual([])
})

test('remove deletes a log folder left without a plist once launchctl has no job, and says nothing was installed', OPTIONS, async ($, on) => {
  const seen = world(on, {
    proc: mac({ 'launchctl bootout': { exitCode: 3, stderr: 'Boot-out failed: 3: No such process' }, 'launchctl print': { exitCode: 113 } }),
    files: { [NAMES.logDir]: '' },
  })
  expect(await setup($, 'remove')).toBe(`nothing installed: no ${NAMES.plist}; removed the leftover log folder ${NAMES.logDir}`)
  expect(seen.argv).toEqual([['id', '-u'], ['launchctl', 'bootout', NAMES.target], ['launchctl', 'print', NAMES.target], ['rm', '-rf', NAMES.logDir]])
})

test('remove unloads a job still loaded after its self-removal deleted the plist, then deletes the log folder', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac(), files: { [NAMES.logDir]: '' } })
  expect(await setup($, 'remove')).toBe(REMOVED)
  expect(seen.argv).toEqual([['id', '-u'], ['launchctl', 'bootout', NAMES.target], ['rm', '-rf', NAMES.logDir]])
})

for (const printExit of [0, 125]) {
  test(`remove keeps a log folder left without a plist and claims nothing when bootout fails and launchctl print exits ${printExit}`, OPTIONS, async ($, on) => {
    const seen = world(on, {
      proc: mac({ 'launchctl bootout': { exitCode: 5, stderr: 'Boot-out failed: 5: Input/output error' }, 'launchctl print': { exitCode: printExit } }),
      files: { [NAMES.logDir]: '' },
    })
    expect(await setup($, 'remove')).toBe('launchctl bootout failed: Boot-out failed: 5: Input/output error; nothing removed')
    expect(ran(seen, 'rm')).toBe(0)
  })
}

test('remove with a log folder left and id -u failing refuses and deletes nothing', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac({ 'id -u': { exitCode: 1 } }), files: { [NAMES.logDir]: '' } })
  expect(await setup($, 'remove')).toBe('cannot remove: `id -u` failed or printed nothing')
  expect(launchctlCalls(seen)).toEqual([])
  expect(ran(seen, 'rm')).toBe(0)
})

test('remove refuses when id -u fails, and calls no launchctl and deletes nothing', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac({ 'id -u': { exitCode: 1 } }), files: { [NAMES.plist]: '' } })
  expect(await setup($, 'remove')).toBe('cannot remove: `id -u` failed or printed nothing')
  expect(launchctlCalls(seen)).toEqual([])
  expect(ran(seen, 'rm')).toBe(0)
})

test('remove unloads the job before it deletes the plist and the log folder', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac(), files: { [NAMES.plist]: '', [NAMES.logDir]: '' } })
  expect(await setup($, 'remove')).toBe(REMOVED)
  expect(seen.argv).toEqual([['id', '-u'], ['launchctl', 'bootout', NAMES.target], ['rm', '-f', NAMES.plist], ['rm', '-rf', NAMES.logDir]])
})

test('remove goes on when bootout fails because launchctl has no such job', OPTIONS, async ($, on) => {
  const seen = world(on, {
    proc: mac({ 'launchctl bootout': { exitCode: 3, stderr: 'Boot-out failed: 3: No such process' }, 'launchctl print': { exitCode: 113 } }),
    files: { [NAMES.plist]: '' },
  })
  expect(await setup($, 'remove')).toBe(REMOVED)
  expect(launchctlCalls(seen)).toEqual([['bootout', NAMES.target], ['print', NAMES.target]])
  expect(seen.argv.filter(a => a[0] === 'rm')).toEqual([['rm', '-f', NAMES.plist], ['rm', '-rf', NAMES.logDir]])
})

for (const printExit of [0, 125]) {
  test(`remove keeps the plist and claims nothing when bootout fails and launchctl print exits ${printExit}`, OPTIONS, async ($, on) => {
    const seen = world(on, {
      proc: mac({ 'launchctl bootout': { exitCode: 5, stderr: ' Boot-out failed: 5: Input/output error\n' }, 'launchctl print': { exitCode: printExit } }),
      files: { [NAMES.plist]: '' },
    })
    expect(await setup($, 'remove')).toBe('launchctl bootout failed: Boot-out failed: 5: Input/output error; nothing removed')
    expect(ran(seen, 'rm')).toBe(0)
  })
}

test('the setup command and the scan tool each log one firing line with their outcome', OPTIONS, async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const seen = world(on, { extract: extractOf([small('a')]) })
  expect(await setup($, 'bogus words')).toBe(SETUP_USAGE)
  expect(await scan($)).toBe(SCAN_PATH)
  await clock.settle()
  expect(seen.log.map(l => l.split(' ')[1])).toEqual(['setup-usage', 'scan'])
})
