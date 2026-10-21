// Runs plugins/session-log/scripts/directive.sh as the SessionStart hook does, against a fixture
// state dir: a plugin test cannot start a process, so this is where the script meets log.ts.
//   node --test scripts/
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { directiveText, logPaths, pruneReason } from '../plugins/session-log/hooks/log.ts'
import { firingLine, logPath } from '../shared/firing.ts'

const SCRIPT = join(import.meta.dirname, '..', 'plugins', 'session-log', 'scripts', 'directive.sh')
const ID = 'abc-123'
const OTHER = 'zzz-999'
const root = mkdtempSync(join(tmpdir(), 'ss-directive-'))
after(() => rmSync(root, { recursive: true, force: true }))

let n = 0
// A fresh state dir (with a space in its path) holding `lines` as the session-log firing log.
function stateDir(lines: string[]): string {
  const dir = join(root, `state ${++n}`)
  mkdirSync(join(dir, 'logs'), { recursive: true })
  writeFileSync(logPath(dir, 'session-log'), lines.join(''))
  return dir
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 10, minute))
const prune = (session: string, moved: number, archive: string, minute: number) => firingLine('prune', session, 0, pruneReason(moved, archive), at(minute))
const line = (outcome: string, session: string, reason: string, minute: number) => firingLine(outcome, session, 0, reason, at(minute))

function directive(dir: string, source: string, session = ID): string[] {
  const out = spawnSync('bash', [SCRIPT], { input: JSON.stringify({ session_id: session, source }), env: { ...process.env, STOPSTOPPING_DIR: dir }, encoding: 'utf8' })
  assert.equal(out.status, 0)
  return out.stdout.split('\n').filter(l => l !== '')
}

test("the script's first line is directiveText for the session's log and template", () => {
  const dir = stateDir([])
  const p = logPaths(dir, ID)
  assert.deepEqual(directive(dir, 'startup'), [directiveText(p.log, p.template)])
})

test('after a compaction whose prune moved lines, the second line names that prune', () => {
  const dir = stateDir([prune(ID, 3, '/a/arch ive.md', 1), line('prune-warning', ID, 'a warning', 1)])
  assert.equal(directive(dir, 'compact')[1], 'SESSION LOG PRUNE — moved 3 lines → /a/arch ive.md')
})

test("an earlier compaction's prune never prints for a later one that skipped, failed, or found no log", () => {
  for (const [outcome, reason] of [
    ['prune-skipped', 'missing Todo'],
    ['prune-skipped', 'no log'],
    ['prune-failed', 'disk full'],
  ]) {
    const dir = stateDir([prune(ID, 3, '/a/arch.md', 1), line(outcome!, ID, reason!, 2)])
    assert.equal(directive(dir, 'compact').length, 1, `${outcome} ${reason}`)
  }
})

test('the newest prune of this session wins over an older one and over another session’s', () => {
  const dir = stateDir([prune(ID, 3, '/a/old.md', 1), line('prune-skipped', ID, 'no log', 2), prune(ID, 5, '/a/new.md', 3), prune(OTHER, 9, '/b/x.md', 4)])
  assert.equal(directive(dir, 'compact')[1], 'SESSION LOG PRUNE — moved 5 lines → /a/new.md')
  assert.equal(directive(dir, 'compact', OTHER)[1], 'SESSION LOG PRUNE — moved 9 lines → /b/x.md')
  assert.equal(directive(dir, 'compact', 'nobody').length, 1)
})

test('a start that is not a compaction prints the directive alone', () => {
  const dir = stateDir([prune(ID, 3, '/a/arch.md', 1)])
  assert.equal(directive(dir, 'resume').length, 1)
  assert.equal(directive(stateDir([]), 'compact').length, 1)
})
