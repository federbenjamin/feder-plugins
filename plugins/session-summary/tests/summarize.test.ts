import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandSpec, ModelCompleteRequest, ModelCompleteResult, On, SessionMessage } from 'claude-code'
import { CONCISE_COMMAND, CONCISE_LABEL, CONCISE_USAGE, PLUGIN, TICK_MS } from '../hooks/config'
import { CONCISE_SYSTEM } from '../hooks/prompts'

const T0 = Date.parse('2026-10-23T12:00:00Z')
const DIR = '/tmp/state'
const ID = 'synthetic-session'
const LOG = `${DIR}/logs/${PLUGIN}.log`

const USAGE = { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const said = (text: string, usage = USAGE): ModelCompleteResult => ({ isAnswered: true, text, usage })
const TIMER_ANSWER = said('TITLE: Summary plugin\nLAST PROMPT: You asked.\nSO FAR: Building it.\nNOW: Testing it.\nFILES: ')

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const agent = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
// Well past the 1,500 characters the timer's window clips a message to.
const LONG_RESPONSE = `${Array.from({ length: 400 }, (_, i) => `finding ${i}`).join(' ')} END-OF-RESPONSE`
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

const PANE = { title: 'Session summary', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} }

function world(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { STOPSTOPPING_DIR: DIR })
  mock.store(on, {})
  const w = {
    clock,
    files: new Map<string, string>(),
    messages: [user('explain the findings'), agent(LONG_RESPONSE)] as SessionMessage[],
    // Concise replies are taken in order at the moment of the request, whatever the hold.
    replies: [] as ModelCompleteResult[],
    holds: [] as number[], // per concise request, in order: how long its reply is held
    isAbortIgnored: false,
    requests: [] as ModelCompleteRequest[],
    opened: [] as string[],
    engineScrolls: [] as number[],
    registered: [] as CommandSpec[],
    invalidated: [] as string[],
  }
  on('fs.exists', async (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', async (_$, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('fs.write', async (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    if (e.argv[0] !== 'tee' || e.argv[1] !== '-a') throw new Error('unexpected process command')
    const path = e.argv[2]!
    w.files.set(path, (w.files.get(path) ?? '') + (e.init?.stdin ?? ''))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', async () => ({ value: ID }))
  on('session.cwd', async () => ({ value: '/tmp/project' }))
  on('session.messages', async () => ({ value: [...w.messages] }))
  on('model.complete', async (_$, e, next) => {
    w.requests.push(e)
    if (e.system !== CONCISE_SYSTEM) return { value: TIMER_ANSWER }
    const reply = w.replies.shift() ?? said('A shorter copy.')
    const hold = w.holds.shift() ?? 0
    if (hold > 0 && w.isAbortIgnored) await clock.sleep(hold)
    else if (hold > 0) {
      // A held reply resolves aborted when its call's signal fires, as the engine's does.
      const aborted = new Promise<'aborted'>(resolve => next.signal.addEventListener('abort', () => resolve('aborted'), { once: true }))
      if ((await Promise.race([clock.sleep(hold).then(() => 'done' as const), aborted])) === 'aborted') return { value: { isAnswered: false, reason: 'aborted', usage: ZERO } }
    }
    return { value: reply }
  })
  // The engine's own scroll beneath the plugin: only a ui.scroll the plugin passes on reaches it.
  on('ui.scroll', async (_$, e) => {
    w.engineScrolls.push(e.by)
    return {}
  })
  on('command.register', async (_$, e) => {
    w.registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.invalidate', async (_$, e) => {
    w.invalidated.push(e.event)
    return { value: undefined }
  })
  on('ui.open', async (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  return w
}

type World = ReturnType<typeof world>

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/tmp/project', surface: isInteractive ? 'terminal' : null, isInteractive })
const summarize = ($: Engine) => $.command.run({ command: CONCISE_COMMAND, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const conciseRequests = (w: World) => w.requests.filter(r => r.system === CONCISE_SYSTEM)
const logLines = (w: World) => (w.files.get(LOG) ?? '').split('\n').filter(Boolean)
// Blank rows and scrollbar marks are not what a test reads.
const isContent = (text: string) => text !== ' ' && !/^[█│]$/.test(text)
const paneTexts = async ($: Engine, scroll = PANE.scroll) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: { ...PANE, scroll } })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(isContent)
  await ui.unmount()
  return texts
}
// The harness hands a ui.scroll hook exactly what $.ui.scroll is given, so the engine's own fields are spelled out.
const scroll = ($: Engine, by: number, bodyRows = PANE.scroll.bodyRows) =>
  $.ui.scroll({ component: 'Pane', requestId: PLUGIN, offset: 0, by, bodyRows, contentRows: 60, origin: { kind: 'person' } } as never)
const SECTION = `▾ ${CONCISE_LABEL}`
const sectionOf = (texts: string[]) => texts.slice(texts.findIndex(t => t.startsWith(SECTION)))

test('/summarize in an interactive session returns no text and no context, and sends the whole response to the model', async ($, on) => {
  const w = world(on)
  await start($)
  const result = await summarize($)
  expect(result.text).toBeUndefined()
  expect(result.context).toBeUndefined()
  await w.clock.settle()
  expect(w.opened).toEqual([PLUGIN, PLUGIN])
  const [request] = conciseRequests(w)
  expect(conciseRequests(w)).toHaveLength(1)
  expect(request!.prompt).toBe(`<message>\n${LONG_RESPONSE}\n</message>`)
  expect(String(request!.prompt)).toContain('finding 399 END-OF-RESPONSE')
  expect(request).toMatchObject({ model: 'sonnet', effort: 'low', maxTokens: 8_000 })
})

test('a non-interactive session makes no call, opens no pane, and says where the result shows', async ($, on) => {
  const w = world(on)
  await start($, false)
  const result = await summarize($)
  await w.clock.settle()
  expect(result.text).toMatch(/interactive sessions only/)
  expect(w.requests).toEqual([])
  expect(w.opened).toEqual([])
  expect(logLines(w)).toEqual([])
})

test('the pane shows the result below the other texts', async ($, on) => {
  const w = world(on)
  w.replies.push(said('Findings 0 to 399 listed.'))
  await start($)
  await summarize($)
  await w.clock.settle()
  expect(await paneTexts($)).toEqual(['No summary yet.', SECTION, 'just now', 'Findings 0 to 399 listed.'])
})

test('the section is placed under the timer\'s texts once a summary exists', async ($, on) => {
  const w = world(on)
  await start($)
  await $.turn.start({ text: 'explain the findings', turnId: 't1' })
  await w.clock.advance(90_000)
  await summarize($)
  await w.clock.settle()
  const texts = await paneTexts($)
  expect(texts.indexOf('Summary plugin')).toBe(0)
  expect(texts.indexOf(SECTION)).toBeGreaterThan(texts.indexOf('SO FAR'))
  expect(texts.at(-1)).toBe('A shorter copy.')
})

test('a ui.scroll over an overlong section moves the section and leaves the top rows unchanged', async ($, on) => {
  const w = world(on)
  w.replies.push(said(lines(40)))
  await start($)
  await summarize($)
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(isContent)
  // The header and 40 lines are one list of 41 rows in a window of 18.
  const before = await texts()
  expect(before.slice(0, 3)).toEqual(['No summary yet.', SECTION, 'just now'])
  expect(before.at(3)).toBe('line 1')
  expect(before.at(-1)).toBe('line 17')

  expect(await scroll($, 5)).toEqual({})
  const after = await texts()
  expect(after[0]).toBe(before[0])
  // The header scrolls out with the rows above it.
  expect(after).not.toContain(SECTION)
  expect(after[1]).toBe('line 5')
  expect(after.at(-1)).toBe('line 22')
  expect(after).toHaveLength(before.length - 1)
  // The plugin took the scroll: the engine's own never saw it.
  expect(w.engineScrolls).toEqual([])

  // A page key asks for the pane's 20 rows; the section's window is 18.
  await scroll($, 20)
  expect((await texts())[1]).toBe('line 23')
  await scroll($, 500)
  expect((await texts())[1]).toBe('line 23')
  expect((await texts()).at(-1)).toBe('line 40')
  await scroll($, -500)
  expect((await texts())[1]).toBe(SECTION)

  // A new result opens at its own top, wherever the last one was scrolled to.
  await scroll($, 5)
  w.replies.push(said(lines(40)))
  await summarize($)
  await w.clock.settle()
  expect((await texts())[1]).toBe(SECTION)
  await ui.unmount()
})

test('the section sits between the texts and FILES, a wheel tick over FILES moves the files, and one elsewhere moves the section', async ($, on) => {
  const w = world(on)
  const files = Array.from({ length: 7 }, (_, i) => `/tmp/project/doc${i}.md`)
  for (const file of files) w.files.set(file, '')
  w.files.set(`${DIR}/session-summaries/${ID}.jsonl`, `${JSON.stringify({ at: new Date(T0).toISOString(), soFar: 'Earlier work', now: 'Resume it', files, status: 'running', source: 'messages', variant: 'edit' })}\n`)
  w.replies.push(said(lines(40)))
  await start($)
  await summarize($)
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const tick = (row: number) => $.ui.scroll({ component: 'Pane', requestId: PLUGIN, offset: 0, by: 1, bodyRows: 20, contentRows: 20, origin: { kind: 'person' }, pointer: { row } } as never)

  const before = await texts()
  const header = SECTION
  expect(before.indexOf('SO FAR')).toBeLessThan(before.indexOf(header))
  expect(before.indexOf(header)).toBeLessThan(before.findIndex(t => t.startsWith('FILES')))

  await tick(19)
  const overFiles = await texts()
  expect(overFiles).toContain('FILES 2–6 of 7')
  expect(overFiles).toContain(header)

  await tick(10)
  const overSection = await texts()
  expect(overSection).toContain('FILES 2–6 of 7')
  // The section's window is 8 rows: one step down drops the header and brings in line 8.
  expect(overSection).not.toContain(SECTION)
  expect(overSection).toContain('line 1')
  expect(overSection).toContain('line 8')
  expect(overSection).not.toContain('line 9')
  expect(w.engineScrolls).toEqual([])
  await ui.unmount()
})

test('/summarize registers to run at once mid-turn, and the pane is drawn again on every tick', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.registered.find(c => c.name === CONCISE_COMMAND)?.immediate).toBe(true)
  await w.clock.advance(TICK_MS)
  await w.clock.settle()
  expect(w.invalidated).toEqual(['ui.render'])
})

