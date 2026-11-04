import { expect, test } from 'claude-code/testing'
import { asksForProposal, decide, isOperatorQuote, judgeOutcome, parseAnswers } from '../hooks/decide.ts'

// Answers that leave a step nothing holds; each case changes what its stop reason reads.
const CLEAR = {
  step: 'Run the integration suite',
  blocker: 'none',
  blocker_quote: '',
  in_plan: 'no',
  new_work: 'no',
  effort: 'low',
  reversible: 'easy',
  gate_quote: '',
  open_choice: 'no',
  ban_quote: '',
  instructions_conflict: 'no',
  changes_behavior: 'no',
  states_risk_and_cost: 'no',
  why: 'an offer',
}
const SAID = { operatorText: "fix the importer\nI'm leaning toward A, let's test more\nDon't touch production", opening: 'fix the importer' }
const why = (over: Record<string, unknown>, said = SAID) => decide({ ...CLEAR, ...over }, said).why

test('nothing holding the step means continue', () => {
  expect(decide(CLEAR, SAID)).toEqual({ decision: 'continue', why: 'nothing holds it' })
})

test('each answer stops for its own reason', () => {
  expect(why({ step: 'none' })).toBe('no step left open')
  expect(why({ step: '  ' })).toBe('no step left open')
  expect(why({ step: null })).toBe('no step left open')
  expect(why({ blocker: 'background' })).toBe('blocked: background')
  expect(why({ blocker: 'operator_only' })).toBe('blocked: operator_only')
  expect(why({ gate_quote: "I'm leaning toward A" })).toBe('operator holds it')
  expect(why({ ban_quote: "Don't touch production" })).toBe('operator forbade it')
  expect(why({ instructions_conflict: 'yes' })).toBe('instructions conflict')
  expect(why({ open_choice: 'yes' })).toBe('operator choice open')
  expect(why({ new_work: 'yes' })).toBe('new work')
  expect(why({ changes_behavior: 'yes', effort: 'medium' })).toBe('design open')
  expect(why({ effort: 'high' })).toBe('high effort')
  expect(why({ reversible: 'hard' })).toBe('hard to undo')
})

test('a stop reason earlier in the order wins over every later one', () => {
  const allHeld = {
    step: 'x',
    blocker: 'refused',
    gate_quote: "I'm leaning toward A",
    ban_quote: "Don't touch production",
    instructions_conflict: 'yes',
    open_choice: 'yes',
    new_work: 'yes',
    changes_behavior: 'yes',
    effort: 'high',
    reversible: 'hard',
  }
  const proposal = { ...SAID, opening: 'propose a fix' }
  const order: [Record<string, unknown>, string][] = [
    [{}, 'blocked: refused'],
    [{ blocker: 'none' }, 'operator holds it'],
    [{ blocker: 'none', gate_quote: '' }, 'operator asked for a proposal'],
  ]
  for (const [over, want] of order) expect(why({ ...allHeld, ...over }, proposal)).toBe(want)
  const rest: [Record<string, unknown>, string][] = [
    [{ blocker: 'none', gate_quote: '' }, 'operator forbade it'],
    [{ blocker: 'none', gate_quote: '', ban_quote: '' }, 'instructions conflict'],
    [{ blocker: 'none', gate_quote: '', ban_quote: '', instructions_conflict: 'no' }, 'operator choice open'],
    [{ blocker: 'none', gate_quote: '', ban_quote: '', instructions_conflict: 'no', open_choice: 'no' }, 'new work'],
    [{ blocker: 'none', gate_quote: '', ban_quote: '', instructions_conflict: 'no', open_choice: 'no', new_work: 'no' }, 'design open'],
    [{ blocker: 'none', gate_quote: '', ban_quote: '', instructions_conflict: 'no', open_choice: 'no', new_work: 'no', changes_behavior: 'no' }, 'high effort'],
    [{ blocker: 'none', gate_quote: '', ban_quote: '', instructions_conflict: 'no', open_choice: 'no', new_work: 'no', changes_behavior: 'no', effort: 'low' }, 'hard to undo'],
  ]
  for (const [over, want] of rest) expect(why({ ...allHeld, ...over })).toBe(want)
})

test('a low-effort change goes ahead, and so does one whose risk and cost are stated', () => {
  expect(why({ changes_behavior: 'yes', effort: 'low' })).toBe('nothing holds it')
  expect(why({ changes_behavior: 'yes', effort: 'medium', states_risk_and_cost: 'yes' })).toBe('nothing holds it')
})

test('answers read whatever their case and spacing', () => {
  expect(why({ blocker: ' NONE ', new_work: 'YES' })).toBe('new work')
})

test('the agent\'s own words fail the quote check, so they hold nothing', () => {
  expect(isOperatorQuote('if that works for you', SAID.operatorText)).toBe(false)
  expect(why({ gate_quote: 'say go and I will send it' })).toBe('nothing holds it')
  expect(why({ ban_quote: 'your call' })).toBe('nothing holds it')
})

