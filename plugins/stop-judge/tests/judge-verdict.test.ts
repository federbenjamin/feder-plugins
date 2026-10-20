import { expect, test } from 'claude-code/testing'
import { readFileSync } from 'node:fs'
import { PROMPT } from '../hooks/prompt.ts'
import { buildSystem, buildUser, confidenceOf, MINUTES_FACT, MINUTES_SENTENCE, parseVerdict } from '../hooks/judge.ts'

test('the measured round-three prompt is copied without the retired injection vocabulary', async () => {
  const source = readFileSync(new URL('../../../sources/judge-prompt-r3-generic.txt', import.meta.url), 'utf8')
  expect(PROMPT).toBe(source)
  expect(PROMPT).not.toMatch(/\{\{CONTRACT_RULES\}\}|contract|Next:|grilling|rule 9/i)
})

test('the minutes guidance is added to the system message without changing the measured prompt', async () => {
  expect(buildSystem()).toBe(MINUTES_FACT ? `${PROMPT}\n${MINUTES_SENTENCE}` : PROMPT)
})

test('a measured gap is the last fact before the required JSON response, while no gap is omitted', async () => {
  const withoutGap = [
    '## Earlier operator messages, oldest first',
    '',
    'first request',
    '',
    '---',
    '',
    'review this before you push',
    '',
    '## Operator message that opened the turn',
    '',
    'make the update',
    '',
    "## Agent's final message",
    '',
    'The update is ready.',
    '',
    'One JSON line.',
  ].join('\n')
  const withGap = buildUser('The update is ready.', 'make the update', ['first request', 'review this before you push'], 7)

  if (MINUTES_FACT) {
    expect(withGap).toBe(withoutGap.replace('One JSON line.', "Minutes since the operator's last typed message: 7\n\nOne JSON line."))
  } else {
    expect(withGap).toBe(withoutGap)
  }
  expect(buildUser('The update is ready.', 'make the update', ['first request', 'review this before you push'], null)).toBe(withoutGap)
})

test('a verdict wrapped in model prose preserves its decision, reason, and judging fields', async () => {
  expect(
    parseVerdict('Here is the decision:\n```json\n{"mode":"asking","shape":"offer","confidence":0.82,"verdict":"continue","reason":"The final message ends by offering a runnable step."}\n```'),
  ).toEqual({
    verdict: 'continue',
    reason: 'The final message ends by offering a runnable step.',
    fields: { mode: 'asking', shape: 'offer', confidence: 0.82 },
  })
})

test('a broken model line falls back only when it still names a supported verdict', async () => {
  expect(parseVerdict('prefix {"verdict":"stop","reason":"the operator must choose\nunclosed')).toEqual({
    verdict: 'stop',
    reason: 'the operator must choose',
    fields: {},
  })
  expect(parseVerdict('{"verdict":"defer","reason":"not a judge verdict"}')).toBeNull()
  expect(parseVerdict('no JSON was returned')).toBeNull()
})

test('only a finite confidence inside the closed unit interval can affect a verdict', async () => {
  expect(confidenceOf({ confidence: 0 })).toBe(0)
  expect(confidenceOf({ confidence: 1 })).toBe(1)
  expect(confidenceOf({ confidence: 0.7 })).toBe(0.7)
  for (const confidence of [true, false, '0.8', Number.NaN, Infinity, -0.01, 1.01, null, undefined]) {
    expect(confidenceOf({ confidence })).toBeNull()
  }
})
