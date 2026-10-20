// The session log's pure side: section parsing, the compaction prune, the template and the
// directive. No `$` here; register.ts does the file I/O.

export const SECTIONS = ['Work log', 'Todo', 'Decisions'] as const
export type Section = (typeof SECTIONS)[number]

export type PruneResult =
  | { ok: true; log: string; archive: string | null; moved: number; warnings: string[] }
  | { ok: false; missing: string[] }

type Line = { text: string; section: Section | null }

const HEADING_RE = /^#{1,2} /
const SECTION_HEADING_RE = /^## (Work log|Todo|Decisions)\s*$/
// `- 14:02Z <fact> (<sha>)`; the time is optional so a hand-kept line without one still prunes.
const WORK_RE = /^- (?:\d{2}:\d{2}Z )?(.*)$/
const TODO_RE = /^- \[([ xX])\](?: (.*))?$/
const QUOTED_REPLACES_RE = /replaces:\s*(?:"([^"]+)"|“([^”]+)”)/g
const COMPACTED = 'compacted'

function sectionLines(log: string): Line[] {
  let section: Section | null = null
  return log.split('\n').map(text => {
    const heading = SECTION_HEADING_RE.exec(text)
    if (heading) {
      section = heading[1] as Section
      return { text, section: null }
    }
    if (HEADING_RE.test(text)) section = null
    return { text, section }
  })
}

function missingSections(lines: Line[]): Section[] {
  const seen = new Set(lines.map(l => SECTION_HEADING_RE.exec(l.text)?.[1]).filter(Boolean))
  return SECTIONS.filter(s => !seen.has(s))
}

