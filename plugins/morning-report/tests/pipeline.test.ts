import { test, expect } from 'claude-code/testing'
import {
  addUsage,
  alreadyWritten,
  batchSessions,
  consentLine,
  describeFailure,
  fillTemplate,
  intOption,
  localDate,
  nextState,
  noSessionsScan,
  notSummarized,
  parseExtracted,
  parseRunArgs,
  parseSetupArgs,
  parseState,
  PROFILE_HEADINGS,
  profileHeadingsBlock,
  REPORT_HOUR,
  runRecordName,
  SCAN_NO_SESSIONS,
  scanFileText,
  scanPrompt,
  sessionBlock,
  SETUP_ARGUMENT_HINT,
  SETUP_DAYS,
  SETUP_USAGE,
  stderrHead,
  summaryOutcome,
  windowFor,
  windowForRun,
  type Session,
  type Summary,
  type UsageByModel,
} from '../hooks/pipeline.ts'

const HOUR = 3600_000

const NOW = Date.parse('2026-10-06T12:00:00Z')

const session = (id: string, len: number): Session => ({
  id,
  project: 'p',
  start: 's',
  end: 'e',
  typed: 1,
  active_minutes: 7,
  text: 'x'.repeat(len),
})

test('no watermark looks back 24h', async () => {
  const w = windowFor(undefined, NOW)
  expect(w.since).toBe(new Date(NOW - 24 * HOUR).toISOString())
  expect(w.until).toBe(new Date(NOW).toISOString())
})

test('a recent watermark becomes since', async () => {
  const mark = new Date(NOW - 10 * HOUR).toISOString()
  expect(windowFor(mark, NOW).since).toBe(mark)
})

test('a watermark older than 72h is capped at 72h', async () => {
  const mark = new Date(NOW - 5 * 24 * HOUR).toISOString()
  const w = windowFor(mark, NOW)
  expect(w.since).toBe(new Date(NOW - 72 * HOUR).toISOString())
  expect(w.until).toBe(new Date(NOW).toISOString())
})

test('an unparseable watermark falls back to 24h', async () => {
  expect(windowFor('garbage', NOW).since).toBe(new Date(NOW - 24 * HOUR).toISOString())
})

test('big sessions get their own batch and small ones group up to 20000 chars', async () => {
  const big = session('big', 3000)
  const smalls = Array.from({ length: 5 }, (_, i) => session(`s${i}`, 2999))
  const batches = batchSessions([smalls[0]!, big, ...smalls.slice(1)])
  expect(batches.map(b => b.map(s => s.id))).toEqual([['big'], ['s0', 's1', 's2', 's3', 's4']])

  const eight = Array.from({ length: 8 }, (_, i) => session(`t${i}`, 2900))
  // 6 * 2900 = 17400; a 7th would reach 20300 > 20000, so it starts a new batch.
  const grouped = batchSessions(eight)
  expect(grouped.map(b => b.length)).toEqual([6, 2])
})

test('localDate applies the offset across midnight', async () => {
  const ms = Date.parse('2026-10-06T01:00:00Z')
  // getTimezoneOffset convention: UTC-5 is +300 minutes, so 01:00Z is still the 5th.
  expect(localDate(ms, 300)).toBe('2026-10-05')
  expect(localDate(ms, 0)).toBe('2026-10-06')
  // UTC+2 is -120: 23:00Z on the 5th is already the 6th.
  expect(localDate(Date.parse('2026-10-05T23:00:00Z'), -120)).toBe('2026-10-06')
})

test('a rerun on the day a report was written starts at the previous watermark', async () => {
  const prev = new Date(NOW - 20 * HOUR).toISOString()
  const first = new Date(NOW - 2 * HOUR).toISOString()
  const state = { watermark: first, prevWatermark: prev, reportDate: '2026-10-06' }
  expect(windowForRun(state, NOW, '2026-10-06').since).toBe(prev)
  expect(windowForRun(state, NOW, '2026-10-07').since).toBe(first)
  expect(windowForRun({ watermark: first, reportDate: '2026-10-06' }, NOW, '2026-10-06').since).toBe(first)
})

