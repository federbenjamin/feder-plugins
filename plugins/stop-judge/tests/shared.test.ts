import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { isConversationReplaced, PERSON_ORIGINS } from '../hooks/shared/events.ts'
import { countOutcomes, firingLine, firingRecord, sessionLogPath, sessionLogsDir, stateDir } from '../hooks/shared/firing.ts'
import { pool } from '../hooks/shared/pool.ts'
import { PRICES, usageUsd } from '../hooks/shared/pricing.ts'
import { appendLine, record, stateDirs } from '../hooks/shared/record.ts'
import { isPermanent, retryDelayS, tooManyFailed } from '../hooks/shared/retry.ts'
import { toolInputHead } from '../hooks/shared/text.ts'
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

// A structural `$` for the shared append: the env it is given, a log file that exists or not,
// and every fs and process call in order.
function appendWorld(env: Record<string, string>, opts: { exists?: boolean; failWrite?: boolean } = {}) {
  const calls: string[] = []
  const $ = {
    env: { get: async (name: string) => env[name] },
    session: { id: async () => 's1' },
    clock: { now: async () => Date.parse('2026-10-20T12:00:00Z') },
    fs: {
      exists: async (path: string) => (calls.push(`exists ${path}`), opts.exists ?? true),
      write: async (path: string, text: string) => {
        calls.push(`write ${path} ${JSON.stringify(text)}`)
        if (opts.failWrite) throw new Error('read-only')
      },
    },
    process: {
      run: async (argv: readonly string[], init?: { stdin?: string }) => {
        calls.push(`run ${argv.join(' ')} ${JSON.stringify(init?.stdin ?? '')}`)
        return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
  } as unknown as EngineInterface
  return { $, calls }
}

test('the one append writes the plugin line to its log with tee, making a missing log first, and nothing with no state dir', async () => {
  const line = JSON.stringify('2026-10-20T12:00:00Z afk session=s1 ms=0 reason=dialog open 30 min\n')
  const present = appendWorld({ HOME: '/home/u' })
  await record(present.$, 'dialog-timeout', 'afk', 'dialog open  30 min')
  expect(present.calls).toEqual(['exists /home/u/.claude/stopstopping/logs/dialog-timeout.log', `run tee -a /home/u/.claude/stopstopping/logs/dialog-timeout.log ${line}`])

  const missing = appendWorld({ HOME: '/home/u', STOPSTOPPING_DIR: '/tmp/ss' }, { exists: false })
  await record(missing.$, 'stop-judge', 'stop', 'fine', 42)
  expect(missing.calls).toEqual([
    'exists /tmp/ss/logs/stop-judge.log',
    'write /tmp/ss/logs/stop-judge.log ""',
    `run tee -a /tmp/ss/logs/stop-judge.log ${JSON.stringify('2026-10-20T12:00:00Z stop session=s1 ms=42 reason=fine\n')}`,
  ])

  const nowhere = appendWorld({})
  await record(nowhere.$, 'session-log', 'template', '')
  expect(nowhere.calls).toEqual([])
})

test('a failed log write never reaches the plugin', async () => {
  const w = appendWorld({ HOME: '/home/u' }, { exists: false, failWrite: true })
  await expect(record(w.$, 'cache-keepalive', 'bump', '1/6')).resolves.toBeUndefined()
  expect(w.calls.some(c => c.startsWith('run tee'))).toBe(false)
})

test('the state dirs are HOME and the one state-dir rule over the environment', async () => {
  expect(await stateDirs(appendWorld({ HOME: '/home/u' }).$)).toEqual({ home: '/home/u', dir: '/home/u/.claude/stopstopping' })
  expect(await stateDirs(appendWorld({ HOME: '/home/u', STOPSTOPPING_DIR: '/tmp/ss' }).$)).toEqual({ home: '/home/u', dir: '/tmp/ss' })
  expect(await stateDirs(appendWorld({}).$)).toEqual({ home: '', dir: '' })
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
  // Item 1 is still running when item 2 rejects in the other lane; its lane starts nothing after.
  const tried: number[] = []
  await expect(pool([1, 2, 3, 4], 2, async n => {
    tried.push(n)
    if (n === 2) throw new Error('boom')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    return n
  })).rejects.toThrow('boom')
  for (let i = 0; i < 30; i++) await Promise.resolve()
  expect(tried).toEqual([1, 2])
})

test('usageUsd prices each token category apart and reads a missing cache count as 0', () => {
  const price = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }
  expect(usageUsd({ input_tokens: 1_000_000, output_tokens: 0 }, price)).toBe(1)
  expect(usageUsd({ input_tokens: 0, output_tokens: 1_000_000 }, price)).toBe(2)
  expect(usageUsd({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, price)).toBe(3)
  expect(usageUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }, price)).toBe(4)
  expect(usageUsd({ input_tokens: 10, output_tokens: 10 }, price)).toBe(usageUsd({ input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, price))
})

test('the Sonnet price reproduces the derive estimate: cache tokens at the input price', () => {
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 }
  expect(usageUsd(usage, PRICES.sonnet)).toBe(((1000 + 2000 + 300) * 3 + 500 * 15) / 1_000_000)
})

