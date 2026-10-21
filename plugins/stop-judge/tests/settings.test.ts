import { expect, test } from 'claude-code/testing'
import { settingsFrom, statusLine, statusText, stopJudgeCommand, USAGE } from '../hooks/settings.ts'

test('an invalid stored field defaults to on without discarding an independent setting', async () => {
  const defaults = { isOff: false, isContextOff: false }

  expect(settingsFrom(undefined)).toEqual(defaults)
  expect(settingsFrom(null)).toEqual(defaults)
  expect(settingsFrom({ isOff: true, isContextOff: 'yes' })).toEqual({ isOff: true, isContextOff: false })
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
  })).toBe('off · context: on · last 7 days: continue 3, stop 40, pass-off 1 · DECISIONS.md: 24 lines (2026-10-20)')
})

test('the status report says none when no outcomes or decisions file exist', async () => {
  expect(statusText({
    settings: { isOff: false, isContextOff: true },
    counts: {},
    decisions: null,
  })).toBe('on · context: off · last 7 days: none · DECISIONS.md: none')
})

test('the status line carries the judge-off marker and a derive run, either or both', () => {
  expect(statusLine({ isOff: false })).toBeUndefined()
  expect(statusLine({ isOff: true })).toBe('stop-judge off')
  expect(statusLine({ isOff: false }, 'derive 2/5')).toBe('derive 2/5')
  expect(statusLine({ isOff: true }, 'derive 2/5')).toBe('stop-judge off · derive 2/5')
})

test('a judge outcome the order does not name sorts after every named one', () => {
  const text = statusText({ settings: { isOff: false, isContextOff: false }, counts: { 'pass-error': 1, zeta: 1, continue: 2, 'pass-typing': 3 }, decisions: null })
  expect(text).toContain('last 7 days: continue 2, pass-typing 3, pass-error 1, zeta 1 · ')
})
