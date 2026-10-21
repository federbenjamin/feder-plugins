// The generated-copy check: green at the repo head, and red when any job's source, any target
// plugin, or any literal's file is gone.
//   node --test scripts/
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { literalChecks, syncProblems } from './sync-shared.ts'

const REPO = join(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'ss-sync-'))
after(() => rmSync(root, { recursive: true, force: true }))

let n = 0
// A copy of the repo's synced folders, without `gone`.
function copyWithout(...gone: string[]): string {
  const dir = join(root, `copy-${++n}`)
  for (const top of ['shared', 'plugins', 'tools']) {
    cpSync(join(REPO, top), join(dir, top), { recursive: true, filter: src => !src.includes('/.claude-plugin/types') })
  }
  for (const path of gone) rmSync(join(dir, path), { recursive: true, force: true })
  return dir
}

test('the repo head has no drift and nothing blocked', () => {
  assert.deepEqual(syncProblems(), { blocked: [], drift: [], writes: new Map(), removals: [] })
})

test('every job is mandatory: a missing source or target plugin is blocked', () => {
  const cases: [string, string][] = [
    ['shared', 'missing source shared (shared -> dialog-timeout)'],
    ['plugins/stop-judge/hooks/judge.ts', 'missing source plugins/stop-judge/hooks/judge.ts (judge -> eval)'],
    ['plugins/stop-judge/hooks/prompt.ts', 'missing source plugins/stop-judge/hooks/prompt.ts (judge -> eval)'],
    ['tools/eval', 'missing plugin tools/eval (judge -> eval)'],
    ['plugins/session-log', 'missing plugin plugins/session-log (shared -> session-log)'],
  ]
  for (const [gone, problem] of cases) assert.ok(syncProblems(copyWithout(gone)).blocked.includes(problem), `${gone}: ${syncProblems(copyWithout(gone)).blocked.join('; ')}`)
})

test('every literal check is mandatory: a missing file or a changed text is blocked', () => {
  assert.ok(syncProblems(copyWithout('plugins/session-log/scripts/directive.sh')).blocked.includes('missing plugins/session-log/scripts/directive.sh (literal check)'))
  const dir = copyWithout()
  writeFileSync(join(dir, 'plugins/session-log/scripts/directive.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "SESSION LOG — something else"\n')
  assert.ok(syncProblems(dir).blocked.some(p => p.startsWith('literal "SESSION LOG — keep ${LOG} in the format of ${TPL};')))
})

test('a generated fixture that differs from its source module drifts', () => {
  const dir = copyWithout()
  writeFileSync(join(dir, 'tools/eval/fixtures/grades.sample.jsonl'), '{"id":"F0001"}\n')
  assert.deepEqual(syncProblems(dir).drift, ['drifted tools/eval/fixtures/grades.sample.jsonl'])
})

test('the directive check names the shell hook, and the nudge has no literal check (judge.ts builds it from SIBLING_TEXTS)', () => {
  const files = literalChecks().map(c => c.file)
  assert.ok(files.includes('plugins/session-log/scripts/directive.sh'))
  assert.ok(!files.includes('plugins/stop-judge/hooks/judge.ts'))
})