test('the quote check ignores case and punctuation, and an empty or non-text quote fails', () => {
  expect(isOperatorQuote('LEANING toward a, lets test', "I'm leaning toward A, let's test more")).toBe(false)
  expect(isOperatorQuote('leaning toward a let s test', "I'm leaning toward A, let's test more")).toBe(true)
  expect(isOperatorQuote('DONT', "Don't")).toBe(false)
  expect(isOperatorQuote("don't", "DON'T!")).toBe(true)
  expect(isOperatorQuote('', 'anything')).toBe(false)
  expect(isOperatorQuote('…', 'anything')).toBe(false)
  expect(isOperatorQuote(null, 'null')).toBe(false)
  expect(isOperatorQuote(7, '7')).toBe(false)
})

test('a request for a proposal in the opening stops the step', () => {
  for (const opening of ['Propose a fix', 'write up the proposal', 'three proposals please', 'Maybe we cache it. Thoughts ?', 'what do you think', 'any ideas']) {
    expect(asksForProposal(opening)).toBe(true)
  }
  expect(decide(CLEAR, { ...SAID, opening: 'maybe you could propose something' })).toEqual({ decision: 'stop', why: 'operator asked for a proposal' })
})

test('an opening that asks for no proposal holds nothing, and earlier messages never count', () => {
  for (const opening of ['fix the importer', 'proposed changes are fine, ship', 'my thoughts are below', 'no ideas here', '']) expect(asksForProposal(opening)).toBe(false)
  expect(why({}, { operatorText: 'what do you think?\nfix the importer', opening: 'fix the importer' })).toBe('nothing holds it')
})

test('a match only inside a pasted block is not the operator\'s, and their own words around it still count', () => {
  const pasted = '<pasted_content name="doc">What do you think of this proposal?</pasted_content>'
  expect(asksForProposal(`fix what this says ${pasted}`)).toBe(false)
  expect(asksForProposal(`<pasted_content>any ideas</pasted_content> and <pasted_content id="2">thoughts?</pasted_content> ship it`)).toBe(false)
  expect(asksForProposal(`${pasted} thoughts?`)).toBe(true)
  expect(why({}, { ...SAID, opening: `fix what this says ${pasted}` })).toBe('nothing holds it')
})

test('the proposal stop is its own reason on the firing line and in the decision', () => {
  const judged = judgeOutcome({ isAnswered: true, text: JSON.stringify(CLEAR) }, { ...SAID, opening: 'propose a fix' })
  expect(judged.outcome).toBe('stop')
  expect(judged.reason.startsWith('operator asked for a proposal; step: ')).toBe(true)
  expect(judged.decision).toEqual({ decision: 'stop', why: 'operator asked for a proposal' })
})

test('the answers are the JSON in the reply, first brace to last; none otherwise', () => {
  expect(parseAnswers('Sure:\n```json\n{"step":"none"}\n```')).toEqual({ step: 'none' })
  expect(parseAnswers('{"step":"a {nested} word","why":"x"}')).toEqual({ step: 'a {nested} word', why: 'x' })
  expect(parseAnswers('no json')).toBeNull()
  expect(parseAnswers('{"step":"cut off')).toBeNull()
  expect(parseAnswers('{broken}')).toBeNull()
})

test('a reply maps to the logged outcome: cut call, failed call, no answers, the decision', () => {
  const none = { nudge: '', answers: null, quotes: null, decision: null }
  expect(judgeOutcome({ isAnswered: false, reason: 'aborted' }, SAID)).toEqual({ ...none, outcome: 'pass-timeout', reason: 'aborted' })
  expect(judgeOutcome({ isAnswered: false, reason: 'api-error', error: 'rate_limit' }, SAID)).toEqual({ ...none, outcome: 'pass-error', reason: 'api-error rate_limit' })
  expect(judgeOutcome({ isAnswered: false, reason: 'empty-reply' }, SAID)).toEqual({ ...none, outcome: 'pass-error', reason: 'empty-reply' })
  expect(judgeOutcome({ isAnswered: true, text: 'no json' }, SAID)).toEqual({ ...none, outcome: 'pass-error', reason: 'no answers in: no json' })
})

test('a continue carries the decision and the step in its reason and its nudge; a stop nudges nothing', () => {
  const go = judgeOutcome({ isAnswered: true, text: JSON.stringify(CLEAR) }, SAID)
  expect(go).toMatchObject({ outcome: 'continue', nudge: 'nothing holds it: Run the integration suite', reason: 'nothing holds it; step: Run the integration suite; why: an offer' })
  const stop = judgeOutcome({ isAnswered: true, text: JSON.stringify({ ...CLEAR, gate_quote: "leaning toward A", ban_quote: 'your call' }) }, SAID)
  expect(stop).toMatchObject({ outcome: 'stop', nudge: '', decision: { decision: 'stop', why: 'operator holds it' } })
  expect(stop.quotes).toEqual({ gate: { quote: 'leaning toward A', isOperators: true }, ban: { quote: 'your call', isOperators: false } })
})
