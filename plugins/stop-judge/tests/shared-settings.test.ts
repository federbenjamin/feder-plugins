import { expect, test } from 'claude-code/testing'
import {
  isFlag,
  isOneOf,
  isPositiveInteger,
  parseCommand,
  positiveInteger,
  readSettings,
  type Checks,
  type Grammar,
} from '../hooks/shared/settings.ts'

type A =
  | { kind: 'status' }
  | { kind: 'off' }
  | { kind: 'on' }
  | { kind: 'derive' }
  | { kind: 'deriveAll' }
  | { kind: 'context'; off: boolean }
  | { kind: 'minutes'; minutes: number }
  | { kind: 'usage' }

const usage: A = { kind: 'usage' }

const grammar: Grammar<A> = {
  empty: { kind: 'status' },
  words: { off: { kind: 'off' }, on: { kind: 'on' }, derive: { kind: 'derive' } },
  valued: {
    context: v => (v === 'off' || v === 'on' ? { kind: 'context', off: v === 'off' } : undefined),
    // Same verb as the bare word above: `derive` alone and `derive all` are different commands.
    derive: v => (v === 'all' ? { kind: 'deriveAll' } : undefined),
  },
  usage,
}

const withOther: Grammar<A> = {
  ...grammar,
  other: word => {
    const minutes = positiveInteger(word)
    return minutes === undefined ? undefined : { kind: 'minutes', minutes }
  },
}

test('no words, however much whitespace, is the grammar\'s empty action', () => {
  expect(parseCommand('', grammar)).toEqual({ kind: 'status' })
  expect(parseCommand('   \t ', grammar)).toEqual({ kind: 'status' })
})

test('a bare verb is looked up in words, with surrounding whitespace ignored', () => {
  expect(parseCommand('off', grammar)).toEqual({ kind: 'off' })
  expect(parseCommand('  on  ', grammar)).toEqual({ kind: 'on' })
})

test('every word is lowercased, the verb and the value alike', () => {
  expect(parseCommand('OFF', grammar)).toEqual({ kind: 'off' })
  expect(parseCommand('Context OFF', grammar)).toEqual({ kind: 'context', off: true })
  expect(parseCommand('CONTEXT On', grammar)).toEqual({ kind: 'context', off: false })
})

test('a verb with a value goes to its valued function with the lowercased value', () => {
  const seen: string[] = []
  const g: Grammar<A> = {
    ...grammar,
    valued: { context: v => (seen.push(v), { kind: 'context', off: false }) },
  }
  parseCommand('context  MiXeD', g)
  expect(seen).toEqual(['mixed'])
})

test('a valued function that refuses its value sends the command to usage', () => {
  expect(parseCommand('context maybe', grammar)).toEqual(usage)
  expect(parseCommand('derive some', grammar)).toEqual(usage)
})

test('a verb that is both bare and valued reads by arity', () => {
  expect(parseCommand('derive', grammar)).toEqual({ kind: 'derive' })
  expect(parseCommand('derive all', grammar)).toEqual({ kind: 'deriveAll' })
})

test('a third word is usage even when the first two would be valid', () => {
  expect(parseCommand('context off now', grammar)).toEqual(usage)
  expect(parseCommand('off now please', grammar)).toEqual(usage)
  expect(parseCommand('12 13 14', withOther)).toEqual(usage)
})

test('a bare-only verb given a value, and an unknown verb with a value, are usage', () => {
  expect(parseCommand('off now', grammar)).toEqual(usage)
  expect(parseCommand('nope on', grammar)).toEqual(usage)
})

test('a valued-only verb with no value, and an unknown lone word, are usage when there is no other', () => {
  expect(parseCommand('context', grammar)).toEqual(usage)
  expect(parseCommand('banana', grammar)).toEqual(usage)
})

test('a lone non-verb word goes to other, lowercased; undefined from other is usage', () => {
  expect(parseCommand('15', withOther)).toEqual({ kind: 'minutes', minutes: 15 })
  expect(parseCommand('soon', withOther)).toEqual(usage)
  const seen: string[] = []
  parseCommand('ABC', { ...grammar, other: w => (seen.push(w), undefined) })
  expect(seen).toEqual(['abc'])
})

test('a verb wins over other, and other never sees a two-word command', () => {
  const calls: string[] = []
  const g: Grammar<A> = { ...grammar, other: w => (calls.push(w), { kind: 'on' }) }
  expect(parseCommand('off', g)).toEqual({ kind: 'off' })
  expect(parseCommand('banana split', g)).toEqual(usage)
  expect(calls).toEqual([])
})