test('a first run with no state, then a same-day rerun, then a next-day run, chain their windows', async () => {
  const t1 = Date.parse('2026-10-06T09:00:00Z')
  const first = windowForRun({}, t1, '2026-10-06')
  expect(first.since).toBe(new Date(t1 - 24 * HOUR).toISOString())
  const s1 = nextState(first.since, first.until, '2026-10-06')
  expect(s1).toEqual({ watermark: first.until, prevWatermark: first.since, reportDate: '2026-10-06' })

  // Same day: the rerun redoes the first run's window, not the span since the first run.
  const t2 = Date.parse('2026-10-06T11:00:00Z')
  const rerun = windowForRun(s1, t2, '2026-10-06')
  expect(rerun.since).toBe(first.since)
  expect(rerun.until).toBe(new Date(t2).toISOString())
  const s2 = nextState(rerun.since, rerun.until, '2026-10-06')
  expect(s2).toEqual({ watermark: rerun.until, prevWatermark: first.since, reportDate: '2026-10-06' })

  // Next day: starts where the previous run ended.
  const t3 = Date.parse('2026-10-07T09:00:00Z')
  const next = windowForRun(s2, t3, '2026-10-07')
  expect(next.since).toBe(rerun.until)
  expect(next.until).toBe(new Date(t3).toISOString())
})

test('parseState reads a good file and flags corrupt ones', async () => {
  expect(parseState('{"watermark":"w","prevWatermark":"p","reportDate":"d"}')).toEqual({
    state: { watermark: 'w', prevWatermark: 'p', reportDate: 'd' },
    corrupt: false,
  })
  expect(parseState('{}').corrupt).toBe(false)
  for (const bad of ['{"watermark":', '', 'null', '[1]', '"x"']) {
    expect(parseState(bad)).toEqual({ state: {}, corrupt: true })
  }
})

