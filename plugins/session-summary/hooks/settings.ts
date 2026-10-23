import type { Source, Summary } from '../types'
import { EVERY_SECONDS, FIRST_SECONDS } from './config.ts'
import { DEFAULT_VARIANT, isVariant } from './prompts.ts'

// The /session-summary command's pure side: the stored settings, the grammar, the show text.

export type Settings = { isOff: boolean; firstSeconds: number; everySeconds: number; source: Source; variant: string }

export const DEFAULT_SETTINGS: Settings = Object.freeze({ isOff: false, firstSeconds: FIRST_SECONDS, everySeconds: EVERY_SECONDS, source: 'messages', variant: DEFAULT_VARIANT })

const isPositiveInteger = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0
export const isSource = (v: unknown): v is Source => v === 'messages' || v === 'session-log'

export function settingsFrom(value: unknown): Settings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    isOff: v.isOff === true,
    firstSeconds: isPositiveInteger(v.firstSeconds) ? v.firstSeconds : DEFAULT_SETTINGS.firstSeconds,
    everySeconds: isPositiveInteger(v.everySeconds) ? v.everySeconds : DEFAULT_SETTINGS.everySeconds,
    source: isSource(v.source) ? v.source : DEFAULT_SETTINGS.source,
    variant: typeof v.variant === 'string' && isVariant(v.variant) ? v.variant : DEFAULT_SETTINGS.variant,
  }
}

export type Action =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'show' }
  | { kind: 'usage' }
  | { kind: 'first'; seconds: number }
  | { kind: 'every'; seconds: number }
  | { kind: 'source'; source: Source }
  | { kind: 'variant'; variant: string }

export const USAGE = '/session-summary [on|off|first <seconds>|every <seconds>|source messages|session-log|variant <name>|show]'

const seconds = (word: string): number | undefined => {
  if (!/^\d+$/.test(word)) return undefined
  const n = Number(word)
  return isPositiveInteger(n) ? n : undefined
}

export function summaryCommand(args: string): Action {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [verb, arg, extra] = [words[0]?.toLowerCase(), words[1], words[2]]
  if (verb === undefined) return { kind: 'show' }
  if (extra !== undefined) return { kind: 'usage' }
  if (arg === undefined) {
    if (verb === 'on' || verb === 'off' || verb === 'show') return { kind: verb }
    return { kind: 'usage' }
  }
  if (verb === 'first' || verb === 'every') {
    const n = seconds(arg)
    return n === undefined ? { kind: 'usage' } : { kind: verb, seconds: n }
  }
  const value = arg.toLowerCase()
  if (verb === 'source' && isSource(value)) return { kind: 'source', source: value }
  if (verb === 'variant' && isVariant(value)) return { kind: 'variant', variant: value }
  return { kind: 'usage' }
}

export type Calls = { count: number; input: number; output: number; cached: number; usd: number }

export function showText(info: { summary: Summary; settings: Settings; calls: Calls; capturePath: string | null; now: number }): string {
  const { summary: s, settings: t, calls: c } = info
  const updated = s.at === 0 ? 'never' : `${Math.floor((info.now - s.at) / 60_000)} min ago (${s.status})`
  return [
    `So far: ${s.soFar || '(none yet)'}`,
    `Now: ${s.now || '(none yet)'}`,
    `Files: ${s.files.join(', ') || 'none'}`,
    `updated: ${updated}`,
    `settings: ${t.isOff ? 'off' : 'on'} · first ${t.firstSeconds}s · every ${t.everySeconds}s · source ${t.source} · variant ${t.variant}`,
    `this session: ${c.count} calls · in ${c.input} · out ${c.output} · cached ${c.cached} · $${c.usd.toFixed(4)}`,
    `capture: ${info.capturePath ?? '(no state dir)'}`,
  ].join('\n')
}
