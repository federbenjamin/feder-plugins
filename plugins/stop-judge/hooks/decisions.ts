// DECISIONS.md: its format, the check every derived file passes before it is written, and the
// fit to the SessionStart context budget.

export const BULLET_RE = /^- .+ -- "[^"]{1,200}"(?: "[^"]{1,200}")? \(\d{4}-\d{2}-\d{2}\)$/
// Under the 10,000-char cap a SessionStart hook's output gets.
export const CONTEXT_MAX_CHARS = 9000
export const DEFAULT_LINE = 'Decide everything you can yourself. Bring only what is listed under "Bring to me" to the operator.'
export const BRING = '## Bring to me'
export const HOW = '## How to work with me'
export const PRINCIPLES = '## Principles'

const HEADER_RE = /^# Decisions \(derived (\d{4}-\d{2}-\d{2}), (\d+) sessions, [^)]+\)$/
const TOPIC_RE = /^### \S/
const QUOTES_RE = / -- ("[^"]{1,200}"(?: "[^"]{1,200}")?) \((\d{4}-\d{2}-\d{2})\)$/

export function decisionsPath(dir: string): string {
  return `${dir}/DECISIONS.md`
}

export function headerLine(date: string, sessions: number, window: string): string {
  return `# Decisions (derived ${date}, ${sessions} sessions, ${window})`
}

// The model writes a header of its own; the run's counts replace it.
export function withHeader(text: string, header: string): string {
  const lines = text.trim().split('\n')
  if (lines[0]?.startsWith('# Decisions')) lines.shift()
  return `${header}\n${lines.join('\n').replace(/^\n*/, '\n')}\n`
}

type Fail = { ok: false; line: number; text: string }

export function validateDecisions(text: string): { ok: true } | Fail {
  const lines = text.split('\n')
  const fail = (i: number): Fail => ({ ok: false, line: i + 1, text: lines[i] ?? '' })
  let i = 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  if (!HEADER_RE.test(lines[i] ?? '')) return fail(i)
  let stage: 'head' | 'default' | 'bring' | 'how' | 'principles' = 'head'
  let topic = false
  for (i++; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    if (stage === 'head' && line === DEFAULT_LINE) stage = 'default'
    else if (stage === 'default' && line === BRING) stage = 'bring'
    else if (stage === 'bring' && line === HOW) stage = 'how'
    else if (stage === 'how' && line === PRINCIPLES) [stage, topic] = ['principles', false]
    else if ((stage === 'how' || stage === 'principles') && TOPIC_RE.test(line)) topic = true
    else if ((stage === 'bring' || topic) && BULLET_RE.test(line)) continue
    else return fail(i)
  }
  const missing = { head: 'the default line', default: BRING, bring: HOW, how: PRINCIPLES, principles: '' }[stage]
  return stage === 'principles' ? { ok: true } : { ok: false, line: lines.length, text: `missing ${missing}` }
}

export type Topic = { heading: string; bullets: string[] }

export function parseDecisions(text: string): { date: string | null; sessions: number | null; bring: string[]; how: Topic[]; principles: Topic[] } {
  let date: string | null = null
  let sessions: number | null = null
  const bring: string[] = []
  const how: Topic[] = []
  const principles: Topic[] = []
  let section: 'none' | 'bring' | Topic[] = 'none'
  for (const line of text.split('\n')) {
    const header = HEADER_RE.exec(line)
    if (header && date === null) {
      date = header[1]!
      sessions = Number(header[2])
    } else if (line === BRING) section = 'bring'
    else if (line === HOW) section = how
    else if (line === PRINCIPLES) section = principles
    else if (Array.isArray(section) && TOPIC_RE.test(line)) section.push({ heading: line.slice(4).trim(), bullets: [] })
    else if (line.startsWith('- ')) {
      if (section === 'bring') bring.push(line)
      else if (Array.isArray(section)) section.at(-1)?.bullets.push(line)
    }
  }
  return { date, sessions, bring, how, principles }
}

export type DatedQuote = { quote: string; date: string }

export function datedQuotesOf(text: string): DatedQuote[] {
  const out: DatedQuote[] = []
  for (const line of text.split('\n')) {
    if (!BULLET_RE.test(line)) continue
    const m = QUOTES_RE.exec(line)
    if (!m) continue
    for (const q of m[1]!.matchAll(/"([^"]+)"/g)) out.push({ quote: q[1]!, date: m[2]! })
  }
  return out
}

export function quotesOf(text: string): string[] {
  return datedQuotesOf(text).map(q => q.quote)
}

// The one quote normalizer: the file writes a transcript's `"` as `'`, and whitespace runs count
// as one space. Reader quotes are checked against the batch through it, file quotes against those.
export function quoteKey(text: string): string {
  return text.replace(/"/g, "'").replace(/\s+/g, ' ').trim()
}

// Keeps a bullet only when each of its quotes is part of an allowed quote of the same date: a
// verified reader quote, or one already in the current file. A topic left empty goes with it.
export function keepVerifiedBullets(text: string, allowed: readonly DatedQuote[]): { text: string; dropped: number } {
  const keys = allowed.map(a => ({ key: quoteKey(a.quote), date: a.date }))
  const isAllowed = (q: DatedQuote) => {
    const key = quoteKey(q.quote)
    return key !== '' && keys.some(a => a.date === q.date && a.key.includes(key))
  }
  let dropped = 0
  const kept = text.split('\n').filter(line => {
    if (!line.startsWith('- ')) return true
    const quotes = datedQuotesOf(line)
    if (quotes.length > 0 && quotes.every(isAllowed)) return true
    dropped++
    return false
  })
  return { text: dropEmptyTopics(kept).join('\n'), dropped }
}

function dropEmptyTopics(lines: readonly string[]): string[] {
  return lines.filter((line, i) => {
    if (!TOPIC_RE.test(line)) return true
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!
      if (next.startsWith('- ')) return true
      if (next.startsWith('#')) return false
    }
    return false
  })
}

export function bulletCount(text: string): number {
  return text.split('\n').filter(l => BULLET_RE.test(l)).length
}

// What the SessionStart hook prints: every bullet without its quotes and date. The quotes stay in
// the file as the evidence a refresh checks; an agent reading the operator's words verbatim takes
// on the mood they were typed in. The hook's sed is held to this by scripts/context.test.ts.
export function rulesOnly(text: string): string {
  return text.split('\n').map(line => line.replace(QUOTES_RE, '')).join('\n')
}

// Drops bullets from the end of whichever of How to work with me and Principles holds more, until
// what the hook prints fits, so neither section crowds the other out. Bring to me is never
// dropped, so a file whose Bring to me alone is over the budget stays over it.
export function fitContext(text: string, maxChars: number): string {
  let lines = text.split('\n')
  const bulletsOf = (from: number, to: number) => lines.flatMap((line, i) => (i > from && i < to && line.startsWith('- ') ? [i] : []))
  while (rulesOnly(lines.join('\n')).length > maxChars) {
    const how = lines.indexOf(HOW)
    const principles = lines.indexOf(PRINCIPLES)
    if (how === -1 || principles === -1) break
    const howBullets = bulletsOf(how, principles)
    const principleBullets = bulletsOf(principles, lines.length)
    const last = (howBullets.length >= principleBullets.length ? howBullets : principleBullets).at(-1)
    if (last === undefined) break
    lines = dropEmptyTopics(lines.toSpliced(last, 1))
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
