import { expect, test } from 'claude-code/testing'
import { bucketOf, report, signTest } from '../hooks/compare'
import { keyFrom } from '../hooks/extract'
import { gradesFrom } from '../hooks/score'
import type { Arm, RunRecord } from '../hooks/score'
import { GRADES, RECORDS } from '../fixtures/samples'

test('signTest is the exact two-sided sign test', () => {
  expect(signTest(0, 0)).toBe(1)
  expect(signTest(1, 1)).toBe(1)
  expect(signTest(5, 0)).toBe(0.0625)
  expect(signTest(8, 2).toFixed(6)).toBe('0.109375')
  // Symmetric in its arguments.
  expect(signTest(2, 8)).toBe(signTest(8, 2))
  expect(signTest(0, 5)).toBe(0.0625)
  // Capped at 1 where the two tails meet.
  expect(signTest(3, 3)).toBe(1)
})

test('bucketOf puts the minutes in their bucket at each boundary, and a missing fact in none', () => {
  const cases: [number | null, string][] = [
    [0, '<5'],
    [4, '<5'],
    [5, '5-29'],
    [29, '5-29'],
    [30, '30-119'],
    [119, '30-119'],
    [120, '120+'],
    [100_000, '120+'],
    [null, 'none'],
  ]
  expect(cases.map(([m]) => bucketOf(m))).toEqual(cases.map(([, b]) => b))
})

type Spec = { minutes: number | null; lower?: boolean; off: string; on: string }
// Per call: 'B' block (continue), 's' stop, 'E' error (a timeout).
const rec = (id: string, arm: Arm, repeat: number, mark: string, spec: Spec): RunRecord => ({
  id,
  arm,
  repeat,
  live: '',
  new: mark === 'B' ? 'continue' : mark === 's' ? 'stop' : null,
  new_outcome: mark === 'B' ? 'continue' : mark === 's' ? 'stop' : 'pass-timeout',
  conf: mark === 'E' ? null : 0.9,
  shape: null,
  reason: '',
  text: '',
  ms: 1,
  error: mark === 'E' ? 'aborted' : '',
  minutes_since_operator: spec.minutes,
  is_lower_bound: spec.lower ?? false,
})

// Marks are "<off #1><off #2>" and "<on #1><on #2>".
const SPECS: Record<string, Spec> = {
  S1: { minutes: 3, off: 'ss', on: 'ss' },
  S2: { minutes: 10, off: 'Bs', on: 'BB' },
  S3: { minutes: 45, lower: true, off: 'ss', on: 'BB' },
  S4: { minutes: 10, off: 'BE', on: 'ss' },
  C1: { minutes: 10, off: 'BB', on: 'BB' },
  C2: { minutes: null, off: 'sB', on: 'ss' },
  C3: { minutes: 200, off: 'ss', on: 'BB' },
  U1: { minutes: 10, off: 'Bs', on: 'Bs' },
}
const RUN: RunRecord[] = []
for (let repeat = 1; repeat <= 2; repeat++) {
  for (const [id, spec] of Object.entries(SPECS)) {
    RUN.push(rec(id, 'off', repeat, spec.off[repeat - 1]!, spec))
    RUN.push(rec(id, 'on', repeat, spec.on[repeat - 1]!, spec))
  }
}
const KEY = Object.fromEntries(Object.entries({ S1: 'stop', S2: 'continue', S3: 'stop', S4: 'stop', C1: 'continue', C2: 'stop', C3: 'stop', U1: 'stop' }).map(([id, outcome]) => [id, { outcome }]))
const GRADE_LINES = [
  ['S1', 'stop', 'answer', 'high'],
  ['S2', 'stop', 'consulted', 'high'],
  ['S3', 'stop', 'waiting-background', 'medium'],
  ['S4', 'stop', 'operator-only', 'high'],
  ['C1', 'continue', 'offer', 'high'],
  ['C2', 'continue', 'permission', 'low'],
  ['C3', 'continue', 'options', 'medium'],
].map(([id, verdict, c, confidence]) => JSON.stringify({ id, verdict, case: c, confidence }))

