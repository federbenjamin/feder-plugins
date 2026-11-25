import { expect, test } from 'claude-code/testing'
import { directiveText, logPaths } from '../hooks/log'
import { TOOLS } from '../hooks/tools'

test("a session's log files sit side by side in session-logs", async () => {
  expect(logPaths('/d', 's1')).toEqual({ view: '/d/session-logs/s1.md', store: '/d/session-logs/s1.jsonl', incoming: '/d/session-logs/s1.jsonl.tmp', legacy: '/d/session-logs/s1.legacy.md' })
})

test('the directive names the view path, every writing tool and log_read', async () => {
  const text = directiveText('/d/session-logs/s1.md')
  expect(text).toContain('/d/session-logs/s1.md')
  for (const t of TOOLS) expect(text).toContain(t.name)
})