test('when the section fits, ui.scroll falls through to the engine and the section stays', async ($, on) => {
  const w = world(on)
  w.replies.push(said(lines(3)))
  await start($)
  await summarize($)
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  const before = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await scroll($, 3)
  const after = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(w.engineScrolls).toEqual([3])
  expect(after).toEqual(before)
  expect(after).toContain('just now')
  await ui.unmount()
})

test('a second /summarize cuts the first, whose reply then writes nothing', async ($, on) => {
  const w = world(on)
  w.isAbortIgnored = true // the first reply is already on its way when it is cut
  w.replies.push(said('FIRST reply.'), said('SECOND reply.'))
  w.holds.push(15_000, 0)
  await start($)
  await summarize($)
  await w.clock.advance(1_000)
  await summarize($)
  await w.clock.settle()
  expect(await paneTexts($)).toContain('SECOND reply.')
  await w.clock.advance(15_000)
  await w.clock.settle()
  const texts = await paneTexts($)
  expect(texts).toContain('SECOND reply.')
  expect(texts).not.toContain('FIRST reply.')
  expect(texts.filter(t => t === SECTION)).toHaveLength(1)
})

test('a second /summarize aborts the call of the first', async ($, on) => {
  const w = world(on)
  w.replies.push(said('FIRST reply.'), said('SECOND reply.'))
  w.holds.push(60_000, 0)
  await start($)
  await summarize($)
  await w.clock.advance(1_000)
  expect(await paneTexts($)).toContain('working')
  await summarize($)
  await w.clock.settle()
  expect(conciseRequests(w)).toHaveLength(2)
  const texts = await paneTexts($)
  expect(texts).toContain('SECOND reply.')
  expect(texts).not.toContain('FIRST reply.')
  // Long before its 60 s hold is up: only the abort can have ended the first call.
  expect(logLines(w).map(l => l.split(' ')[1]).sort()).toEqual(['aborted', 'concise'])
  await w.clock.advance(60_000)
  expect(await paneTexts($)).toContain('SECOND reply.')
})

