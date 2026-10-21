import { expect, test } from 'claude-code/testing'
import { isConversationReplaced, PERSON_ORIGINS } from '../hooks/shared/events.ts'
import { countOutcomes, firingLine, firingRecord, stateDir } from '../hooks/shared/firing.ts'
import { pool } from '../hooks/shared/pool.ts'
import { contentText, isTypedText, NOT_TYPED, parseRow, SIBLING_TEXTS, typedText } from '../hooks/shared/typed.ts'

const humanRow = (content: unknown) => ({
  type: 'user',
  message: { role: 'user', content },
  origin: { kind: 'human' },
})

test('only text blocks become transcript content', () => {
  expect(contentText([
    { type: 'text', text: 'first' },
    { type: 'tool_result', text: 'private' },
    { type: 'text', text: 'second' },
    { type: 'text' },
  ])).toBe('first\nsecond\n')
  expect(contentText('plain text')).toBe('plain text')
  expect(contentText({ text: 'not a content block list' })).toBe('')
})

test('a plugin nudge and a keepalive ping never become operator text', () => {
  const nudge = {
    type: 'user',
    message: { role: 'user', content: 'STOP JUDGE — continue the task.' },
    origin: { kind: 'plugin', name: 'stop-judge', asUser: true },
    promptSource: 'system',
    turnOrigin: 'system',
  }

  expect(typedText(nudge, { sdk: false })).toBeNull()
  expect(typedText(nudge, { sdk: true })).toBeNull()
  expect(typedText(humanRow('keepalive ping'), { sdk: false })).toBeNull()
})

test('an SDK opening is available to the judge but not transcript derivation', () => {
  const opening = {
    ...humanRow(' inspect the result '),
    entrypoint: 'sdk-cli',
  }

  expect(typedText(opening, { sdk: false })).toBeNull()
  expect(typedText(opening, { sdk: true })).toBe('inspect the result')
})

test('only a person-authored row survives the text-level filters', () => {
  expect(typedText(humanRow('  write the tests  '), { sdk: false })).toBe('write the tests')
  expect(typedText({ ...humanRow('system message'), promptSource: 'system' }, { sdk: false })).toBeNull()
  expect(typedText({ ...humanRow('not human'), origin: { kind: 'plugin' } }, { sdk: false })).toBeNull()
  expect(typedText({ type: 'user', message: { role: 'user', content: 'unattributed system row' }, promptSource: 'system' }, { sdk: false })).toBeNull()
  expect(typedText({ ...humanRow([{ type: 'tool_result', text: 'result' }]) }, { sdk: false })).toBeNull()

  expect(isTypedText('')).toBe(false)
  expect(isTypedText('<system-reminder>ignore this')).toBe(false)
  expect(isTypedText('From the owning session: do this')).toBe(false)
  expect(isTypedText('UserPromptSubmit hook supplied this')).toBe(false)
  expect(isTypedText('From the docs: keep this')).toBe(true)
})

test('a firing line is UTC-second precision, whitespace-normalized, and capped at 300 reason characters', () => {
  const reason = `  first\nsecond\t${'x'.repeat(400)}  `
  const line = firingLine('continue', 'session-7', 42, reason, new Date('2026-02-03T04:05:06.789Z'))

  expect(line).toBe(`2026-02-03T04:05:06Z continue session=session-7 ms=42 reason=first second ${'x'.repeat(287)}\n`)
})

test('outcome counts exclude malformed and older firing rows at the cutoff', () => {
  const lines = [
    '2026-02-01T11:59:59Z stop session=old ms=1 reason=before cutoff\n',
    '2026-02-01T12:00:00Z stop session=one ms=2 reason=at cutoff\n',
    '2026-02-02T00:00:00Z continue session=two ms=3 reason=after cutoff\n',
    'not a firing line',
  ]

  const counts = countOutcomes(lines, '2026-02-01T12:00:00Z')
  expect(counts.stop).toBe(1)
  expect(counts.continue).toBe(1)
  expect(counts['pass-error']).toBeUndefined()
})

test('the state dir is STOPSTOPPING_DIR, else under HOME, else none', () => {
  expect(stateDir('/home/u', '/tmp/ss')).toBe('/tmp/ss')
  expect(stateDir('/home/u', '')).toBe('/home/u/.claude/stopstopping')
  expect(stateDir('/home/u', undefined)).toBe('/home/u/.claude/stopstopping')
  expect(stateDir(undefined, undefined)).toBe('')
  expect(stateDir('', '')).toBe('')
})

test('a firing record is the plugin log path and its line, or null with no state dir', () => {
  const now = new Date('2026-10-20T12:00:00.500Z')
  const f = { plugin: 'session-log', outcome: 'prune', session: 's1', ms: 4, reason: 'moved=2  archive=/a b', now }
  expect(firingRecord({ ...f, home: '/home/u', override: undefined })).toEqual({
    path: '/home/u/.claude/stopstopping/logs/session-log.log',
    line: '2026-10-20T12:00:00Z prune session=s1 ms=4 reason=moved=2 archive=/a b\n',
  })
  expect(firingRecord({ ...f, home: '/home/u', override: '/tmp/ss' })?.path).toBe('/tmp/ss/logs/session-log.log')
  expect(firingRecord({ ...f, home: undefined, override: undefined })).toBeNull()
})

test('every sibling plugin text opens a row no person typed', () => {
  for (const text of Object.values(SIBLING_TEXTS)) {
    expect(NOT_TYPED).toContain(text)
    expect(isTypedText(`${text} and more`)).toBe(false)
  }
})

test('a transcript line is a row unless blank, cut, not an object, or a sidechain row', () => {
  expect(parseRow('{"type":"user","timestamp":"t"}')).toEqual({ type: 'user', timestamp: 't' })
  expect(parseRow('')).toBeNull()
  expect(parseRow('   ')).toBeNull()
  expect(parseRow('{"type":"us')).toBeNull()
  expect(parseRow('[1,2]')).toBeNull()
  expect(parseRow('{"type":"user","isSidechain":true}')).toBeNull()
})

test('a person prompt comes from the composer, a bridge or a Slack ping; a compaction replaces only the main, unskipped, installed conversation', () => {
  for (const kind of ['composer', 'bridge', 'slack-ping']) expect(PERSON_ORIGINS.has(kind)).toBe(true)
  expect(PERSON_ORIGINS.has('plugin')).toBe(false)
  expect(isConversationReplaced({ trigger: 'auto' }, {})).toBe(true)
  expect(isConversationReplaced({ trigger: 'precompute' }, {})).toBe(false)
  expect(isConversationReplaced({ trigger: 'auto', agentId: 'a' }, {})).toBe(false)
  expect(isConversationReplaced({ trigger: 'manual' }, { skip: 'x' })).toBe(false)
})

test('pool keeps item order, runs at most `limit` at once, and starts nothing after a rejection', async () => {
  let running = 0
  let most = 0
  const started: number[] = []
  const out = await pool([3, 1, 2, 0], 2, async n => {
    started.push(n)
    most = Math.max(most, ++running)
    for (let i = 0; i < n * 3; i++) await Promise.resolve()
    running--
    return n * 10
  })
  expect(out).toEqual([30, 10, 20, 0])
  expect(most).toBe(2)
  const tried: number[] = []
  await expect(pool([1, 2, 3, 4], 1, async n => {
    tried.push(n)
    if (n === 2) throw new Error('boom')
    return n
  })).rejects.toThrow('boom')
  expect(tried).toEqual([1, 2])
})
