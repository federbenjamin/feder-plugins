import { expect, test } from 'claude-code/testing'
import { directiveText, logPaths } from '../hooks/log'

// scripts/directive.sh prints this same sentence. A plugin test cannot run a process or read a
// file, so the pins below are the parts the script must keep in step with.
const p = logPaths('/tmp/ss', 'abc-123')

test('the directive is one line that names the log and the template', () => {
  const text = directiveText(p.log, p.template)
  expect(text.includes('\n')).toBe(false)
  expect(text.startsWith(`SESSION LOG — keep ${p.log} in the format of ${p.template}; `)).toBe(true)
  expect(text.endsWith('Main session only.')).toBe(true)
})

test('the directive says to append, never rewrite, and to read the log first', () => {
  const text = directiveText(p.log, p.template)
  for (const part of ['Missing: create it from the template at the first real request', 'Present: read it before other work', 'Append as things happen, never rewrite a line']) {
    expect(text).toContain(part)
  }
})

test('the log, archive and template sit together under session-logs', () => {
  expect(p).toEqual({
    log: '/tmp/ss/session-logs/abc-123.md',
    archive: '/tmp/ss/session-logs/abc-123.archive.md',
    template: '/tmp/ss/session-logs/TEMPLATE.md',
  })
})
