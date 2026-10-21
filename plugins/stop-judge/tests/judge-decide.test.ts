import { expect, test } from 'claude-code/testing'
import {
  FRAMING,
  JUDGE_REQUEST,
  MINUTES_FACT,
  NUDGE_PREFIX,
  OUTCOMES,
  buildSystem,
  buildUser,
  judgeOutcome,
  judgeRequest,
  decide,
  guardOutcome,
  minutesSinceOperator,
  nudgeText,
  splitTurn,
  transcriptFindArgv,
} from '../hooks/judge.ts'
import { PROMPT } from '../hooks/prompt.ts'

const T0 = new Date('2026-10-20T12:00:00.000Z')

const typedRow = (text: string, timestamp: string) => ({
  type: 'user',
  timestamp,
  message: { role: 'user', content: text },
  origin: { kind: 'human' },
  promptSource: 'typed',
})

const pluginOpening = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: text },
  origin: { kind: 'plugin', name: 'stop-judge', asUser: true },
  promptSource: 'system',
  turnOrigin: 'system',
})

test('the minutes fact uses the newest typed message and ignores plugin text', () => {
  const rows = [
    typedRow('choose a direction', '2026-10-20T11:53:00.000Z'),
    pluginOpening('STOP JUDGE — machine text'),
  ]

  expect(minutesSinceOperator(rows, T0)).toBe(7)
  expect(minutesSinceOperator([pluginOpening('STOP JUDGE — machine text')], T0)).toBe(null)
})

test('the minutes fact is placed immediately before the JSON instruction and disappears without a typed message', () => {
  const withMinutes = buildUser('final response', 'opening message', ['earlier message'], 7, false, true)
  const withoutMinutes = buildUser('final response', 'opening message', ['earlier message'], null, false, true)

  expect(withMinutes).toContain('7')
  expect(withMinutes.indexOf('7')).toBeGreaterThan(withMinutes.indexOf('final response'))
  expect(withMinutes.indexOf('7')).toBeLessThan(withMinutes.lastIndexOf('One JSON line.'))
  const beforeJson = withMinutes.slice(0, withMinutes.lastIndexOf('One JSON line.')).trimEnd()
  expect(beforeJson.slice(beforeJson.lastIndexOf('\n') + 1)).toContain('7')
  expect(withMinutes.endsWith('One JSON line.')).toBe(true)
  expect(withoutMinutes).not.toContain('7')
})

test('consultation framing catches discussion wording but leaves the grilling command to its own mode', () => {
  expect(FRAMING.test('lets discuss it before changing anything')).toBe(true)
  expect(FRAMING.test('ask me one by one')).toBe(true)
  expect(FRAMING.test('/some-skill this')).toBe(false)
})

