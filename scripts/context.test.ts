// Runs stop-judge's SessionStart hook command from hooks/hooks.json against a fixture state dir:
// a plugin test cannot start a process, so this is where the hook's sed meets decisions.ts.
//   node --test scripts/*.test.ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { BULLET_RE, DEFAULT_LINE, rulesOnly, validateDecisions } from '../plugins/stop-judge/hooks/decisions.ts'

const HOOKS = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'plugins', 'stop-judge', 'hooks', 'hooks.json'), 'utf8'))
const COMMAND: string = HOOKS.hooks.SessionStart[0].hooks[0].command
const root = mkdtempSync(join(tmpdir(), 'ss-context-'))
after(() => rmSync(root, { recursive: true, force: true }))

const FILE = [
  '# Decisions (derived 2026-10-23, 2 sessions, 2026-10-20 to 2026-10-23)',
  '',
  DEFAULT_LINE,
  '',
  '## Bring to me',
  "- Ask before deleting anything not named. -- \"remove the 21 merged, leave the rest\" (2026-10-21)",
  '## How to decide',
  '### Verification',
  "- Verify a fix before claiming it. -- \"VERIFY fixes before claiming them fixed.\" \"don't say 'done' early\" (2026-10-22)",
  '',
].join('\n')

let n = 0
function hook(file: string | null, contextOff = false): string {
  const dir = join(root, `state ${++n}`)
  mkdirSync(dir, { recursive: true })
  if (file !== null) writeFileSync(join(dir, 'DECISIONS.md'), file)
  if (contextOff) writeFileSync(join(dir, 'context-off'), '')
  const out = spawnSync('bash', ['-c', COMMAND], { env: { ...process.env, STOPSTOPPING_DIR: dir }, encoding: 'utf8' })
  assert.equal(out.status, 0)
  return out.stdout
}

test('the hook prints the rules of a valid file without a quote or date, exactly as rulesOnly does', () => {
  assert.equal(validateDecisions(FILE).ok, true)
  assert.equal(FILE.split('\n').filter(l => BULLET_RE.test(l)).length, 2)
  const printed = hook(FILE)
  assert.equal(printed, rulesOnly(FILE))
  assert.doesNotMatch(printed, /VERIFY fixes|remove the 21|2026-10-2[12]\)/)
  assert.match(printed, /^- Verify a fix before claiming it\.$/m)
})

test('the hook prints nothing with no file or with context off', () => {
  assert.equal(hook(null), '')
  assert.equal(hook(FILE, true), '')
})