test('addUsage sums per model and counts calls separately for each model', async () => {
  const acc: UsageByModel = {}
  const u = (n: number) => ({
    input_tokens: n, output_tokens: 2 * n, cache_read_input_tokens: 3 * n, cache_creation_input_tokens: 4 * n,
  })
  addUsage(acc, 'sonnet', u(1))
  addUsage(acc, 'opus', u(10))
  addUsage(acc, 'sonnet', u(100))
  expect(acc).toEqual({
    sonnet: { calls: 2, input_tokens: 101, output_tokens: 202, cache_read_input_tokens: 303, cache_creation_input_tokens: 404 },
    opus: { calls: 1, input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  })
})

test('sessionBlock shows the computed active minutes line', async () => {
  const block = sessionBlock({ ...session('abc', 5), active_minutes: 42 })
  expect(block).toContain('your active minutes (computed from your message times): 42')
  expect(block.startsWith('### session abc\n')).toBe(true)
})

test('describeFailure names the model, reason, status and error kind', async () => {
  expect(describeFailure('sonnet', { reason: 'api-error', status: 529, error: 'overloaded' })).toBe(
    'sonnet call failed: api-error 529 overloaded',
  )
  expect(describeFailure('opus', { reason: 'api-error', status: null, error: 'unknown' })).toBe(
    'opus call failed: api-error unknown',
  )
  expect(describeFailure('opus', { reason: 'empty-reply' })).toBe('opus call failed: empty-reply')
})

test('parseRunArgs reads --force and a backfill window of the 24h before --until', async () => {
  expect(parseRunArgs('')).toEqual({ force: false })
  expect(parseRunArgs('--force')).toEqual({ force: true })
  expect(parseRunArgs('--backfill 2026-10-05 --until 2026-10-05T05:21:14.683Z')).toEqual({
    force: false,
    backfill: { date: '2026-10-05', since: '2026-10-04T05:21:14.683Z', until: '2026-10-05T05:21:14.683Z' },
  })
  expect(() => parseRunArgs('--backfill 2026-10-05')).toThrow('--backfill needs --until')
})

test('template filling preserves dollar signs and leaves placeholders without values intact', async () => {
  const template = 'first={{PROFILE}}; again={{PROFILE}}; path={{DATA_DIR}}; call={{call 1}}; unknown={{X}}'
  expect(fillTemplate(template, { PROFILE: '$& is literal', DATA_DIR: '/reports/$HOME' })).toBe(
    'first=$& is literal; again=$& is literal; path=/reports/$HOME; call={{call 1}}; unknown={{X}}',
  )
})

test('invalid number options fall back while finite values floor and stay inside their named bounds', async () => {
  for (const value of [undefined, '3', NaN, Infinity, -Infinity]) expect(intOption(value, SETUP_DAYS)).toBe(7)
  expect(intOption(3.9, SETUP_DAYS)).toBe(3)
  expect(intOption(0, SETUP_DAYS)).toBe(1)
  expect(intOption(-2, SETUP_DAYS)).toBe(1)
  expect(intOption(12, SETUP_DAYS)).toBe(7)
  expect(intOption(-0.1, REPORT_HOUR)).toBe(0)
  expect(intOption(19.9, REPORT_HOUR)).toBe(19)
  expect(intOption(20, REPORT_HOUR)).toBe(19)
})

test('setup consent uses singular only for exactly one day, session, or summary call', async () => {
  expect(consentLine(34, 26, 1, 'sonnet', 'opus')).toBe(
    '34 sessions over the last 1 day: 26 summary calls on sonnet, then 1 opus call',
  )
  expect(consentLine(1, 1, 7, 'sonnet', 'opus')).toBe(
    '1 session over the last 7 days: 1 summary call on sonnet, then 1 opus call',
  )
})

test('summaryOutcome counts the sessions in failed batches against all sessions, not batches', async () => {
  const ok = (...ids: string[]): Summary => ({ ids, text: `## ${ids.join(',')}` })
  const bad = (...ids: string[]): Summary => ({ ids, failed: 'rate_limit' })
  expect(() => summaryOutcome([bad('a', 'b', 'c'), ok('d', 'e')])).toThrow('3 of 5 summaries failed: rate_limit')
  expect(() => summaryOutcome([ok('d', 'e'), bad('a', 'b', 'c')])).toThrow('3 of 5 summaries failed: rate_limit')
  expect(summaryOutcome([bad('a'), bad('b'), ok('c', 'd', 'e', 'f', 'g')])).toEqual({
    failed: 2,
    text: ['## a — not summarized (rate_limit)', '## b — not summarized (rate_limit)', '## c,d,e,f,g'],
  })
  expect(summaryOutcome([bad('a', 'b'), ok('c', 'd')]).failed).toBe(2)
  expect(summaryOutcome([])).toEqual({ failed: 0, text: [] })
})

test('notSummarized names the count of sessions, singular for one, and nothing for none', async () => {
  expect(notSummarized(0)).toBe('')
  expect(notSummarized(1)).toBe(' (1 session not summarized)')
  expect(notSummarized(3)).toBe(' (3 sessions not summarized)')
})

test('setup argument parsing starts the interview bare, takes schedule or remove, and refuses the rest', async () => {
  expect(SETUP_ARGUMENT_HINT).toBe('[schedule | remove]')
  expect(SETUP_USAGE).toBe(`usage: /morning-setup ${SETUP_ARGUMENT_HINT}`)
  expect(parseSetupArgs('')).toEqual({ kind: 'interview' })
  expect(parseSetupArgs('   ')).toEqual({ kind: 'interview' })
  expect(parseSetupArgs('schedule')).toEqual({ kind: 'schedule' })
  expect(parseSetupArgs(' remove ')).toEqual({ kind: 'remove' })
  expect(parseSetupArgs('Schedule')).toEqual({ kind: 'schedule' })
  for (const args of ['scan', 'scan 3', 'goals', 'schedule now', 'remove now', 'run']) {
    expect(parseSetupArgs(args)).toEqual({ kind: 'usage' })
  }
})

test('stderrHead trims the stderr and keeps its first 200 characters', async () => {
  expect(stderrHead('  boom \n')).toBe('boom')
  expect(stderrHead(` ${'x'.repeat(250)}`)).toBe('x'.repeat(200))
  expect(stderrHead('')).toBe('')
})

test('noSessionsScan starts with the no-sessions marker and names the days', async () => {
  expect(noSessionsScan(1)).toBe('(no sessions in the last 1 day)')
  expect(noSessionsScan(7)).toBe('(no sessions in the last 7 days)')
  expect(noSessionsScan(3).startsWith(SCAN_NO_SESSIONS)).toBe(true)
})

test('parseExtracted returns the extract and names the key a shape change dropped', async () => {
  const good = { sessions: [session('a', 3)], active_minutes: 7, projects: [{ project: 'p', active_minutes: 7 }] }
  expect(parseExtracted(JSON.stringify(good))).toEqual(good)
  expect(parseExtracted(JSON.stringify({ sessions: [], active_minutes: 0, projects: [] }))).toEqual({ sessions: [], active_minutes: 0, projects: [] })
  const without = (o: object, key: string) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)))
  expect(() => parseExtracted(without(good, 'projects'))).toThrow('projects is missing or not an array')
  expect(() => parseExtracted(without(good, 'sessions'))).toThrow('sessions is missing or not an array')
  expect(() => parseExtracted(without(good, 'active_minutes'))).toThrow('active_minutes is missing or not a number')
  expect(() => parseExtracted(JSON.stringify({ ...good, projects: [{ project: 'p', minutes: 7 }] }))).toThrow(
    'projects[0].active_minutes is missing or not a number',
  )
  expect(() => parseExtracted(JSON.stringify({ ...good, projects: [{ path: 'p', active_minutes: 7 }] }))).toThrow(
    'projects[0].project is missing or not a string',
  )
  expect(() => parseExtracted(JSON.stringify({ ...good, projects: ['p'] }))).toThrow('projects[0] is not an object')
  expect(() => parseExtracted(JSON.stringify({ ...good, sessions: [{ ...session('a', 3), text: undefined }] }))).toThrow(
    'sessions[0].text is missing or not a string',
  )
  expect(() => parseExtracted(JSON.stringify({ ...good, active_minutes: '7' }))).toThrow('active_minutes is missing or not a number')
  expect(() => parseExtracted('null')).toThrow('the result is not an object')
  expect(() => parseExtracted('[]')).toThrow('the result is not an object')
  expect(() => parseExtracted('not json')).toThrow('extract output is not JSON')
})
test('the day is already written once its run record exists or state.json names it, and not before', async () => {
  expect(runRecordName('2026-10-06')).toBe('2026-10-06-run.json')
  expect(alreadyWritten({}, '2026-10-06', [])).toBe(false)
  expect(alreadyWritten({}, '2026-10-06', ['2026-10-05-run.json', '2026-10-06-summaries.md', '2026-10-06-status.md'])).toBe(false)
  expect(alreadyWritten({}, '2026-10-06', ['2026-10-06-run.json'])).toBe(true)
  expect(alreadyWritten({ reportDate: '2026-10-06' }, '2026-10-06', [])).toBe(true)
  expect(alreadyWritten({ reportDate: '2026-10-05' }, '2026-10-06', ['2026-10-05-run.json'])).toBe(false)
})