test('the transcript turn keeps the human context before the queued opening and uses the transcript final', () => {
  const rows = [
    { type: 'user', message: { content: 'zeroth ask' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Zeroth answer.' }] } },
    { type: 'user', message: { content: 'first ask' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Earlier answer.' }] } },
    { type: 'user', message: { content: '<bash-input>ls</bash-input>' } },
    { type: 'user', message: { content: '<bash-stdout>x</bash-stdout>' } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } } },
    { type: 'user', message: { content: 'open the PR when green' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'ask me one by one before you push', origin: { kind: 'human' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Green.' }, { type: 'text', text: undefined }, { type: 'text', text: 'Want me to open the PR?' }] } },
  ]

  expect(splitTurn(rows, undefined)).toEqual({
    opening: 'ask me one by one before you push',
    openingKind: 'human',
    prior: ['zeroth ask', 'first ask', 'open the PR when green'],
    final: 'Green.\n\nWant me to open the PR?',
  })
})

test('a plugin-origin keepalive opening bypasses the judge before an empty final can', () => {
  const turn = splitTurn([pluginOpening('keepalive ping. Reply only: ok')], 'a final answer')

  expect(turn.openingKind).toBe('plugin')
  expect(guardOutcome({
    isOff: false,
    agentId: undefined,
    reason: 'answer',
    nested: false,
    nudgedThisPrompt: false,
    openingKind: turn.openingKind,
    opening: turn.opening,
    final: turn.final,
  })).toBe('pass-keepalive')
})

test('the guard returns the first applicable bypass and otherwise lets the judge decide', () => {
  const normal = {
    isOff: false,
    agentId: undefined,
    reason: 'answer',
    nested: false,
    nudgedThisPrompt: false,
    openingKind: 'human' as const,
    opening: 'a person wrote this',
    final: 'an answer',
  }

  expect(guardOutcome({ ...normal, isOff: true, agentId: 'worker' })).toBe('pass-off')
  expect(guardOutcome({ ...normal, agentId: 'worker' })).toBe('pass-subagent')
  expect(guardOutcome({ ...normal, reason: 'aborted' })).toBe('pass-aborted')
  expect(guardOutcome({ ...normal, nested: true })).toBe('pass-nested')
  expect(guardOutcome({ ...normal, nudgedThisPrompt: true })).toBe('pass-nudged')
  expect(guardOutcome({ ...normal, final: '' })).toBe('pass-notext')
  expect(guardOutcome(normal)).toBe(null)
})

test('a confident continue blocks the stop, while a weak, malformed, or unexplained one cannot', () => {
  expect(decide({ verdict: 'stop', reason: 'finished', fields: {} })).toEqual({ outcome: 'stop', reason: 'finished' })
  expect(decide({ verdict: 'continue', reason: 'a decision is still needed', fields: { confidence: 0.7 } })).toEqual({ outcome: 'continue', reason: 'a decision is still needed' })
  expect(decide({ verdict: 'continue', reason: 'uncertain', fields: { confidence: 0.699 } }).outcome).toBe('stop-lowconf')
  expect(decide({ verdict: 'continue', reason: 'not numeric', fields: { confidence: 'high' } }).outcome).toBe('stop-lowconf')
  expect(decide({ verdict: 'continue', reason: '', fields: { confidence: 1 } }).outcome).toBe('pass-error')
})

test('a nudge is one concise sentence without copied rule text', () => {
  expect(nudgeText('A response is still required.')).toBe('STOP JUDGE — A response is still required.')
  expect(nudgeText('A response is still required.')).not.toContain('rule 9')
})

test('the transcript lookup is scoped to one session file below the projects directory', () => {
  expect(transcriptFindArgv('/synthetic-home', 'session-42')).toEqual([
    'find',
    '/synthetic-home/.claude/projects',
    '-maxdepth',
    '2',
    '-name',
    'session-42.jsonl',
  ])
})

test('the nudge prefix is the sibling nudge text and a space', () => {
  expect(NUDGE_PREFIX).toBe('STOP JUDGE — ')
})

test('the model request is the one request constant plus the system text and the user message', () => {
  expect(JUDGE_REQUEST).toEqual({ model: 'haiku', maxTokens: 300, effort: 'low', timeoutMs: 20_000 })
  expect(judgeRequest('Done.', 'go', ['earlier'], { minutes: 7, isLowerBound: false })).toEqual({ ...JUDGE_REQUEST, system: buildSystem(), prompt: buildUser('Done.', 'go', ['earlier'], 7) })
  expect(judgeRequest('Done.', 'go', [], null)).toEqual({ ...JUDGE_REQUEST, system: buildSystem(), prompt: buildUser('Done.', 'go', [], null) })
  const on = judgeRequest('Done.', 'go', [], { minutes: 40, isLowerBound: true }, true)
  expect(on.system).toBe(buildSystem(true))
  expect(on.prompt).toContain("Minutes since the operator's last typed message: more than 40\n")
  expect(judgeRequest('Done.', 'go', [], { minutes: 40, isLowerBound: false }, true).prompt).toContain("Minutes since the operator's last typed message: 40\n")
})

test('the minutes fact ships off: the request is the measured round-3 text alone', () => {
  expect(MINUTES_FACT).toBe(false)
  const off = judgeRequest('Done.', 'go', ['earlier'], { minutes: 40, isLowerBound: true })
  expect(off.system).toBe(PROMPT)
  expect(off.prompt).toBe(buildUser('Done.', 'go', ['earlier'], null, false, true))
})

test('a reply maps to the logged outcome: cut call, failed call, no verdict, the gate', () => {
  expect(judgeOutcome({ isAnswered: false, reason: 'aborted' })).toEqual({ outcome: 'pass-timeout', reason: 'aborted', verdict: null })
  expect(judgeOutcome({ isAnswered: false, reason: 'api-error', error: 'rate_limit' })).toEqual({ outcome: 'pass-error', reason: 'api-error rate_limit', verdict: null })
  expect(judgeOutcome({ isAnswered: false, reason: 'empty-reply' })).toEqual({ outcome: 'pass-error', reason: 'empty-reply', verdict: null })
  expect(judgeOutcome({ isAnswered: true, text: 'no json' })).toEqual({ outcome: 'pass-error', reason: 'no verdict in: no json', verdict: null })
  const sure = judgeOutcome({ isAnswered: true, text: '{"verdict":"continue","confidence":0.9,"reason":"Run it"}' })
  expect(sure).toMatchObject({ outcome: 'continue', reason: 'Run it', verdict: { verdict: 'continue', reason: 'Run it' } })
  expect(judgeOutcome({ isAnswered: true, text: '{"verdict":"continue","confidence":0.5,"reason":"Run it"}' }).outcome).toBe('stop-lowconf')
  expect(judgeOutcome({ isAnswered: true, text: '{"verdict":"stop","reason":"asks"}' }).outcome).toBe('stop')
})

test('every outcome the judge logs is in the one outcome list, once', () => {
  expect(new Set(OUTCOMES).size).toBe(OUTCOMES.length)
  expect(OUTCOMES).toHaveLength(13)
  for (const o of ['continue', 'stop', 'stop-lowconf', 'pass-off', 'pass-keepalive', 'pass-typing', 'pass-timeout', 'pass-error']) expect(OUTCOMES).toContain(o)
})
