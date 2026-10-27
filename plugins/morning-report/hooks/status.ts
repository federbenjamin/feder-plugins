import { DAY_MS, localDate, plural, type Session } from './pipeline.ts'

// The two files a nightly run writes for people and agents to read: the status (one block per
// stream, carried from the previous status and moved by today's summaries) and the patterns
// catalog (one dated entry per day). The model writes the blocks and the lists; the dates, the
// order, the drops and the file around them are decided here.

export const STREAM_DROP_DAYS = 30
export const DROPPED_HEADING = 'Dropped'
export const LAST_TOUCHED = 'last touched'
export const GOING_WELL = 'Going well'
export const NOT_WORKING = 'Not working'
export const WATCH_FOR = 'Watch for'
export const NOTHING_SEEN = '- Nothing seen.'

export type StreamBlock = { name: string; lastTouched: string; lines: string[] }

const H2 = /^##\s+(.+?)\s*$/
const FENCE = /^\s*(```|~~~)/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TOUCHED = new RegExp(`^\\s*[-*]?\\s*\\**${LAST_TOUCHED}\\**:?\\**\\s*(\\d{4}-\\d{2}-\\d{2})\\b`, 'i')
const STATUS_FILE = /^(\d{4}-\d{2}-\d{2})-status\.md$/

export function statusName(day: string): string {
  return `${day}-status.md`
}

// The newest dated status before `today`: what a run carries forward. Today's own file is never
// read, so a redo starts from the same place as the first run of the day.
export function previousStatusDay(names: readonly string[], today: string): string | undefined {
  return names
    .map(n => STATUS_FILE.exec(n)?.[1])
    .filter((d): d is string => d !== undefined && d < today)
    .sort()
    .at(-1)
}

// The `## <name>` blocks of a status file or of the model's answer, minus the Dropped section and
// anything before the first block. A block without a `last touched: YYYY-MM-DD` line is malformed.
export function parseStreams(text: string): { blocks: StreamBlock[]; malformed: string[] } {
  const blocks: StreamBlock[] = []
  const malformed: string[] = []
  let current: { name: string; lines: string[] } | undefined
  const close = () => {
    if (current === undefined) return
    const touched = current.lines.map(l => TOUCHED.exec(l)?.[1]).find(d => d !== undefined)
    if (touched === undefined) malformed.push(current.name)
    else blocks.push({ name: current.name, lastTouched: touched, lines: trimBlank(current.lines) })
    current = undefined
  }
  let skipping = true
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) continue
    const heading = H2.exec(line)?.[1]
    if (heading !== undefined) {
      close()
      skipping = heading === DROPPED_HEADING
      if (!skipping) current = { name: heading, lines: [] }
      continue
    }
    if (!skipping && current !== undefined) current.lines.push(line.trimEnd())
  }
  close()
  return { blocks, malformed }
}

function trimBlank(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]!.trim() === '') start++
  while (end > start && lines[end - 1]!.trim() === '') end--
  return lines.slice(start, end)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

// A stream silent for STREAM_DROP_DAYS leaves the status: listed once under Dropped on the day it
// goes, then gone, since the next run carries only the kept blocks. Kept blocks are newest first.
export function applyDrops(blocks: readonly StreamBlock[], today: string): { kept: StreamBlock[]; dropped: StreamBlock[] } {
  const silent = (b: StreamBlock) => daysBetween(b.lastTouched, today) >= STREAM_DROP_DAYS
  const newestFirst = [...blocks].sort((a, b) => b.lastTouched.localeCompare(a.lastTouched))
  return { kept: newestFirst.filter(b => !silent(b)), dropped: newestFirst.filter(silent) }
}

// The status answer as blocks, or why it cannot be written. An answer with no block is refused
// only when the window had sessions: a quiet window may leave nothing to carry.
export function statusBlocks(answer: string, sessions: number): { blocks: StreamBlock[] } | { error: string } {
  const { blocks, malformed } = parseStreams(answer)
  if (malformed.length) return { error: `the status answer has ${plural(malformed.length, 'block')} without a "${LAST_TOUCHED}: YYYY-MM-DD" line (${malformed.join(', ')}); nothing written` }
  if (blocks.length === 0 && sessions > 0) return { error: 'the status answer has no stream block (cut off at the token cap?); nothing written' }
  return { blocks }
}

function blockText(b: StreamBlock): string {
  return [`## ${b.name}`, ...b.lines].join('\n')
}

export type StatusFile = { today: string; since: string; until: string; kept: readonly StreamBlock[]; dropped: readonly StreamBlock[] }

export function renderStatus({ today, since, until, kept, dropped }: StatusFile): string {
  const parts = [
    `# Status — ${today}`,
    `One block per stream of work seen in Claude Code sessions, the most recently touched first. Written from the sessions ${since} → ${until} and the previous status; a stream silent for ${STREAM_DROP_DAYS} days is listed once under Dropped, then left out. \`waits on: you\` means the person whose sessions these are.`,
    ...(kept.length ? kept.map(blockText) : ['(no streams yet)']),
  ]
  if (dropped.length) {
    parts.push([`## ${DROPPED_HEADING}`, ...dropped.map(b => `- ${b.name}: ${LAST_TOUCHED} ${b.lastTouched}; dropped ${today}`)].join('\n'))
  }
  return parts.join('\n\n') + '\n'
}

