import { expect, test } from 'claude-code/testing'
import { gradesFrom, callsOf, parseArgs, runRecordOf } from '../hooks/score'

test('callsOf puts a record\'s arms side by side and repeats outermost', () => {
  expect(callsOf(['a', 'b'], ['off', 'on'], 2)).toEqual([
    { id: 'a', arm: 'off', repeat: 1 },
    { id: 'a', arm: 'on', repeat: 1 },
    { id: 'b', arm: 'off', repeat: 1 },
    { id: 'b', arm: 'on', repeat: 1 },
    { id: 'a', arm: 'off', repeat: 2 },
    { id: 'a', arm: 'on', repeat: 2 },
    { id: 'b', arm: 'off', repeat: 2 },
    { id: 'b', arm: 'on', repeat: 2 },
  ])
  expect(callsOf(['a'], ['on'], 1)).toEqual([{ id: 'a', arm: 'on', repeat: 1 }])
  expect(callsOf([], ['off', 'on'], 2)).toEqual([])
})

const call = { id: 'F1', arm: 'on', repeat: 2 } as const
const verdict = (v: string, confidence: number) => ({ isAnswered: true as const, text: JSON.stringify({ verdict: v, confidence, reason: 'why', shape: 'offer' }) })

test('runRecordOf carries the call, the reply text and the fact, and the production outcome of a verdict', () => {
  expect(runRecordOf(call, 'stop', verdict('continue', 0.9), 12, { minutes: 40, isLowerBound: true })).toEqual({
    ...call,
    live: 'stop',
    new: 'continue',
    new_outcome: 'continue',
    conf: 0.9,
    shape: 'offer',
    reason: 'why',
    text: verdict('continue', 0.9).text,
    ms: 12,
    error: '',
    minutes_since_operator: 40,
    is_lower_bound: true,
  })
  // Below the confidence gate a continue is logged as stop-lowconf, still a verdict.
  const low = runRecordOf(call, 'stop', verdict('continue', 0.5), 1, null)
  expect(low).toMatchObject({ new: 'continue', new_outcome: 'stop-lowconf', minutes_since_operator: null, is_lower_bound: false })
})

test('runRecordOf keeps an unanswered call as an error with no text, and still carries the fact', () => {
  expect(runRecordOf(call, 'continue', { isAnswered: false, reason: 'aborted' }, 20_000, { minutes: 3, isLowerBound: false })).toEqual({
    ...call,
    live: 'continue',
    new: null,
    new_outcome: 'pass-timeout',
    conf: null,
    shape: null,
    reason: '',
    text: '',
    ms: 20_000,
    error: 'aborted',
    minutes_since_operator: 3,
    is_lower_bound: false,
  })
  const noVerdict = runRecordOf(call, 'stop', { isAnswered: true, text: 'not json' }, 1, null)
  expect(noVerdict).toMatchObject({ new: null, new_outcome: 'pass-error', text: 'not json', conf: null })
  expect(noVerdict.error).toContain('no verdict')
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