test('the session-log folder and file paths come from one definition', () => {
  expect(sessionLogsDir('/d')).toBe('/d/session-logs')
  expect(sessionLogPath('/d', 'abc')).toBe('/d/session-logs/abc.md')
})

test('a tool input is headed by command, file_path, description, prompt, skill in that order', () => {
  expect(toolInputHead({ command: 'ls', file_path: 'a', description: 'd' })).toBe('ls')
  expect(toolInputHead({ file_path: 'a', description: 'd' })).toBe('a')
  expect(toolInputHead({ description: 'd', prompt: 'p' })).toBe('d')
  expect(toolInputHead({ prompt: 'p', skill: 's' })).toBe('p')
  expect(toolInputHead({ skill: 's' })).toBe('s')
  expect(toolInputHead({})).toBe('')
  expect(toolInputHead('text')).toBe('')
  expect(toolInputHead(null)).toBe('')
})

test('appendLine writes an absent file empty then appends with tee, an existing one only appends, and a failed write rejects', async () => {
  const absent = appendWorld({}, { exists: false })
  await appendLine(absent.$, '/x/a.jsonl', 'one\n')
  expect(absent.calls).toEqual(['exists /x/a.jsonl', 'write /x/a.jsonl ""', `run tee -a /x/a.jsonl ${JSON.stringify('one\n')}`])

  const present = appendWorld({})
  await appendLine(present.$, '/x/a.jsonl', 'two\n')
  expect(present.calls).toEqual(['exists /x/a.jsonl', `run tee -a /x/a.jsonl ${JSON.stringify('two\n')}`])

  const failing = appendWorld({}, { exists: false, failWrite: true })
  await expect(appendLine(failing.$, '/x/a.jsonl', 'three\n')).rejects.toThrow('read-only')
})

test('isPermanent is true for each no-wait-clears error and false for transient ones', async () => {
  for (const error of [
    'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required',
    'billing_error', 'cloud_credential_error', 'invalid_request', 'model_not_found',
  ]) {
    expect(isPermanent({ reason: 'api-error', error })).toBe(true)
  }
  expect(isPermanent({ reason: 'api-error', status: 429, error: 'rate_limit' })).toBe(false)
  expect(isPermanent({ reason: 'api-error', status: 529, error: 'overloaded' })).toBe(false)
  expect(isPermanent({ reason: 'api-error', status: null, error: 'unknown' })).toBe(false)
  expect(isPermanent({ reason: 'empty-reply' })).toBe(false)
  expect(isPermanent({ reason: 'aborted' })).toBe(false)
})

test('retryDelayS gives a permanent error no retry at any attempt', async () => {
  const f = { reason: 'api-error', status: 401, error: 'authentication_failed' }
  for (const attempt of [0, 1, 2, 3]) expect(retryDelayS(f, attempt)).toBeUndefined()
})

test('retryDelayS retries a 429 with backoff 30, 60, 120, 240 then gives up', async () => {
  const f = { reason: 'api-error', status: 429, error: 'rate_limit' }
  expect([0, 1, 2, 3].map(a => retryDelayS(f, a))).toEqual([30, 60, 120, 240])
  expect(retryDelayS(f, 4)).toBeUndefined()
  expect(retryDelayS(f, 10)).toBeUndefined()
})

test('retryDelayS backs off the same for 5xx, null status and empty replies', async () => {
  for (const f of [
    { reason: 'api-error', status: 529, error: 'overloaded' },
    { reason: 'api-error', status: 500, error: 'server_error' },
    { reason: 'api-error', status: null, error: 'unknown' },
    { reason: 'empty-reply' },
  ]) {
    expect([0, 1, 2, 3, 4].map(a => retryDelayS(f, a))).toEqual([30, 60, 120, 240, undefined])
  }
})

test('retryDelayS retries an aborted call once after 30s', async () => {
  expect(retryDelayS({ reason: 'aborted' }, 0)).toBe(30)
  expect(retryDelayS({ reason: 'aborted' }, 1)).toBeUndefined()
  expect(retryDelayS({ reason: 'aborted' }, 2)).toBeUndefined()
})

test('tooManyFailed is true only when more than half failed', async () => {
  expect(tooManyFailed(0, 0)).toBe(false)
  expect(tooManyFailed(1, 0)).toBe(false)
  expect(tooManyFailed(2, 1)).toBe(false)
  expect(tooManyFailed(3, 1)).toBe(false)
  expect(tooManyFailed(3, 2)).toBe(true)
  expect(tooManyFailed(4, 2)).toBe(false)
  expect(tooManyFailed(4, 3)).toBe(true)
  expect(tooManyFailed(1, 1)).toBe(true)
})
