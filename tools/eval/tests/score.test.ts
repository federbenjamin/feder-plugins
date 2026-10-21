import { expect, test } from 'claude-code/testing'
import { keyFrom } from '../hooks/extract'
import { gradesFrom, parseArgs, scoreRun } from '../hooks/score'
import type { RunRecord } from '../hooks/score'
import { GRADES, RECORDS } from '../fixtures/samples'

const rec = (id: string, outcome: string, conf: number | null, error = ''): RunRecord => ({
  id,
  live: '',
  new: outcome === 'continue' || outcome === 'stop-lowconf' ? 'continue' : error ? null : 'stop',
  new_outcome: outcome,
  conf,
  shape: null,
  reason: '',
  ms: 1,
  error,
  minutes_since_operator: null,
})

test('scoreRun on the sample fixtures prints the hand-computed counts, errors left out of every ratio', () => {
  const run = [
    rec('F0001', 'stop', 0.9),
    rec('F0002', 'stop', 0.8),
    rec('F0003', 'continue', 0.9),
    rec('F0004', 'continue', 0.8),
    rec('F0005', 'stop-lowconf', 0.5),
    rec('F0006', 'continue', 0.75),
    rec('F0007', 'pass-timeout', null, 'aborted'),
    rec('F0008', 'stop', 0.9),
  ]
  const key = keyFrom(RECORDS)
  expect(Object.keys(key)).toHaveLength(8)
  expect(scoreRun(run, key, gradesFrom([GRADES])).split('\n')).toEqual([
    'live: false-block 1/3 = 33.3% | catch 2/4 = 50.0%',
    'new: false-block 1/3 = 33.3% | catch 2/4 = 50.0%',
    'high-confidence continue caught: live 1 new 2 of 2',
    'new false blocks: [F0006 waiting-background 0.75]',
    'new misses: [F0005 medium options, F0008 low permission]',
    'errors 1',
  ])
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
