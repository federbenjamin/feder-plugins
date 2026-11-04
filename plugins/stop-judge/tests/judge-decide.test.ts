import { expect, test } from 'claude-code/testing'
import { JUDGE_REQUEST } from '../hooks/config.ts'
import { capturePath, guardOutcome, isNudgeLate, isScratchProject, isScriptedRun, judgeRequest, NUDGE_PREFIX, nudgeText, OUTCOMES, splitTurn, transcriptFindArgv } from '../hooks/judge.ts'
import { PROMPT } from '../hooks/prompt.ts'

const pluginOpening = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: text },
  origin: { kind: 'plugin', name: 'stop-judge', asUser: true },
  promptSource: 'system',
  turnOrigin: 'system',
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

test('a nudge names the step, then says to use a subagent while a question waits', () => {
  const want = 'STOP JUDGE — nothing holds it: Run the suite. If you left the operator a question or decision, do this in a subagent so you can take it up when they return.'
  expect(nudgeText('nothing holds it: Run the suite.')).toBe(want)
  expect(nudgeText('nothing holds it: Run the suite')).toBe(want)
})

test('the transcript lookup is scoped to one session file below the projects directory', () => {
  expect(transcriptFindArgv('/synthetic-home', 'session-42')).toEqual(['find', '/synthetic-home/.claude/projects', '-maxdepth', '2', '-name', 'session-42.jsonl'])
})

test('the nudge prefix is the sibling nudge text and a space', () => {
  expect(NUDGE_PREFIX).toBe('STOP JUDGE — ')
})

test('the fixed instructions are marked for the prompt cache and the turn\'s input follows unmarked', () => {
  expect(judgeRequest('the input')).toEqual({ ...JUDGE_REQUEST, system: [{ text: PROMPT, cache: true }], prompt: 'the input' })
  expect(judgeRequest('the input', 'a candidate').system).toEqual([{ text: 'a candidate', cache: true }])
})

test('the reply\'s cap leaves room for the longest measured reply and the request is haiku, low effort, 20 s', () => {
  expect(JUDGE_REQUEST).toEqual({ model: 'haiku', maxTokens: 1024, effort: 'low', timeoutMs: 20_000 })
})

test('every outcome the judge logs is in the one outcome list, once', () => {
  expect(new Set(OUTCOMES).size).toBe(OUTCOMES.length)
  expect(OUTCOMES).toEqual(['continue', 'stop', 'pass-off', 'pass-subagent', 'pass-aborted', 'pass-nested', 'pass-scripted', 'pass-nudged', 'pass-keepalive', 'pass-notext', 'pass-typing', 'pass-late', 'pass-timeout', 'pass-error'])
})

test('a scratch project folder counts whole or up to a dash', () => {
  for (const name of ['-tmp', '-private-tmp', '-tmp-x', '-private-tmp-claude-t45', '-private-var-folders-g4', '-var-folders-ab']) expect(isScratchProject(name)).toBe(true)
  for (const name of ['-home-u-app', '-tmpfiles', '-private-tmpl', '-Users-u-tmp']) expect(isScratchProject(name)).toBe(false)
})

test('a print-mode run in a scratch folder is scripted; in a repo, or with a person there, it is not', () => {
  const scratch = '/home/u/.claude/projects/-private-tmp/s.jsonl'
  const repo = '/home/u/.claude/projects/-home-u-app/s.jsonl'
  expect(isScriptedRun(false, scratch)).toBe(true)
  expect(isScriptedRun(false, repo)).toBe(false)
  expect(isScriptedRun(true, scratch)).toBe(false)
})

test('a nudge is late with a newer turn running or already over; it holds for the turn last to end', () => {
  expect(isNudgeLate({ isTurnRunning: false, lastEnded: 't1', judged: 't1' })).toBe(false)
  expect(isNudgeLate({ isTurnRunning: true, lastEnded: 't1', judged: 't1' })).toBe(true)
  expect(isNudgeLate({ isTurnRunning: false, lastEnded: 't2', judged: 't1' })).toBe(true)
})

test('the capture file is one per session under its own folder', () => {
  expect(capturePath('/d', 's1')).toBe('/d/stop-judge-captures/s1.jsonl')
})
