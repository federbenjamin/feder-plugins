import { expect, test } from 'claude-code/testing'
import { gradesFrom, callsOf, parseArgs, runRecordOf } from '../hooks/score'

test('callsOf puts a record\'s arms side by side and repeats outermost', () => {
  expect(callsOf(['a', 'b'], ['base', 'candidate'], 2)).toEqual([
    { id: 'a', arm: 'base', repeat: 1 },
    { id: 'a', arm: 'candidate', repeat: 1 },
    { id: 'b', arm: 'base', repeat: 1 },
    { id: 'b', arm: 'candidate', repeat: 1 },
    { id: 'a', arm: 'base', repeat: 2 },
    { id: 'a', arm: 'candidate', repeat: 2 },
    { id: 'b', arm: 'base', repeat: 2 },
    { id: 'b', arm: 'candidate', repeat: 2 },
  ])
  expect(callsOf(['a'], ['candidate'], 1)).toEqual([{ id: 'a', arm: 'candidate', repeat: 1 }])
  expect(callsOf([], ['base', 'candidate'], 2)).toEqual([])
})

const call = { id: 'F1', arm: 'candidate', repeat: 2 } as const
const SAID = { operatorText: 'fix it', opening: 'fix it' }
const answers = (over: Record<string, unknown>) => ({ isAnswered: true as const, text: JSON.stringify({ step: 'Run it', blocker: 'none', why: 'an offer', ...over }) })

test('runRecordOf carries the call and the reply text, and the production outcome of the answers', () => {
  expect(runRecordOf(call, 'stop', answers({}), 12, SAID)).toEqual({
    ...call,
    live: 'stop',
    new: 'continue',
    new_outcome: 'continue',
    reason: 'nothing holds it; step: Run it; why: an offer',
    text: answers({}).text,
    ms: 12,
    error: '',
  })
  expect(runRecordOf(call, 'continue', answers({ blocker: 'refused' }), 1, SAID)).toMatchObject({ new: 'stop', new_outcome: 'stop', error: '' })
  expect(runRecordOf(call, 'continue', answers({}), 1, { ...SAID, opening: 'propose a fix' })).toMatchObject({ new: 'stop', reason: 'operator asked for a proposal; step: Run it; why: an offer' })
  // The operator's words decide a quote.
  expect(runRecordOf(call, 'stop', answers({ gate_quote: 'fix it' }), 1, SAID).new).toBe('stop')
  expect(runRecordOf(call, 'stop', answers({ gate_quote: 'say go' }), 1, SAID).new).toBe('continue')
})

test('runRecordOf keeps an unanswered call as an error with no text', () => {
  expect(runRecordOf(call, 'continue', { isAnswered: false, reason: 'aborted' }, 20_000, SAID)).toEqual({
    ...call,
    live: 'continue',
    new: null,
    new_outcome: 'pass-timeout',
    reason: '',
    text: '',
    ms: 20_000,
    error: 'aborted',
  })
  const noAnswers = runRecordOf(call, 'stop', { isAnswered: true, text: 'not json' }, 1, SAID)
  expect(noAnswers).toMatchObject({ new: null, new_outcome: 'pass-error', text: 'not json' })
  expect(noAnswers.error).toContain('no answers')
})

test('gradesFrom lets a later file win and skips lines that are not a grade', () => {
  const grades = gradesFrom(['{"id":"a","verdict":"stop","case":"x","confidence":"high"}\nnot json\n{"id":"b","verdict":"maybe"}\n', '{"id":"a","verdict":"continue","case":"y","confidence":"low"}\n'])
  expect(grades).toEqual({ a: { id: 'a', verdict: 'continue', case: 'y', confidence: 'low' } })
})

test('parseArgs reads flags, quoted values, a bare flag and stray words', () => {
  expect(parseArgs('--key /a/key.json --ids "/a b/ids.txt" --workers 2 --dry --out x.jsonl stray')).toEqual({
    key: '/a/key.json',
    ids: '/a b/ids.txt',
    workers: '2',
    dry: 'true',
    out: 'x.jsonl',
    _: 'stray',
  })
  expect(parseArgs('')).toEqual({})
})
