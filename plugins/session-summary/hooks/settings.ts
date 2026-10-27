import type { Source, Summary } from '../types'
import { EVERY_SECONDS, FIRST_SECONDS } from './config.ts'
import { DEFAULT_VARIANT, isVariant } from './prompts.ts'
import { isFlag, isOneOf, isPositiveInteger, parseCommand, positiveInteger, readSettings } from './shared/settings.ts'
import type { Grammar } from './shared/settings.ts'

// The /session-summary command's pure side: the stored settings, the grammar, the show text.

export type Settings = { isOff: boolean; firstSeconds: number; everySeconds: number; source: Source; variant: string }

export const DEFAULT_SETTINGS: Settings = Object.freeze({ isOff: false, firstSeconds: FIRST_SECONDS, everySeconds: EVERY_SECONDS, source: 'messages', variant: DEFAULT_VARIANT })

export const isSource = isOneOf<Source>(['messages', 'session-log'])
const isVariantName = (v: unknown): v is string => typeof v === 'string' && isVariant(v)

export function settingsFrom(value: unknown): Settings {
  return readSettings(value, DEFAULT_SETTINGS, { isOff: isFlag, firstSeconds: isPositiveInteger, everySeconds: isPositiveInteger, source: isSource, variant: isVariantName })
}

export type Action =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'show' }
  | { kind: 'now' }
  | { kind: 'usage' }
  | { kind: 'first'; seconds: number }
  | { kind: 'every'; seconds: number }
  | { kind: 'source'; source: Source }
  | { kind: 'variant'; variant: string }

export const USAGE = '/session-summary [on|off|first <seconds>|every <seconds>|source messages|session-log|variant <name>|show|now]'

const seconds =
  (kind: 'first' | 'every') =>
  (word: string): Action | undefined => {
    const n = positiveInteger(word)
    return n === undefined ? undefined : { kind, seconds: n }
  }

const GRAMMAR: Grammar<Action> = {
  empty: { kind: 'show' },
  words: { on: { kind: 'on' }, off: { kind: 'off' }, show: { kind: 'show' }, now: { kind: 'now' } },
  valued: {
    first: seconds('first'),
    every: seconds('every'),
    source: v => (isSource(v) ? { kind: 'source', source: v } : undefined),
    variant: v => (isVariant(v) ? { kind: 'variant', variant: v } : undefined),
  },
  usage: { kind: 'usage' },
}

export function summaryCommand(args: string): Action {
  return parseCommand(args, GRAMMAR)
}

export type Calls = { count: number; input: number; output: number; cached: number; usd: number }

export function showText(info: { summary: Summary; settings: Settings; calls: Calls; capturePath: string | null; now: number }): string {
  const { summary: s, settings: t, calls: c } = info
  const updated = s.at === 0 ? 'never' : `${Math.floor((info.now - s.at) / 60_000)} min ago (${s.status})`
  return [
    `Title: ${s.title || '(none yet)'}`,
    `Last prompt: ${s.lastPrompt || '(none yet)'}`,
    `So far: ${s.soFar || '(none yet)'}`,
    `Now: ${s.now || '(none yet)'}`,
    `Files: ${s.files.join(', ') || 'none'}`,
    `updated: ${updated}`,
    `settings: ${t.isOff ? 'off' : 'on'} · first ${t.firstSeconds}s · every ${t.everySeconds}s · source ${t.source} · variant ${t.variant}`,
    `this session: ${c.count} calls · in ${c.input} · out ${c.output} · cached ${c.cached} · $${c.usd.toFixed(4)}`,
    `capture: ${info.capturePath ?? '(no state dir)'}`,
  ].join('\n')
}