test('session.end empties the section, and a reply still held writes nothing after it', async ($, on) => {
  const w = world(on)
  w.isAbortIgnored = true
  w.replies.push(said('Too late.'))
  w.holds.push(15_000)
  await start($)
  await summarize($)
  await w.clock.advance(1_000)
  expect(await paneTexts($)).toContain('working')
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  expect(await paneTexts($)).toEqual(['No summary yet.'])
  await w.clock.advance(15_000)
  await w.clock.settle()
  expect(await paneTexts($)).toEqual(['No summary yet.'])
})

test('session.end empties a finished section', async ($, on) => {
  const w = world(on)
  await start($)
  await summarize($)
  await w.clock.settle()
  expect(await paneTexts($)).toContain('A shorter copy.')
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  expect(await paneTexts($)).toEqual(['No summary yet.'])
})

test('a session.start that finds the section still working empties it, and leaves a finished one', async ($, on) => {
  const w = world(on)
  await start($)
  await summarize($)
  await w.clock.settle()
  expect(sectionOf(await paneTexts($))).toContain('A shorter copy.')
  await start($)
  expect(sectionOf(await paneTexts($))).toContain('A shorter copy.')
  w.holds = [60_000]
  await summarize($)
  await w.clock.settle()
  expect(sectionOf(await paneTexts($))).toContain('Shortening the last response.')
  await start($)
  await w.clock.settle()
  expect(await paneTexts($)).not.toContain(SECTION)
})

