import { expect, test } from 'claude-code/testing'
import { DEFAULT_SETTINGS, settingsFrom, showText, summaryCommand, USAGE } from '../hooks/settings.ts'

const defaults = { isOff: false, firstSeconds: 90, everySeconds: 600, source: 'messages' as const, variant: 'edit' }

test('missing or non-object stored settings use every documented default', () => {
  expect(DEFAULT_SETTINGS).toEqual(defaults)
  for (const value of [undefined, null, false, 'settings', []]) expect(settingsFrom(value)).toEqual(defaults)
})

test('a malformed stored field falls back without discarding its valid neighbours', () => {
  expect(settingsFrom({ isOff: true, firstSeconds: 45, everySeconds: 2.5, source: 'session-log', variant: 'edit' })).toEqual({
    isOff: true,
    firstSeconds: 45,
    everySeconds: 600,
    source: 'session-log',
    variant: 'edit',
  })
  expect(settingsFrom({ isOff: 'true', firstSeconds: 0, everySeconds: -1, source: 'other', variant: 'unknown' })).toEqual(defaults)
})

test('each documented command selects exactly one action', () => {
  expect(summaryCommand('')).toEqual({ kind: 'show' })
  expect(summaryCommand(' ON ')).toEqual({ kind: 'on' })
  expect(summaryCommand('off')).toEqual({ kind: 'off' })
  expect(summaryCommand('show')).toEqual({ kind: 'show' })
  expect(summaryCommand('usage')).toEqual({ kind: 'usage' })
  expect(summaryCommand('FIRST 30')).toEqual({ kind: 'first', seconds: 30 })
  expect(summaryCommand('every 600')).toEqual({ kind: 'every', seconds: 600 })
  expect(summaryCommand('source messages')).toEqual({ kind: 'source', source: 'messages' })
  expect(summaryCommand('source session-log')).toEqual({ kind: 'source', source: 'session-log' })
  expect(summaryCommand('variant EDIT')).toEqual({ kind: 'variant', variant: 'edit' })
})

test('partial, extended, and invalid commands reach usage instead of a nearby action', () => {
  for (const args of ['on now', 'first', 'first 0', 'first -1', 'first 1.5', 'every 3 later', 'source', 'source log', 'variant', 'variant missing', 'nonsense']) {
    expect(summaryCommand(args)).toEqual({ kind: 'usage' })
  }
  expect(USAGE).toBe('/session-summary [on|off|first <seconds>|every <seconds>|source messages|session-log|variant <name>|show]')
})

test('a populated report preserves summary details, settings, usage, and capture location', () => {
  expect(showText({
    summary: { soFar: 'audit complete', now: 'add tests', files: ['src/a.ts', 'src/b.ts'], at: 2_520_000, status: 'ended', source: 'session-log', variant: 'brief' },
    settings: { isOff: true, firstSeconds: 45, everySeconds: 300, source: 'session-log', variant: 'brief' },
    calls: { count: 4, input: 12, output: 3, cached: 8, usd: 0.123456 },
    capturePath: '/state/session-summaries/s1.jsonl',
    now: 3_780_000,
  })).toBe([
    'So far: audit complete',
    'Now: add tests',
    'Files: src/a.ts, src/b.ts',
    'updated: 21 min ago (ended)',
    'settings: off · first 45s · every 300s · source session-log · variant brief',
    'this session: 4 calls · in 12 · out 3 · cached 8 · $0.1235',
    'capture: /state/session-summaries/s1.jsonl',
  ].join('\n'))
})

test('a report without a summary or state directory makes each unavailable value explicit', () => {
  expect(showText({
    summary: { soFar: '', now: '', files: [], at: 0, status: 'running', source: 'messages', variant: 'edit' },
    settings: defaults,
    calls: { count: 0, input: 0, output: 0, cached: 0, usd: 0 },
    capturePath: null,
    now: 1_000_000,
  })).toBe([
    'So far: (none yet)',
    'Now: (none yet)',
    'Files: none',
    'updated: never',
    'settings: on · first 90s · every 600s · source messages · variant edit',
    'this session: 0 calls · in 0 · out 0 · cached 0 · $0.0000',
    'capture: (no state dir)',
  ].join('\n'))
})
