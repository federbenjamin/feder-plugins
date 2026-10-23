// The shapes every plugin shares live once, in shared/: no plugin's own hooks file appends to the
// firing log, resolves the state dir, or defines the event predicates again.
//   node --test scripts/*.test.ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = join(import.meta.dirname, '..')
const PLUGINS = ['dialog-timeout', 'cache-keepalive', 'stop-judge', 'session-log', 'session-summary']

// Each plugin's own hooks files: hooks/*.ts and *.tsx, not the generated hooks/shared/ copies.
function ownHooksFiles(): { path: string; text: string }[] {
  const dirs = [...PLUGINS.map(p => join('plugins', p, 'hooks')), join('tools', 'eval', 'hooks')]
  return dirs.flatMap(dir =>
    readdirSync(join(REPO, dir), { withFileTypes: true })
      .filter(e => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx')))
      .map(e => ({ path: join(dir, e.name), text: readFileSync(join(REPO, dir, e.name), 'utf8') })),
  )
}

const SHARED_ONLY: { what: string; re: RegExp }[] = [
  { what: 'a firing-log append', re: /'tee',\s*'-a'/ },
  { what: 'the state-dir override', re: /STOPSTOPPING_DIR/ },
  { what: 'the default state dir', re: /\.claude\/stopstopping/ },
  { what: 'isConversationReplaced', re: /function\s+isConversationReplaced/ },
  { what: 'the person origins', re: /PERSON_ORIGINS\s*[:=]/ },
  { what: 'a usage-to-dollars function', re: /function\s+usageUsd|USD_PER_MTOK/ },
  { what: 'a clip helper', re: /function\s+clip\b/ },
  { what: 'actionSummary', re: /function\s+actionSummary/ },
  { what: 'the session-log path', re: /function\s+sessionLogPath/ },
]

test('the firing-log append, the state dir and the event predicates are defined only in shared/', () => {
  const files = ownHooksFiles()
  assert.ok(files.some(f => f.path.endsWith(join('stop-judge', 'hooks', 'register.ts'))))
  const hits = files.flatMap(f => SHARED_ONLY.filter(s => s.re.test(f.text)).map(s => `${f.path}: ${s.what}`))
  assert.deepEqual(hits, [])
})

test('the derive loop is its own hooks file, entered only through startDerive', () => {
  const read = (name: string) => readFileSync(join(REPO, 'plugins', 'stop-judge', 'hooks', name), 'utf8')
  const run = read('derive-run.ts')
  const exported = [...run.matchAll(/^export (?:async )?(?:function|const|type) (\w+)/gm)].map(m => m[1])
  assert.deepEqual(exported, ['DeriveState', 'startDerive'])
  const register = read('register.ts')
  assert.match(register, /from '\.\/derive-run\.ts'/)
  for (const loop of ['scanSessions', 'deriveRun', 'deriveInBackground', 'completeWithRetry', 'startDerive']) {
    assert.doesNotMatch(register, new RegExp(`function ${loop}\\b`), loop)
  }
})

test('every plugin with a firing log appends through the shared record', () => {
  for (const p of PLUGINS) {
    const text = readFileSync(join(REPO, 'plugins', p, 'hooks', 'register.ts'), 'utf8')
    assert.match(text, /from '\.\/shared\/record\.ts'/, p)
  }
})