test('one firing line is written with variant concise and trigger summarize', async ($, on) => {
  const w = world(on)
  w.replies.push(said('finding 0 END-OF-RESPONSE'))
  await start($)
  await summarize($)
  await w.clock.settle()
  expect(logLines(w)).toHaveLength(1)
  expect(logLines(w)[0]).toMatch(/^\S+ concise session=synthetic-session ms=\d+ reason=source=messages variant=concise in=900 out=40 cached=0 usd=\d+\.\d{4} summarize$/)
})

test('with no response, the section says so, the log says skip-no-response, and the model is never called', async ($, on) => {
  const w = world(on)
  w.messages = [user('hello'), { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't', tool: 'Bash', input: { command: 'ls' } }] }]
  await start($)
  await summarize($)
  await w.clock.settle()
  expect(w.requests).toEqual([])
  expect(logLines(w)).toHaveLength(1)
  expect(logLines(w)[0]).toMatch(/^\S+ skip-no-response session=synthetic-session ms=0 reason=source=messages variant=concise in=0 out=0 cached=0 usd=0\.0000 summarize$/)
  expect(await paneTexts($)).toContain('The agent has no response to shorten yet.')
})

test('a failed call shows the failure in the section and logs api-error with the reason', async ($, on) => {
  const w = world(on)
  w.replies.push({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO })
  await start($)
  await summarize($)
  await w.clock.settle()
  const texts = await paneTexts($)
  expect(texts).toContain('failed')
  expect(texts.join(' ')).toContain('The call failed (api-error overloaded). Run /summarize again.')
  expect(logLines(w)[0]).toMatch(/ api-error session=synthetic-session .* summarize api-error overloaded$/)
})

