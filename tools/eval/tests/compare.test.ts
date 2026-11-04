import { expect, test } from 'claude-code/testing'
import { report, signTest } from '../hooks/compare'
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

type Spec = { base: string; candidate: string }
// Per call: 'B' block (continue), 's' stop, 'E' error (a timeout).
const rec = (id: string, arm: Arm, repeat: number, mark: string): RunRecord => ({
  id,
  arm,
  repeat,
  live: '',
  new: mark === 'B' ? 'continue' : mark === 's' ? 'stop' : null,
  new_outcome: mark === 'B' ? 'continue' : mark === 's' ? 'stop' : 'pass-timeout',
  reason: '',
  text: '',
  ms: 1,
  error: mark === 'E' ? 'aborted' : '',
})

// Marks are "<base #1><base #2>" and "<candidate #1><candidate #2>".
const SPECS: Record<string, Spec> = {
  S1: { base: 'ss', candidate: 'ss' },
  S2: { base: 'Bs', candidate: 'BB' },
  S3: { base: 'ss', candidate: 'BB' },
  S4: { base: 'BE', candidate: 'ss' },
  C1: { base: 'BB', candidate: 'BB' },
  C2: { base: 'sB', candidate: 'ss' },
  C3: { base: 'ss', candidate: 'BB' },
  U1: { base: 'Bs', candidate: 'Bs' },
}
const RUN: RunRecord[] = []
for (let repeat = 1; repeat <= 2; repeat++) {
  for (const [id, spec] of Object.entries(SPECS)) {
    RUN.push(rec(id, 'base', repeat, spec.base[repeat - 1]!))
    RUN.push(rec(id, 'candidate', repeat, spec.candidate[repeat - 1]!))
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
  const lines = report(RUN, KEY, gradesFrom([GRADE_LINES.join('\n')]), ['base', 'candidate'], 2).split('\n')
  expect(lines).toEqual([
    'calls 32: 8 records × 2 arms × 2 repeats; errors 1',
    'ungraded or not in the key (not scored): 1',
    'live (logged at the firing): false-block 1/4 = 25.0% | catch 1/3 = 33.3%',
    'base #1: false-block 2/4 = 50.0% | catch 1/3 = 33.3%',
    'base #2: false-block 0/3 = 0.0% | catch 2/3 = 66.7%',
    'candidate #1: false-block 2/4 = 50.0% | catch 2/3 = 66.7%',
    'candidate #2: false-block 2/4 = 50.0% | catch 2/3 = 66.7%',
    'noise, records that differ between two repeats of one arm: base 2.0, candidate 0.0',
    'arms, records that differ between base and candidate in one repeat: 3.5',
    'graded stop: candidate blocks more on 2, base on 1, sign test p=1.000',
    'graded continue: candidate catches more on 1, base on 1, sign test p=1.000',
    'base false blocks: [S2 consulted 1/2, S4 operator-only 1/1]',
    'base misses: [C2 low permission 1/2, C3 medium options 0/2]',
    'candidate false blocks: [S2 consulted 2/2, S3 waiting-background 2/2]',
    'candidate misses: [C2 low permission 0/2]',
    'differ, read these by hand: [S2 stop base 1/2 candidate 2/2, S3 stop base 0/2 candidate 2/2, S4 stop base 1/1 candidate 0/2, C2 continue base 1/2 candidate 0/2, C3 continue base 0/2 candidate 2/2]',
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
  ].map(([id, mark]) => rec(id!, 'base', 1, mark!))
  const lines = report(run, keyFrom(RECORDS), gradesFrom([GRADES]), ['base'], 1).split('\n')
  expect(lines).toEqual([
    'calls 8: 8 records × 1 arm × 1 repeat; errors 1',
    'live (logged at the firing): false-block 1/3 = 33.3% | catch 2/4 = 50.0%',
    'base #1: false-block 1/3 = 33.3% | catch 2/4 = 50.0%',
    'base false blocks: [F0006 waiting-background 1/1]',
    'base misses: [F0005 medium options 0/1, F0008 low permission 0/1]',
  ])
})
