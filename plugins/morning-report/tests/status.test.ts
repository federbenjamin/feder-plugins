import { test, expect } from 'claude-code/testing'
import type { Session } from '../hooks/pipeline.ts'
import {
  applyDrops,
  daysBetween,
  NOTHING_SEEN,
  parsePatterns,
  parseStreams,
  PATTERNS_HEADER,
  patternsEntryText,
  patternsPrompt,
  previousStatusDay,
  renderStatus,
  statusBlocks,
  statusName,
  statusPrompt,
  STREAM_DROP_DAYS,
  upsertPatterns,
  watchFor,
  type StreamBlock,
} from '../hooks/status.ts'

const block = (name: string, lastTouched: string, extra: string[] = []): StreamBlock => ({
  name,
  lastTouched,
  lines: [`- repo: ${name} (\`/work/${name}\`)`, ...extra, `- last touched: ${lastTouched}`],
})

const answer = (...blocks: StreamBlock[]) => blocks.map(b => [`## ${b.name}`, ...b.lines].join('\n')).join('\n\n')

test('previousStatusDay is the newest dated status before today, never today or a later one', async () => {
  expect(statusName('2026-10-06')).toBe('2026-10-06-status.md')
  const names = ['2026-10-01-status.md', '2026-10-04-status.md', '2026-10-05-run.json', '2026-10-06-status.md', '2026-10-07-status.md', 'setup-scan.md']
  expect(previousStatusDay(names, '2026-10-06')).toBe('2026-10-04')
  expect(previousStatusDay(['2026-10-06-status.md'], '2026-10-06')).toBeUndefined()
  expect(previousStatusDay([], '2026-10-06')).toBeUndefined()
})

test('parseStreams reads each block with its last touched date, past a title, fences and the Dropped section', async () => {
  const text = [
    '# Status — 2026-10-06',
    '',
    'intro line',
    '',
    '```',
    '## alpha',
    '- repo: alpha',
    '- **last touched:** 2026-10-05',
    '',
    '## Dropped',
    '- old: last touched 2026-09-01; dropped 2026-10-05',
    '',
    '## beta',
    '- last touched: 2026-10-01',
    '```',
  ].join('\n')
  const { blocks, malformed } = parseStreams(text)
  expect(malformed).toEqual([])
  expect(blocks).toEqual([
    { name: 'alpha', lastTouched: '2026-10-05', lines: ['- repo: alpha', '- **last touched:** 2026-10-05'] },
    { name: 'beta', lastTouched: '2026-10-01', lines: ['- last touched: 2026-10-01'] },
  ])
})

test('a block without a last touched date is malformed, and an answer holding one is refused', async () => {
  const text = '## alpha\n- last touched: 2026-10-05\n\n## beta\n- repo: beta\n- last touched: soon'
  expect(parseStreams(text).malformed).toEqual(['beta'])
  const refused = statusBlocks(text, 3)
  expect('error' in refused && refused.error).toContain('1 block without a "last touched: YYYY-MM-DD" line (beta)')
})

test('an answer with no block is refused when the window had sessions, and taken when it had none', async () => {
  const none = statusBlocks('I could not write the status.', 2)
  expect('error' in none && none.error).toContain('no stream block')
  expect(statusBlocks('', 0)).toEqual({ blocks: [] })
  expect(statusBlocks(answer(block('a', '2026-10-05')), 1)).toEqual({ blocks: [block('a', '2026-10-05')] })
})

test('a stream silent for the drop days moves to dropped, a day short stays, and kept blocks are newest first', async () => {
  expect(STREAM_DROP_DAYS).toBe(30)
  expect(daysBetween('2026-09-06', '2026-10-06')).toBe(30)
  expect(daysBetween('2026-10-06', '2026-10-06')).toBe(0)
  const { kept, dropped } = applyDrops([block('old', '2026-09-06'), block('mid', '2026-10-01'), block('edge', '2026-09-07'), block('new', '2026-10-06')], '2026-10-06')
  expect(kept.map(b => b.name)).toEqual(['new', 'mid', 'edge'])
  expect(dropped.map(b => b.name)).toEqual(['old'])
})

test('renderStatus writes the title, the blocks, and a Dropped section only when a stream dropped today', async () => {
  const base = { today: '2026-10-06', since: '2026-10-05T05:00:00.000Z', until: '2026-10-06T05:00:00.000Z' }
  const text = renderStatus({ ...base, kept: [block('a', '2026-10-06')], dropped: [block('old', '2026-09-01')] })
  expect(text.startsWith('# Status — 2026-10-06\n\n')).toBe(true)
  expect(text).toContain('2026-10-05T05:00:00.000Z → 2026-10-06T05:00:00.000Z')
  expect(text).toContain('## a\n- repo: a (`/work/a`)\n- last touched: 2026-10-06')
  expect(text.endsWith('## Dropped\n- old: last touched 2026-09-01; dropped 2026-10-06\n')).toBe(true)
  const quiet = renderStatus({ ...base, kept: [], dropped: [] })
  expect(quiet).toContain('(no streams yet)')
  expect(quiet).not.toContain('## Dropped')
})

