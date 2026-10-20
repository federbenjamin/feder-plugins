import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { isConversationReplaced } from '../hooks/register'
import { compactSessionLog, logPaths, templateText } from '../hooks/log'
import { logPath } from '../hooks/shared/firing'

const DIR = '/tmp/ss'
const ID = 'sess-1'
const paths = logPaths(DIR, ID)
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

const LOG = [
  '# Session log — sess-1',
  '',
  '## Work log',
  '',
  '- 09:00Z first fact',
  '- 09:05Z compacted',
  '- 09:10Z second fact',
  '',
  '## Todo',
  '',
  '- [x] done task',
  '- [ ] open task',
  '',
  '## Decisions',
  '',
  '- 2026-10-20 [agent] picked A over B',
].join('\n')

// The engine beneath: a file system held in `files`, a tee double that records log lines, a
// compaction that is `skip` when asked.
function world(on: On, files: Record<string, string>, skip?: string) {
  mock.clock(on, { now: Date.UTC(2026, 9, 20, 10, 30) })
  mock.env(on, { STOPSTOPPING_DIR: DIR })
  const writes: string[] = []
  const logged: string[] = []
  files[logPath(DIR, 'session-log')] = '' // the firing log exists, so its creation is no write of ours
  on('session.id', async () => ({ value: ID }))
  on('fs.exists', async (_$, e) => ({ value: e.path in files }))
  on('fs.read', async (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', async (_$, e) => {
    writes.push(e.path)
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'tee') logged.push(e.init?.stdin ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.compact', async (_$, e) => (skip === undefined ? { messages: e.messages } : { skip }))
  return { writes, logged }
}

test('session.start writes the template and logs it', async ($, on) => {
  const files: Record<string, string> = {}
  const { logged } = world(on, files)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: false })
  expect(files[paths.template]).toBe(templateText())
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatch(/^\S+ template session=sess-1 ms=0 reason=\n$/)
})

test('a main compaction writes the archive before the log, then logs the prune', async ($, on) => {
  const files: Record<string, string> = { [paths.log]: LOG }
  const { writes, logged } = world(on, files)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  expect(writes).toEqual([paths.archive, paths.log])
  const expected = compactSessionLog(LOG, null, { sessionId: ID, now: new Date(Date.UTC(2026, 9, 20, 10, 30)) })
  expect(expected.ok && files[paths.log]).toBe(expected.ok && expected.log)
  expect(files[paths.archive]).toContain('- 09:00Z first fact')
  expect(files[paths.archive]).toContain('- [x] done task')
  expect(files[paths.log]).toContain('- [ ] open task')
  expect(files[paths.log]).toContain('- 10:30Z compacted')
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatch(new RegExp(`prune session=sess-1 ms=0 reason=moved=2 archive=${paths.archive}\\n$`))
})

test('a subagent compaction, a skipped one and a precompute prune nothing', async ($, on) => {
  const files: Record<string, string> = { [paths.log]: LOG }
  const { writes } = world(on, files)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY, agentId: 'a1' })
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  expect(writes).toEqual([])
  expect(files[paths.log]).toBe(LOG)
})

test('a skipped compaction prunes nothing', async ($, on) => {
  const files: Record<string, string> = { [paths.log]: LOG }
  const { writes } = world(on, files, 'vetoed')
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(writes).toEqual([])
})

test('a compaction with no log file does nothing', async ($, on) => {
  const files: Record<string, string> = {}
  const { writes, logged } = world(on, files)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  expect(writes).toEqual([])
  expect(logged).toEqual([])
})

test('a log without the three sections is left as it was and logged', async ($, on) => {
  const files: Record<string, string> = { [paths.log]: '# notes\n\n## Work log\n' }
  const { writes, logged } = world(on, files)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  expect(writes).toEqual([])
  expect(logged[0]).toMatch(/prune-skipped session=sess-1 ms=0 reason=missing Todo, Decisions\n$/)
})

test('only a main, unskipped, non-precompute compaction replaces the conversation', async () => {
  expect(isConversationReplaced({ trigger: 'auto' }, {})).toBe(true)
  expect(isConversationReplaced({ trigger: 'auto', agentId: 'a' }, {})).toBe(false)
  expect(isConversationReplaced({ trigger: 'precompute' }, {})).toBe(false)
  expect(isConversationReplaced({ trigger: 'manual' }, { skip: 'x' })).toBe(false)
})
