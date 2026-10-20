import { expect, test } from 'claude-code/testing'
import { settingsFrom, statusText, stopJudgeCommand, USAGE } from '../hooks/settings.ts'

test('a corrupt stored setting cannot silently disable the judge or its context', async () => {
  const defaults = { isOff: false, isContextOff: false }

  expect(settingsFrom(undefined)).toEqual(defaults)
  expect(settingsFrom(null)).toEqual(defaults)
  expect(settingsFrom({ isOff: true, isContextOff: 'yes' })).toEqual(defaults)
  expect(settingsFrom({ isOff: true, isContextOff: false })).toEqual({ isOff: true, isContextOff: false })
})

test('each documented command selects exactly one action', async () => {
  expect(stopJudgeCommand('')).toEqual({ kind: 'status' })
  expect(stopJudgeCommand(' OFF ')).toEqual({ kind: 'off' })
  expect(stopJudgeCommand('on')).toEqual({ kind: 'on' })
  expect(stopJudgeCommand('context off')).toEqual({ kind: 'context-off' })
  expect(stopJudgeCommand('context ON')).toEqual({ kind: 'context-on' })
  expect(stopJudgeCommand('derive')).toEqual({ kind: 'derive', all: false })
  expect(stopJudgeCommand('derive all')).toEqual({ kind: 'derive', all: true })
})

test('a partial or extended command stays at usage instead of performing a nearby action', async () => {
  for (const args of ['context', 'derive everything', 'off now', 'x']) {
    expect(stopJudgeCommand(args)).toEqual({ kind: 'usage' })
  }
  expect(USAGE).toBe('/stop-judge [off|on|context off|context on|derive [all]]')
})

test('the status report preserves its fixed fields and reports recorded outcomes', async () => {
  expect(statusText({
    settings: { isOff: true, isContextOff: false },
    counts: { continue: 3, stop: 40, 'pass-off': 1 },
    decisions: { lines: 24, date: '2026-10-20' },
  })).toBe('stop-judge: off · context: on · last 7 days: continue 3, stop 40, pass-off 1 · DECISIONS.md: 24 lines (2026-10-20)')
})

test('the status report says none when no outcomes or decisions file exist', async () => {
  expect(statusText({
    settings: { isOff: false, isContextOff: true },
    counts: {},
    decisions: null,
  })).toBe('stop-judge: on · context: off · last 7 days: none · DECISIONS.md: none')
})