test('prototype keys are not verbs: constructor, __proto__, toString reach usage', () => {
  for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    expect(parseCommand(word, grammar)).toEqual(usage)
    expect(parseCommand(`${word} on`, grammar)).toEqual(usage)
    expect(parseCommand(`context ${word}`, grammar)).toEqual(usage)
  }
  // With `other` present the lone word is the other's to judge, never an inherited function.
  expect(parseCommand('constructor', withOther)).toEqual(usage)
})

test('readSettings: anything but a record reads as every default', () => {
  const defaults = { isOff: false, n: 5 }
  const checks: Checks<typeof defaults> = { isOff: isFlag, n: isPositiveInteger }
  for (const bad of [undefined, null, 'on', 7, true, [], [true, 3]]) {
    expect(readSettings(bad, defaults, checks)).toEqual(defaults)
  }
})

test('readSettings: a bad field falls back alone and the good fields are kept', () => {
  const defaults = { isOff: false, n: 5, mode: 'a' as 'a' | 'b' }
  const checks: Checks<typeof defaults> = { isOff: isFlag, n: isPositiveInteger, mode: isOneOf(['a', 'b']) }
  expect(readSettings({ isOff: true, n: 'many', mode: 'b' }, defaults, checks)).toEqual({ isOff: true, n: 5, mode: 'b' })
  expect(readSettings({ isOff: 'yes', n: 9, mode: 'c' }, defaults, checks)).toEqual({ isOff: false, n: 9, mode: 'a' })
  expect(readSettings({ n: 0 }, defaults, checks)).toEqual(defaults)
})

test('readSettings: a field stored as false or a non-default value is not mistaken for missing', () => {
  const defaults = { isOff: true }
  expect(readSettings({ isOff: false }, defaults, { isOff: isFlag })).toEqual({ isOff: false })
})

test('readSettings: an extra stored field is dropped and the defaults object is not mutated', () => {
  const defaults = { isOff: false, n: 5 }
  const checks: Checks<typeof defaults> = { isOff: isFlag, n: isPositiveInteger }
  const out = readSettings({ isOff: true, n: 2, stale: 'x', __proto__: { n: 99 } }, defaults, checks)
  expect(out).toEqual({ isOff: true, n: 2 })
  expect(Object.keys(out).sort()).toEqual(['isOff', 'n'])
  expect(out).not.toBe(defaults)
  expect(defaults).toEqual({ isOff: false, n: 5 })
})

test('isFlag accepts only real booleans', () => {
  expect(isFlag(true)).toBe(true)
  expect(isFlag(false)).toBe(true)
  for (const v of [0, 1, 'true', 'false', null, undefined, {}, []]) expect(isFlag(v)).toBe(false)
})

test('isPositiveInteger rejects zero, negatives, fractions, unsafe integers and non-numbers', () => {
  expect(isPositiveInteger(1)).toBe(true)
  expect(isPositiveInteger(600)).toBe(true)
  expect(isPositiveInteger(Number.MAX_SAFE_INTEGER)).toBe(true)
  for (const v of [0, -0, -1, 2.5, 2 ** 53, Infinity, NaN, '3', null, undefined, true, [3]]) {
    expect(isPositiveInteger(v)).toBe(false)
  }
})

test('isOneOf accepts exactly the listed strings', () => {
  const isSource = isOneOf(['messages', 'session-log'])
  expect(isSource('messages')).toBe(true)
  expect(isSource('session-log')).toBe(true)
  for (const v of ['Messages', 'session', '', 'toString', 'constructor', 0, null, undefined, ['messages']]) {
    expect(isSource(v)).toBe(false)
  }
})

test('positiveInteger reads digit-only words and refuses everything else', () => {
  expect(positiveInteger('15')).toBe(15)
  expect(positiveInteger('1')).toBe(1)
  // Leading zeros are plain digits.
  expect(positiveInteger('007')).toBe(7)
  for (const w of ['', '0', '00', '-3', '+3', '1.5', '1e3', '0x10', 'abc', '12abc', '9007199254740993']) {
    expect(positiveInteger(w)).toBeUndefined()
  }
  // The caller trims; a padded word is not digits-only.
  expect(positiveInteger(' 2 ')).toBeUndefined()
})