// The entry's own words, past the time and the checkbox; null when the line is no entry.
function entryText(line: Line): string | null {
  if (!line.text.startsWith('- ')) return null
  if (line.section === 'Work log') return WORK_RE.exec(line.text)?.[1] ?? line.text.slice(2)
  if (line.section === 'Todo') return TODO_RE.exec(line.text)?.[2] ?? line.text.slice(2)
  return line.text.slice(2)
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

function withoutReplacesClause(text: string): string {
  const i = text.indexOf('replaces:')
  return i === -1 ? text : text.slice(0, i)
}

// The quotes a Decisions line names with `replaces:`: the quoted forms, else the rest of the line.
export function replacesQuotes(text: string): string[] {
  const quoted = [...text.matchAll(QUOTED_REPLACES_RE)].map(m => (m[1] ?? m[2])!)
  if (quoted.length > 0) return quoted
  const i = text.indexOf('replaces:')
  const rest = i === -1 ? '' : text.slice(i + 'replaces:'.length).trim()
  return rest ? [rest] : []
}

const quotes = (text: string, want: string): boolean => squash(withoutReplacesClause(text)).includes(want)

// Indexes of Decisions lines some later Decisions line replaces, plus a warning per unusable quote.
// A quote whose line an earlier prune already archived is settled, not unusable.
function replacedDecisions(lines: Line[], archived: Line[]): { replaced: Set<number>; warnings: string[] } {
  const replaced = new Set<number>()
  const warnings: string[] = []
  const decisions = lines.flatMap((l, i) => (l.section === 'Decisions' && l.text.startsWith('- ') ? [i] : []))
  const archivedDecisions = archived.filter(l => l.section === 'Decisions' && l.text.startsWith('- '))
  decisions.forEach((at, k) => {
    for (const quote of replacesQuotes(lines[at]!.text)) {
      const want = squash(quote)
      const hits = decisions.slice(0, k).filter(i => quotes(lines[i]!.text, want))
      if (hits.length === 1) replaced.add(hits[0]!)
      else if (hits.length === 0 && archivedDecisions.some(l => quotes(l.text, want))) continue
      else warnings.push(`replaces: "${quote}" matches ${hits.length === 0 ? 'no earlier Decisions line' : `${hits.length} earlier Decisions lines`} — none moved`)
    }
  })
  return { replaced, warnings }
}

// Drops blank lines that follow another blank line inside the three sections.
const collapseBlanks = (lines: Line[]): Line[] => lines.filter((l, i) => !(l.section !== null && l.text === '' && i > 0 && lines[i - 1]!.text === ''))

function lastLineOf(lines: Line[], section: Section): number {
  let last = -1
  lines.forEach((l, i) => {
    if ((l.section === section && l.text.trim() !== '') || SECTION_HEADING_RE.exec(l.text)?.[1] === section) last = i
  })
  return last
}

function emptyArchive(sessionId: string): string {
  return [
    `# Session log archive — ${sessionId}`,
    '',
    `Lines moved out of ${sessionId}.md at a compaction, under their section headings.`,
    '',
    ...SECTIONS.flatMap(s => [`## ${s}`, '']),
  ].join('\n')
}

// Appends each section's moved lines at the end of that section of the archive text.
function appendToArchive(archive: string, moved: Map<Section, string[]>): string {
  let lines = sectionLines(archive)
  for (const section of SECTIONS) {
    const add = moved.get(section) ?? []
    if (add.length === 0) continue
    if (lastLineOf(lines, section) === -1) {
      if (lines.length > 0 && lines[lines.length - 1]!.text !== '') lines.push({ text: '', section: null })
      lines.push({ text: `## ${section}`, section: null }, { text: '', section })
    }
    const at = lastLineOf(lines, section)
    const isHeading = SECTION_HEADING_RE.test(lines[at]!.text)
    const block = [...(isHeading ? [''] : []), ...add].map(text => ({ text, section }))
    lines = [...lines.slice(0, at + 1), ...block, ...lines.slice(at + 1)]
  }
  const text = lines.map(l => l.text).join('\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

const hhmm = (d: Date): string => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`

function appendWorkLine(lines: Line[], text: string): Line[] {
  const at = lastLineOf(lines, 'Work log')
  const isHeading = SECTION_HEADING_RE.test(lines[at]!.text)
  const block = [...(isHeading ? [''] : []), text].map(t => ({ text: t, section: 'Work log' as Section }))
  return [...lines.slice(0, at + 1), ...block, ...lines.slice(at + 1)]
}

const isMarker = (line: Line): boolean => line.section === 'Work log' && entryText(line) === COMPACTED

// A line that is no entry (heading comment, blank) and an open Todo never move.
function neverMoves(line: Line): boolean {
  if (entryText(line) === null) return true
  return line.section === 'Todo' && TODO_RE.exec(line.text)?.[1] === ' '
}

// Compaction: appends the marker to the Work log, then moves every Work-log line above the
// PREVIOUS marker (a line lives in the log across exactly one compaction, the one whose summary
// might drop it), every `[x]` Todo, and every Decisions line a later one replaces. A `[ ]` Todo
// and any Decisions line nothing replaces stay. A `replaces:` quote matching none or several
// earlier Decisions lines moves nothing and warns.
export function compactSessionLog(log: string, archive: string | null, opts: { sessionId: string; now: Date }): PruneResult {
  const lines = sectionLines(log)
  const missing = missingSections(lines)
  if (missing.length > 0) return { ok: false, missing }

  const previousMarker = lines.reduce((at, l, i) => (isMarker(l) ? i : at), -1)
  const { replaced, warnings } = replacedDecisions(lines, archive === null ? [] : sectionLines(archive))
  const moves = (line: Line, i: number): boolean =>
    (line.section === 'Work log' && i < previousMarker) || (line.section === 'Todo' && TODO_RE.exec(line.text)?.[1]?.toLowerCase() === 'x') || (line.section === 'Decisions' && replaced.has(i))

  const movedBySection = new Map<Section, string[]>()
  const kept: Line[] = []
  lines.forEach((line, i) => {
    if (line.section === null || neverMoves(line) || !moves(line, i)) {
      kept.push(line)
      return
    }
    movedBySection.set(line.section, [...(movedBySection.get(line.section) ?? []), line.text])
  })

  const out = appendWorkLine(collapseBlanks(kept), `- ${hhmm(opts.now)} ${COMPACTED}`)
  const moved = [...movedBySection.values()].reduce((n, l) => n + l.length, 0)
  return {
    ok: true,
    log: out.map(l => l.text).join('\n'),
    archive: moved === 0 ? archive : appendToArchive(archive ?? emptyArchive(opts.sessionId), movedBySection),
    moved,
    warnings,
  }
}

export function logPaths(dir: string, sessionId: string): { log: string; archive: string; template: string } {
  const base = `${dir}/session-logs`
  return { log: `${base}/${sessionId}.md`, archive: `${base}/${sessionId}.archive.md`, template: `${base}/TEMPLATE.md` }
}

export function templateText(): string {
  return (
    [
      '# Session log — <session-id>',
      '',
      'Started: <UTC date> · Worktree: <path> · Origin: <the first real user request, one line>',
      '',
      '## Work log',
      '',
      '<!-- Things we DID. Append one line per landed fact: "- HH:MMZ <fact> (<commit sha if any>)". At a compaction the lines older than the previous compaction move to the archive beside this log; never rewrite or delete a line by hand. -->',
      '',
      '## Todo',
      '',
      '<!-- Things LEFT. Append "- [ ] <task>" as tasks appear; flip to "- [x]" when done. A compaction moves the [x] lines to the archive; a [ ] line never moves, so an open question stays banked. Never rewrite or delete a line by hand. -->',
      '',
      '## Decisions',
      '',
      '<!-- Who chose is the first field. "- <date> [user] <ruling>: "<their words>"" only for words said in this session, never an inferred one or one relayed by another session. "- <date> [agent] <what you picked> over <A>, <B>", with " -- <reason>" when the reason is not obvious. A line that supersedes an earlier one ends replaces: "<quote from that line>"; the next compaction then moves the old line to the archive. -->',
    ].join('\n') + '\n'
  )
}

export function directiveText(logPath: string, templatePath: string): string {
  return `SESSION LOG — keep ${logPath} in the format of ${templatePath}; each section comment says what goes in it. Missing: create it from the template at the first real request, or copy the log a handoff doc names. Present: read it before other work; it is the memory across compaction. Append as things happen, never rewrite a line, and update it before ending a multi-step turn. Main session only.`
}
