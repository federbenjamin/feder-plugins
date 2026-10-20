import { expect, test } from 'claude-code/testing'
import { compactSessionLog, directiveText, logPaths, replacesQuotes, templateText } from '../hooks/log.ts'

const at = new Date('2026-10-20T11:45:00.000Z')

test('a later compaction archives untagged settled work, every finished todo, and a superseded decision', () => {
  const log = [
    '# Session log — session-a',
    '',
    '## Work log',
    '',
    '- 09:00Z first untagged fact',
    '- 09:15Z [older-branch] tagged fact',
    '- 10:00Z [session] compacted',
    '- 10:30Z current fact',
    '',
    '## Todo',
    '',
    '- [x] finished without a tag',
    '- [x] [older-branch] finished with a tag',
    '- [ ] unresolved task',
    '',
    '## Decisions',
    '',
    '- 2026-10-20 [agent] use the first choice over the second',
    '- 2026-10-20 [agent] use the replacement over the first choice replaces: "use the first choice"',
    '',
  ].join('\n')

  const result = compactSessionLog(log, null, { sessionId: 'session-a', now: at })

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.moved).toBe(5)
  expect(result.warnings).toEqual([])
  expect(result.log).toContain('- 10:30Z current fact')
  expect(result.log).toContain('- [ ] unresolved task')
  expect(result.log).toContain('- 11:45Z [session] compacted')
  expect(result.log).not.toContain('- 09:00Z first untagged fact')
  expect(result.log).not.toContain('- 09:15Z [older-branch] tagged fact')
  expect(result.log).not.toContain('- [x] finished without a tag')
  expect(result.log).not.toContain('- [x] [older-branch] finished with a tag')
  expect(result.log).not.toContain('- 2026-10-20 [agent] use the first choice over the second')
  expect(result.archive).toContain('- 09:00Z first untagged fact')
  expect(result.archive).toContain('- 09:15Z [older-branch] tagged fact')
  expect(result.archive).toContain('- [x] finished without a tag')
  expect(result.archive).toContain('- [x] [older-branch] finished with a tag')
  expect(result.archive).toContain('- 2026-10-20 [agent] use the first choice over the second')
})

test('the first compaction keeps work until a previous marker exists but still archives every completed todo', () => {
  const log = [
    '# Session log — session-b',
    '',
    '## Work log',
    '',
    '- 10:00Z work awaiting its next compaction',
    '',
    '## Todo',
    '',
    '- [x] completed task',
    '- [ ] open task',
    '',
    '## Decisions',
    '',
  ].join('\n')

  const result = compactSessionLog(log, null, { sessionId: 'session-b', now: at })

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.moved).toBe(1)
  expect(result.log).toContain('- 10:00Z work awaiting its next compaction')
  expect(result.log).toContain('- [ ] open task')
  expect(result.log).toContain('- 11:45Z [session] compacted')
  expect(result.log).not.toContain('- [x] completed task')
  expect(result.archive).toContain('- [x] completed task')
})

test('a malformed log reports every required section that is absent', () => {
  const result = compactSessionLog('## Work log\n\n## Decisions\n', null, { sessionId: 'broken', now: at })

  expect(result).toEqual({ ok: false, missing: ['Todo'] })
})

test('replaces clauses accept quoted, typographic-quoted, and unquoted prior text', () => {
  expect(replacesQuotes('new rule replaces: "first choice" replaces: “second choice”')).toEqual(['first choice', 'second choice'])
  expect(replacesQuotes('new rule replaces: the old decision')).toEqual(['the old decision'])
  expect(replacesQuotes('a decision with no replacement')).toEqual([])
})

test('the template teaches the three-section untagged format without retired citations', () => {
  const template = templateText()

  expect(template).toContain('## Work log')
  expect(template).toContain('## Todo')
  expect(template).toContain('## Decisions')
  expect(template).toContain('- HH:MMZ <fact> (<sha>)')
  expect(template).toContain('- [ ] <task>')
  expect(template).toContain('- [x] <task>')
  expect(template).toContain('replaces: "<quote>"')
  expect(template).not.toContain('[<branch>]')
  expect(template).not.toContain('principle')
  expect(template).not.toContain('contract rule')
})

test('the SessionStart directive is one line and paths stay within the session-log directory', () => {
  const paths = logPaths('/state', 'session-c')
  const directive = directiveText(paths.log, paths.template)

  expect(paths).toEqual({
    log: '/state/session-logs/session-c.md',
    archive: '/state/session-logs/session-c.archive.md',
    template: '/state/session-logs/TEMPLATE.md',
  })
  expect(directive.startsWith('SESSION LOG — keep /state/session-logs/session-c.md in the format of /state/session-logs/TEMPLATE.md;')).toBe(true)
  expect(directive.split('\n')).toHaveLength(1)
})
