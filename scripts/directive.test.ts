// Runs plugins/session-log/scripts/directive.sh as the SessionStart hook does, against a fixture
// state dir: a plugin test cannot start a process, so this is where the script meets log.ts.
//   node --import ./scripts/resolve-ts.ts --test scripts/*.test.ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { directiveText, logPaths } from '../plugins/session-log/hooks/log.ts'

const SCRIPT = join(import.meta.dirname, '..', 'plugins', 'session-log', 'scripts', 'directive.sh')
const ID = 'abc-123'
const VIEW = '# Session log — abc-123\n\n## Todo\n\n- [ ] t1 open task\n'
const root = mkdtempSync(join(tmpdir(), 'ss-directive-'))
after(() => rmSync(root, { recursive: true, force: true }))

let n = 0
// A fresh state dir (with a space in its path) holding the session's `files`: 'view', 'store'.
function stateDir(files: readonly ('view' | 'store')[]): string {
  const dir = join(root, `state ${++n}`)
  const paths = logPaths(dir, ID)
  mkdirSync(dirname(paths.view), { recursive: true })
  if (files.includes('view')) writeFileSync(paths.view, VIEW)
  if (files.includes('store')) writeFileSync(paths.store, '')
  return dir
}

function directive(dir: string, source: string): string {
  const out = spawnSync('bash', [SCRIPT], { input: JSON.stringify({ session_id: ID, source }), env: { ...process.env, STOPSTOPPING_DIR: dir }, encoding: 'utf8' })
  assert.equal(out.status, 0)
  return out.stdout
}

test("a fresh start prints directiveText for the session's view, alone", () => {
  const dir = stateDir(['view', 'store'])
  assert.equal(directive(dir, 'startup'), `${directiveText(logPaths(dir, ID).view)}\n`)
})

test('a compaction and a resume print the view after the directive', () => {
  for (const source of ['compact', 'resume']) {
    const dir = stateDir(['view', 'store'])
    assert.equal(directive(dir, source), `${directiveText(logPaths(dir, ID).view)}\nSESSION LOG VIEW —\n${VIEW}`, source)
  }
})

test('a `.md` with no store beside it was kept by hand and is never printed; nor is a missing view', () => {
  for (const files of [['view'], ['store'], []] as const) {
    const dir = stateDir(files)
    assert.equal(directive(dir, 'compact'), `${directiveText(logPaths(dir, ID).view)}\n`, files.join('+'))
  }
})