test('report on a hand-built paired run prints the hand-computed lines', () => {
  const lines = report(RUN, KEY, gradesFrom([GRADE_LINES.join('\n')]), ['off', 'on'], 2).split('\n')
  expect(lines).toEqual([
    'calls 32: 8 records × 2 arms × 2 repeats; errors 1',
    'ungraded or not in the key (not scored): 1',
    'live (logged at the firing): false-block 1/4 = 25.0% | catch 1/3 = 33.3%',
    'off #1: false-block 2/4 = 50.0% | catch 1/3 = 33.3%',
    'off #2: false-block 0/3 = 0.0% | catch 2/3 = 66.7%',
    'on #1: false-block 2/4 = 50.0% | catch 2/3 = 66.7%',
    'on #2: false-block 2/4 = 50.0% | catch 2/3 = 66.7%',
    'noise, records that differ between two repeats of one arm: off 2.0, on 0.0',
    'arms, records that differ between off and on in one repeat: 3.5',
    'graded stop: on blocks more on 2, off on 1, sign test p=1.000',
    'graded continue: on catches more on 1, off on 1, sign test p=1.000',
    `by gap (minutes since the operator's last typed message; blocks/calls over all repeats; "+a/-b": records on blocks more/less):`,
    '  <5: stop 1, continue 0 | off false-block 0/2 catch 0/0 | on false-block 0/2 catch 0/0 | on vs off: stop +0/-0 continue +0/-0',
    '  5-29: stop 2, continue 1 | off false-block 2/3 catch 2/2 | on false-block 2/4 catch 2/2 | on vs off: stop +1/-1 continue +0/-0',
    '  30-119: stop 1, continue 0, lower bounds 1 | off false-block 0/2 catch 0/0 | on false-block 2/2 catch 0/0 | on vs off: stop +1/-0 continue +0/-0',
    '  120+: stop 0, continue 1 | off false-block 0/0 catch 0/2 | on false-block 0/0 catch 2/2 | on vs off: stop +0/-0 continue +1/-0',
    '  none: stop 0, continue 1 | off false-block 0/0 catch 1/2 | on false-block 0/0 catch 0/2 | on vs off: stop +0/-0 continue +0/-1',
    'off false blocks: [S2 consulted 1/2, S4 operator-only 1/1]',
    'off misses: [C2 low permission 1/2, C3 medium options 0/2]',
    'on false blocks: [S2 consulted 2/2, S3 waiting-background 2/2]',
    'on misses: [C2 low permission 0/2]',
    'differ, read these by hand: [S2 stop 10m off 1/2 on 2/2, S3 stop >45m off 0/2 on 2/2, S4 stop 10m off 1/1 on 0/2, C2 continue none off 1/2 on 0/2, C3 continue 200m off 0/2 on 2/2]',
  ])
})

test('report of one arm and one repeat leaves out the noise, arms and difference lines', () => {
  const run: RunRecord[] = [
    ['F0001', 's'],
    ['F0002', 's'],
    ['F0003', 'B'],
    ['F0004', 'B'],
    ['F0005', 's'],
    ['F0006', 'B'],
    ['F0007', 'E'],
    ['F0008', 's'],
  ].map(([id, mark]) => rec(id!, 'off', 1, mark!, { minutes: null, off: '', on: '' }))
  const lines = report(run, keyFrom(RECORDS), gradesFrom([GRADES]), ['off'], 1).split('\n')
  expect(lines).toEqual([
    'calls 8: 8 records × 1 arm × 1 repeat; errors 1',
    'live (logged at the firing): false-block 1/3 = 33.3% | catch 2/4 = 50.0%',
    'off #1: false-block 1/3 = 33.3% | catch 2/4 = 50.0%',
    `by gap (minutes since the operator's last typed message; blocks/calls over all repeats; "+a/-b": records on blocks more/less):`,
    '  none: stop 3, continue 4 | off false-block 1/3 catch 2/4',
    'off false blocks: [F0006 waiting-background 1/1]',
    'off misses: [F0005 medium options 0/1, F0008 low permission 0/1]',
  ])
})