test('a response that reaches the token limit shows the cut-off mark', async ($, on) => {
  const w = world(on)
  w.replies.push(said('Partial copy', { ...USAGE, output_tokens: 8_000 }))
  await start($)
  await summarize($)
  await w.clock.settle()
  expect(sectionOf(await paneTexts($)).join('\n')).toContain('[Cut off at the length limit')
})

test('the summary timer\'s writes leave the section and its scroll position as they were', async ($, on) => {
  const w = world(on)
  w.replies.push(said(lines(80)))
  await start($)
  await summarize($)
  await w.clock.settle()
  const TALL = { offset: 0, bodyRows: 40 }
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: { ...PANE, scroll: TALL } })
  await scroll($, 10, 40)
  await ui.unmount()
  // The header is out of the window: the section starts at line 10.
  const before = await paneTexts($, TALL)
  expect(before).not.toContain(SECTION)
  expect(before.slice(1, 3)).toEqual(['line 10', 'line 11'])

  // The timer's summary adds the title, SO FAR and NOW rows above, so the room shrinks but the offset holds.
  await $.turn.start({ text: 'explain the findings', turnId: 't1' })
  await w.clock.advance(90_000)
  expect(w.requests.filter(r => r.system !== CONCISE_SYSTEM)).toHaveLength(1)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  await w.clock.settle()

  const after = await paneTexts($, TALL)
  expect(after[0]).toBe('Summary plugin')
  expect(after).not.toContain(SECTION)
  const first = after.indexOf('line 10')
  expect(first).toBeGreaterThan(after.indexOf('SO FAR'))
  expect(after[first + 1]).toBe('line 11')
})

// ---- /summarize on, every, off and the list of summaries ----

const run = ($: Engine, args: string) => $.command.run({ command: CONCISE_COMMAND, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
// A main turn that finishes with an answer: one response.
const respond = async ($: Engine, w: World, turnId: string, answer = 'Done.', isAborted = false) => {
  await $.turn.start({ text: 'next question', turnId })
  await $.turn.complete({ turnId, reason: 'answer', answer, durationMs: 1, isAborted })
  await w.clock.settle()
}
const keepalive = async ($: Engine, w: World, turnId: string) => {
  await $.turn.start({ text: 'keepalive ping. Reply only: ok', turnId })
  await $.turn.complete({ turnId, reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  await w.clock.settle()
}
const heads = (texts: string[]) => texts.filter(t => /^[▾▸] SUMMARY/.test(t))

test('an unknown argument prints the usage and makes no call and no pane', async ($, on) => {
  const w = world(on)
  await start($)
  const opened = w.opened.length
  const result = await run($, 'weekly')
  await w.clock.settle()
  expect(result.text).toBe(CONCISE_USAGE)
  expect(w.requests).toEqual([])
  expect(w.opened).toHaveLength(opened)
})

test('/summarize on runs once now, prints nothing, and turns every off', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'every')
  const result = await run($, 'on')
  await w.clock.settle()
  expect(result.text).toBeUndefined()
  expect(conciseRequests(w)).toHaveLength(1)
  await respond($, w, 't1')
  expect(conciseRequests(w)).toHaveLength(1)
})

test('a bare /summarize runs once and leaves every as it was', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'every')
  await run($, '')
  await w.clock.settle()
  expect(conciseRequests(w)).toHaveLength(1)
  await respond($, w, 't1')
  expect(conciseRequests(w)).toHaveLength(2)
})

test('a bare /summarize never turns every on', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, '')
  await w.clock.settle()
  await respond($, w, 't1')
  expect(conciseRequests(w)).toHaveLength(1)
})

test('/summarize every prints one line, makes no call now, and opens the pane', async ($, on) => {
  const w = world(on)
  await start($)
  const result = await run($, 'every')
  await w.clock.settle()
  expect(result.text).toMatch(/^summarize every:/)
  expect(result.text).not.toContain('\n')
  expect(w.requests).toEqual([])
  expect(await paneTexts($)).toEqual(['No summary yet.'])
  expect(w.opened.at(-1)).toBe(PLUGIN)
})