test('the profile has one heading, Watch for, and the fill names it with what goes under it', async () => {
  expect(PROFILE_HEADINGS.map(entry => entry.heading)).toEqual(['Watch for'])
  expect(profileHeadingsBlock().split('\n')).toEqual(PROFILE_HEADINGS.map(entry => `## ${entry.heading} — ${entry.holds}`))
})

test('scanPrompt carries the window and the summaries', async () => {
  const prompt = scanPrompt({
    since: '2026-10-05T12:00:00.000Z',
    until: '2026-10-06T12:00:00.000Z',
    days: 1,
    summaries: ['## a — one', '## b — two'],
  })
  expect(prompt).toBe(
    ['Window: 2026-10-05T12:00:00.000Z → 2026-10-06T12:00:00.000Z (1 day).', '', '# Session summaries', '## a — one', '', '## b — two'].join('\n'),
  )
})

test('scanFileText says the habits are partial only when some sessions were not summarized', async () => {
  expect(scanFileText('  # Setup scan\nbody\n\n', 0, 34)).toBe('# Setup scan\nbody\n')
  const partial = scanFileText('# Setup scan\nbody', 12, 34)
  expect(partial.startsWith('# Setup scan\nbody\n\n')).toBe(true)
  expect(partial).toContain('12 of 34 sessions could not be summarized, so Habits covers only part of the window')
})