test('a rendered status parses back to its kept blocks, and a dropped stream is not carried to the next day', async () => {
  const kept = [block('a', '2026-10-06', ['- what: the a thing']), block('b', '2026-10-02')]
  const text = renderStatus({ today: '2026-10-06', since: 's', until: 'u', kept, dropped: [block('old', '2026-09-01')] })
  expect(parseStreams(text)).toEqual({ blocks: kept, malformed: [] })
})

test('statusPrompt lists each session with its folder and local date, the previous status, and the summaries', async () => {
  const s = (id: string, end: string): Session => ({ id, project: `/work/${id}`, start: end, end, typed: 1, active_minutes: 5, text: '' })
  const prompt = statusPrompt({
    today: '2026-10-06',
    since: 'S',
    until: 'U',
    offsetMinutes: 300,
    sessions: [s('aaa', '2026-10-06T03:00:00+00:00'), s('bbb', '2026-10-06T12:00:00+00:00')],
    failed: 1,
    previousDay: '2026-10-05',
    previous: [block('a', '2026-10-04')],
    summaries: ['## aaa — one', '## bbb — two'],
  })
  expect(prompt).toBe(
    [
      'Today is 2026-10-06. Window: S → U.',
      '',
      '# Sessions in the window (id: folder, local date of the last message)',
      '- aaa: /work/aaa, last message 2026-10-05',
      '- bbb: /work/bbb, last message 2026-10-06',
      '- sessions not summarized: 1',
      '',
      '# Previous status (2026-10-05)',
      '## a',
      '- repo: a (`/work/a`)',
      '- last touched: 2026-10-04',
      '',
      '# Session summaries for the window',
      '## aaa — one',
      '',
      '## bbb — two',
    ].join('\n'),
  )
  const first = statusPrompt({ today: 't', since: 's', until: 'u', offsetMinutes: 0, sessions: [], failed: 0, previousDay: undefined, previous: [], summaries: [] })
  expect(first).toContain('# Previous status\n(none: this is the first status)')
  expect(first).toContain('# Session summaries for the window\n(no sessions in the window)')
})

test('watchFor reads the Watch for section alone, and nothing when it is missing, empty or (none)', async () => {
  const profile = '## Working on\nthings\n\n## Watch for\n- re-asking\n- long waits\n\n## Track\nhours'
  expect(watchFor(profile)).toBe('- re-asking\n- long waits')
  expect(watchFor('## Watch for — what to notice\n- one')).toBe('- one')
  expect(watchFor('## Watch for\n(none)\n')).toBeUndefined()
  expect(watchFor('## Watch for\n\n## Track\nx')).toBeUndefined()
  expect(watchFor('## Working on\nthings')).toBeUndefined()
  expect(watchFor(undefined)).toBeUndefined()
})

test('parsePatterns reads both lists, and refuses an answer missing either heading', async () => {
  const text = '```\n### Going well\n- a good thing (session 1234abcd)\n* another\n\n### Not working:\n- Nothing seen.\n```'
  expect(parsePatterns(text)).toEqual({ goingWell: ['- a good thing (session 1234abcd)', '- another'], notWorking: ['- Nothing seen.'] })
  expect(parsePatterns('## Going well\n- x\n\n## Not working')).toEqual({ goingWell: ['- x'], notWorking: [] })
  expect(parsePatterns('### Going well\n- x')).toBeUndefined()
  expect(parsePatterns('nothing to say')).toBeUndefined()
})

test('patternsEntryText writes the dated entry, with the nothing-seen line for an empty list', async () => {
  expect(patternsEntryText('2026-10-06', { goingWell: ['- a'], notWorking: [] })).toBe(
    `## 2026-10-06\n\n### Going well\n- a\n\n### Not working\n${NOTHING_SEEN}`,
  )
})

test('upsertPatterns starts the file with its header, keeps entries in date order, and replaces a rerun date', async () => {
  const entry = (day: string, item: string) => patternsEntryText(day, { goingWell: [item], notWorking: [] })
  const first = upsertPatterns('', '2026-10-06', entry('2026-10-06', '- first'))
  expect(first).toBe(`${PATTERNS_HEADER}\n\n${entry('2026-10-06', '- first')}\n`)
  const later = upsertPatterns(first, '2026-10-07', entry('2026-10-07', '- later'))
  const earlier = upsertPatterns(later, '2026-10-05', entry('2026-10-05', '- earlier'))
  expect([...earlier.matchAll(/^## (\S+)$/gm)].map(m => m[1])).toEqual(['2026-10-05', '2026-10-06', '2026-10-07'])
  const rerun = upsertPatterns(earlier, '2026-10-06', entry('2026-10-06', '- redone'))
  expect(rerun).toContain('- redone')
  expect(rerun).not.toContain('- first')
  expect(rerun.split('## 2026-10-06').length).toBe(2)
  expect(upsertPatterns('# My notes\n\nkept', '2026-10-06', entry('2026-10-06', '- x')).startsWith('# My notes\n\nkept\n\n## 2026-10-06')).toBe(true)
})

test('patternsPrompt carries the date, the window, the not-summarized count and the summaries', async () => {
  expect(patternsPrompt({ today: '2026-10-06', since: 'S', until: 'U', failed: 2, summaries: ['## a — one'] })).toBe(
    'Today is 2026-10-06. Window: S → U. 2 sessions could not be summarized and are not below.\n\n# Session summaries for the window\n## a — one',
  )
})