test('with every on, each response makes one call and adds a summary, newest first', async ($, on) => {
  const w = world(on)
  w.replies.push(said('copy one'), said('copy two'), said('copy three'))
  await start($)
  await run($, 'every')
  await respond($, w, 't1')
  await respond($, w, 't2')
  await respond($, w, 't3')
  expect(conciseRequests(w)).toHaveLength(3)
  const texts = await paneTexts($)
  // Only the newest is open; the older two are collapsed to their headers.
  expect(heads(texts)).toEqual([SECTION, '▸ SUMMARY · 1 RESPONSE OLD', '▸ SUMMARY · 2 RESPONSES OLD'])
  expect(texts).toContain('copy three')
  expect(texts).not.toContain('copy two')
  expect(texts).not.toContain('copy one')
})

test('the firing line of an every summary carries the summarize-every trigger', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'every')
  await respond($, w, 't1')
  const concise = logLines(w).filter(l => l.includes(' concise session='))
  expect(concise).toHaveLength(1)
  expect(concise[0]).toMatch(/ summarize-every$/)
})

test('a keepalive turn is no response: no call under every, and the label does not age', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'every')
  await respond($, w, 't1')
  expect(conciseRequests(w)).toHaveLength(1)
  await keepalive($, w, 'k1')
  await keepalive($, w, 'k2')
  expect(conciseRequests(w)).toHaveLength(1)
  expect(heads(await paneTexts($))).toEqual([SECTION])
})

test('an aborted turn and an empty answer are no response', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'every')
  await respond($, w, 't1', 'Half an answer', true)
  await respond($, w, 't2', '   ')
  expect(conciseRequests(w)).toEqual([])
  await run($, '')
  await w.clock.settle()
  expect(heads(await paneTexts($))).toEqual([SECTION])
})

test('a subagent turn is no response', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'every')
  await $.turn.complete({ turnId: 'a1', agentId: 'sub-1', reason: 'answer', answer: 'sub result', durationMs: 1, isAborted: false } as never)
  await w.clock.settle()
  expect(conciseRequests(w)).toEqual([])
})

test('the label of a summary moves from last response to 1 response old to 2 as turns complete', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, '')
  await w.clock.settle()
  expect(heads(await paneTexts($))).toEqual([SECTION])
  await respond($, w, 't1')
  expect(heads(await paneTexts($))).toEqual(['▾ SUMMARY · 1 RESPONSE OLD'])
  await respond($, w, 't2')
  expect(heads(await paneTexts($))).toEqual(['▾ SUMMARY · 2 RESPONSES OLD'])
})

test('a new summary collapses the older one, which keeps its header and loses its text', async ($, on) => {
  const w = world(on)
  w.replies.push(said('OLD copy'), said('NEW copy'))
  await start($)
  await run($, '')
  await w.clock.settle()
  await respond($, w, 't1')
  await run($, '')
  await w.clock.settle()
  const texts = await paneTexts($)
  expect(heads(texts)).toEqual([SECTION, '▸ SUMMARY · 1 RESPONSE OLD'])
  expect(texts).toContain('NEW copy')
  expect(texts).not.toContain('OLD copy')
})

test('a second summary of the same response replaces the first instead of stacking', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, '')
  await w.clock.settle()
  await respond($, w, 't1')
  await run($, '')
  await w.clock.settle()
  await run($, '')
  await w.clock.settle()
  expect(heads(await paneTexts($))).toEqual([SECTION, '▸ SUMMARY · 1 RESPONSE OLD'])
})

test('a summary with no newer one stays open however many responses have passed', async ($, on) => {
  const w = world(on)
  w.replies.push(said('STALE copy'))
  await start($)
  await run($, '')
  await w.clock.settle()
  for (const id of ['t1', 't2', 't3', 't4']) await respond($, w, id)
  const texts = await paneTexts($)
  expect(heads(texts)).toEqual(['▾ SUMMARY · 4 RESPONSES OLD'])
  expect(texts).toContain('STALE copy')
})