export type StatusInput = {
  today: string
  since: string
  until: string
  offsetMinutes: number
  sessions: readonly Session[]
  failed: number
  previousDay: string | undefined
  previous: readonly StreamBlock[]
  summaries: readonly string[]
}

// The sessions list joins each summary's id to its folder and the local date it was last touched.
export function statusPrompt({ today, since, until, offsetMinutes, sessions, failed, previousDay, previous, summaries }: StatusInput): string {
  const dateOf = (iso: string) => {
    const ms = Date.parse(iso)
    return Number.isNaN(ms) ? 'unknown' : localDate(ms, offsetMinutes)
  }
  const sessionLines = sessions.map(s => `- ${s.id}: ${s.project}, last message ${dateOf(s.end)}`)
  return [
    `Today is ${today}. Window: ${since} → ${until}.`,
    `# Sessions in the window (id: folder, local date of the last message)\n${sessionLines.join('\n') || '(none)'}${failed ? `\n- sessions not summarized: ${failed}` : ''}`,
    previousDay === undefined
      ? '# Previous status\n(none: this is the first status)'
      : `# Previous status (${previousDay})\n${previous.map(blockText).join('\n\n') || '(no streams)'}`,
    `# Session summaries for the window\n${summaries.join('\n\n') || '(no sessions in the window)'}`,
  ].join('\n\n')
}

// The profile's `## Watch for` section, or undefined when it is missing, empty or `(none)`.
export function watchFor(profile: string | undefined): string | undefined {
  if (profile === undefined) return undefined
  const lines = profile.split('\n')
  const start = lines.findIndex(l => H2.exec(l)?.[1]?.split(/\s+—\s+/)[0]?.trim() === WATCH_FOR)
  if (start === -1) return undefined
  const end = lines.findIndex((l, i) => i > start && H2.test(l))
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
  return body === '' || /^\(none\)\.?$/i.test(body) ? undefined : body
}

export type PatternsEntry = { goingWell: string[]; notWorking: string[] }

const LIST_HEADING = /^#{2,4}\s+(.+?)\s*$/
const ITEM = /^\s*[-*]\s+\S/

// The two lists of the patterns answer; undefined when either heading is missing.
export function parsePatterns(answer: string): PatternsEntry | undefined {
  const lists = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of answer.split('\n')) {
    const heading = LIST_HEADING.exec(line)?.[1]?.replace(/:$/, '')
    if (heading !== undefined) {
      current = heading === GOING_WELL || heading === NOT_WORKING ? [] : undefined
      if (current !== undefined) lists.set(heading, current)
      continue
    }
    if (current !== undefined && ITEM.test(line)) current.push(line.trim().replace(/^\*\s+/, '- '))
  }
  const goingWell = lists.get(GOING_WELL)
  const notWorking = lists.get(NOT_WORKING)
  return goingWell && notWorking ? { goingWell, notWorking } : undefined
}

export function patternsEntryText(day: string, entry: PatternsEntry): string {
  const list = (items: readonly string[]) => (items.length ? items.join('\n') : NOTHING_SEEN)
  return `## ${day}\n\n### ${GOING_WELL}\n${list(entry.goingWell)}\n\n### ${NOT_WORKING}\n${list(entry.notWorking)}`
}

export const PATTERNS_HEADER = `# Patterns\n\nWhat went well and what did not, one entry per day, judged by the ${WATCH_FOR} list in profile.md. Oldest first.`

const ENTRY_HEADING = /^## (\d{4}-\d{2}-\d{2})\s*$/

// The catalog with `day`'s entry in place: a rerun for a date replaces that date's entry, and the
// entries stay in date order. Text before the first dated entry is kept as the header.
export function upsertPatterns(file: string, day: string, entryText: string): string {
  const lines = file.split('\n')
  const first = lines.findIndex(l => ENTRY_HEADING.test(l))
  const header = (first === -1 ? file : lines.slice(0, first).join('\n')).trim() || PATTERNS_HEADER
  const entries = new Map<string, string>()
  if (first !== -1) {
    let at: string | undefined
    let body: string[] = []
    const flush = () => {
      if (at !== undefined) entries.set(at, body.join('\n').trim())
    }
    for (const line of lines.slice(first)) {
      const d = ENTRY_HEADING.exec(line)?.[1]
      if (d !== undefined) {
        flush()
        at = d
        body = [line]
      } else body.push(line)
    }
    flush()
  }
  entries.set(day, entryText.trim())
  const ordered = [...entries].filter(([d]) => DATE.test(d)).sort(([a], [b]) => a.localeCompare(b))
  return [header, ...ordered.map(([, text]) => text)].join('\n\n') + '\n'
}

export type PatternsInput = { today: string; since: string; until: string; failed: number; summaries: readonly string[] }

export function patternsPrompt({ today, since, until, failed, summaries }: PatternsInput): string {
  return [
    `Today is ${today}. Window: ${since} → ${until}.${failed ? ` ${plural(failed, 'session')} could not be summarized and are not below.` : ''}`,
    `# Session summaries for the window\n${summaries.join('\n\n')}`,
  ].join('\n\n')
}