test('/summarize off prints one line, makes no call, stops every, and keeps the summaries', async ($, on) => {
  const w = world(on)
  w.replies.push(said('KEPT copy'))
  await start($)
  await run($, 'every')
  await respond($, w, 't1')
  expect(conciseRequests(w)).toHaveLength(1)
  const result = await run($, 'off')
  await w.clock.settle()
  expect(result.text).toMatch(/^summarize off:/)
  expect(result.text).not.toContain('\n')
  expect(conciseRequests(w)).toHaveLength(1)
  await respond($, w, 't2')
  expect(conciseRequests(w)).toHaveLength(1)
  const texts = await paneTexts($)
  expect(texts).toContain('KEPT copy')
  expect(heads(texts)).toEqual(['▾ SUMMARY · 1 RESPONSE OLD'])
})

test('a press on a header collapses its summary and a second press opens it again', async ($, on) => {
  const w = world(on)
  w.replies.push(said('PRESSED copy'))
  await start($)
  await run($, '')
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(isContent)
  expect(await texts()).toContain('PRESSED copy')
  await ui.press({ key: 'summary-1' })
  const collapsed = await texts()
  expect(heads(collapsed)).toEqual([`▸ ${CONCISE_LABEL}`])
  expect(collapsed).not.toContain('PRESSED copy')
  await ui.press({ key: 'summary-1' })
  const opened = await texts()
  expect(heads(opened)).toEqual([SECTION])
  expect(opened).toContain('PRESSED copy')
  await ui.unmount()
})

test('a press opens only the header it is on', async ($, on) => {
  const w = world(on)
  w.replies.push(said('FIRST copy'), said('SECOND copy'))
  await start($)
  await run($, '')
  await w.clock.settle()
  await respond($, w, 't1')
  await run($, '')
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(isContent)
  await ui.press({ key: 'summary-1' })
  const after = await texts()
  expect(after).toContain('FIRST copy')
  expect(after).toContain('SECOND copy')
  expect(heads(after)).toEqual([SECTION, '▾ SUMMARY · 1 RESPONSE OLD'])
  await ui.unmount()
})

test('every survives a /clear while the summaries and the response count do not', async ($, on) => {
  const w = world(on)
  await start($)
  await run($, 'every')
  await respond($, w, 't1')
  await respond($, w, 't2')
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  expect(await paneTexts($)).toEqual(['No summary yet.'])
  await start($)
  await respond($, w, 't3')
  expect(conciseRequests(w)).toHaveLength(3)
  // The count began again at the first response of the new conversation.
  expect(heads(await paneTexts($))).toEqual([SECTION])
})

test('a /clear then a summary does not age by the old conversation\'s responses', async ($, on) => {
  const w = world(on)
  await start($)
  await respond($, w, 't1')
  await respond($, w, 't2')
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  await start($)
  await run($, '')
  await w.clock.settle()
  expect(heads(await paneTexts($))).toEqual([SECTION])
})

test('an every summary cuts the call of a manual one still running on the same response', async ($, on) => {
  const w = world(on)
  w.replies.push(said('MANUAL copy'), said('EVERY copy'))
  w.holds.push(60_000, 0)
  await start($)
  await run($, '')
  await w.clock.advance(1_000)
  await run($, 'every')
  await respond($, w, 't1')
  const texts = await paneTexts($)
  expect(texts).toContain('EVERY copy')
  expect(texts).not.toContain('MANUAL copy')
})

test('a non-interactive session counts no responses and makes no every call', async ($, on) => {
  const w = world(on)
  await start($, false)
  const result = await run($, 'every')
  expect(result.text).toMatch(/interactive sessions only/)
  await respond($, w, 't1')
  expect(conciseRequests(w)).toEqual([])
})
