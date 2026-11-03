import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import { LINK_TTL_MS, LINKS_HTTPS_PORT, PLUGIN } from '../hooks/config'
import { linksJobNames, linksPaths, LOCAL_TARGET, REFUSED, renderLinksPlist } from '../hooks/links'

const T0 = Date.parse('2026-11-03T12:00:00Z')
const HOME = '/h'
const DIR = '/h/state'
const ID = 'synthetic-session'
const BASE = `https://host.example:${LINKS_HTTPS_PORT}`
const TS = '/usr/local/bin/tailscale'
const NAMES = linksJobNames(HOME, '501')
const PATHS = linksPaths(DIR)
const LOG = `${DIR}/logs/${PLUGIN}.log`
const STATUS = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.example.' }, CertDomains: ['host.example'] })
const OURS = JSON.stringify({ TCP: { [LINKS_HTTPS_PORT]: { HTTPS: true } }, Web: { [`host.example:${LINKS_HTTPS_PORT}`]: { Handlers: { '/': { Proxy: LOCAL_TARGET } } } } })
const THEIRS = OURS.replace(LOCAL_TARGET, 'http://127.0.0.1:1')

type Proc = { exitCode?: number; stdout?: string; stderr?: string }
const MAC: Record<string, Proc> = {
  'uname -s': { stdout: 'Darwin\n' },
  'which tailscale': { stdout: `${TS}\n` },
  'which python3': { stdout: '/usr/bin/python3\n' },
  'id -u': { stdout: '501\n' },
  [`${TS} status`]: { stdout: STATUS },
  [`${TS} serve`]: { stdout: '{}' },
  'curl -s': { stdout: '404' },
}

const PANE = { title: 'Session summary', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

// Commands answer as MAC does, keyed by their first two words, except what `over` names.
function world(on: On, over: Record<string, Proc> = {}, settings: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME, STOPSTOPPING_DIR: DIR })
  mock.store(on, { settings })
  const w = {
    clock,
    argv: [] as string[][],
    files: new Map<string, string>(),
    messages: [] as SessionMessage[],
    readError: '',
  }
  on('fs.exists', async (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', async (_$, e) => (w.readError !== '' ? { deny: w.readError } : { value: w.files.get(e.path) ?? '' }))
  on('fs.write', async (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    const done = (p: Proc = {}) => ({ value: { exitCode: p.exitCode ?? 0, stdout: p.stdout ?? '', stderr: p.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'tee') {
      w.files.set(argv[2]!, (w.files.get(argv[2]!) ?? '') + (e.init?.stdin ?? ''))
      return done()
    }
    w.argv.push(argv)
    const key = argv.slice(0, 2).join(' ')
    if (key === '/bin/sh -c') {
      if (over[key] === undefined) w.files.set(argv[6]!, e.init?.stdin ?? '')
      return done(over[key])
    }
    if (key === 'rm -f' || key === 'rm -rf') for (const p of argv.slice(2)) w.files.delete(p)
    return done(over[argv.slice(0, 3).join(' ')] ?? over[key] ?? MAC[key])
  })
  on('session.id', async () => ({ value: ID }))
  on('session.cwd', async () => ({ value: '/tmp/project' }))
  on('session.messages', async () => ({ value: [...w.messages] }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return w
}

type World = ReturnType<typeof world>

const start = ($: Engine) => $.session.start({ cwd: '/tmp/project', surface: 'terminal', isInteractive: true })
const command = async ($: Engine, args: string) => (await $.command.run({ command: PLUGIN, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text
const links = ($: Engine, state: string) => command($, `links ${state}`)
const linksLine = async ($: Engine) => (await command($, 'show'))?.split('\n').find(l => l.startsWith('links:'))
const firings = (w: World) => (w.files.get(LOG) ?? '').split('\n').filter(Boolean)
const outcomes = (w: World) => firings(w).map(l => l.split(' ')[1])
const changedNothing = (w: World) => {
  expect(w.argv.filter(a => a[0] === 'launchctl' || a.includes('--bg') || a.includes('off'))).toEqual([])
  expect(w.files.has(NAMES.plist)).toBe(false)
}
const wrote = (path: string): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `w-${path}-${Math.random()}`, tool: 'Write', input: { file_path: path } }] })
const step = async ($: Engine) => {
  await $.turn.start({ text: 'go', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
}
const shares = (w: World) => JSON.parse(w.files.get(PATHS.shares) ?? '[]') as { token: string; path: string; expiresAt: number }[]

test('links on installs the job, waits for the server, then adds its one serve entry and stores the base', async ($, on) => {
  const w = world(on)
  await start($)
  const text = await links($, 'on')
  expect(text).toContain(`links on: ${BASE}.`)
  expect(w.files.get(NAMES.plist)).toBe(renderLinksPlist({ python: '/usr/bin/python3', dir: DIR, home: HOME, uid: '501' }))
  expect(w.files.has(PATHS.script)).toBe(true)
  const order = w.argv.map(a => a.slice(0, 2).join(' '))
  expect(order.indexOf('launchctl bootstrap')).toBeLessThan(order.indexOf('curl -s'))
  expect(w.argv.filter(a => a[0] === TS && a.includes('--bg'))).toEqual([[TS, 'serve', '--bg', `--https=${LINKS_HTTPS_PORT}`, LOCAL_TARGET]])
  expect(order.indexOf('curl -s')).toBeLessThan(w.argv.findIndex(a => a.includes('--bg')))
  expect(w.argv.some(a => a.includes('reset'))).toBe(false)
  expect(outcomes(w)).toEqual(['links-on'])
  expect(firings(w)[0]).toContain(`reason=https=${LINKS_HTTPS_PORT} local=`)
  expect(await linksLine($)).toBe(`links: on ${BASE}`)
})

for (const [why, over, text] of [
  ['the machine is not a Mac', { 'uname -s': { stdout: 'Linux\n' } }, REFUSED.notMacOS],
  ['Tailscale is not installed', { 'which tailscale': { exitCode: 1 } }, REFUSED.noTailscale],
  ['tailscale status fails', { [`${TS} status`]: { exitCode: 1 } }, REFUSED.statusFailed],
  ['the tailnet has no HTTPS', { [`${TS} status`]: { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.example.' }, CertDomains: null }) } }, REFUSED.noHttps],
  ['the https port holds another target', { [`${TS} serve`]: { stdout: THEIRS } }, REFUSED.portTaken],
  ['python3 is missing', { 'which python3': { exitCode: 1 } }, REFUSED.noPython],
] as const) {
  test(`links on refuses when ${why}, and changes nothing`, async ($, on) => {
    const w = world(on, over)
    await start($)
    expect(await links($, 'on')).toBe(text)
    changedNothing(w)
    expect(outcomes(w)).toEqual([])
    expect(await linksLine($)).toBe('links: off')
  })
}

test('a failed serve takes the job back out and stores nothing', async ($, on) => {
  const w = world(on, { [`${TS} serve --bg`]: { exitCode: 1, stderr: ' no serve \n' } })
  await start($)
  expect(await links($, 'on')).toBe('cannot turn links on: tailscale serve failed: no serve')
  expect(w.argv.some(a => a[0] === 'launchctl' && a[1] === 'bootout')).toBe(true)
  expect(w.argv.some(a => a[0] === 'rm' && a.includes(NAMES.plist))).toBe(true)
  expect(await linksLine($)).toBe('links: off')
})

test('a command that cannot start or finish is a refusal, not a failed hook', async ($, on) => {
  const w = world(on)
  w.readError = 'unreadable'
  await start($)
  expect(await links($, 'on')).toMatch(/^cannot turn links on: .*unreadable$/)
  expect(w.argv.some(a => a[0] === 'launchctl')).toBe(false)
  expect(await linksLine($)).toBe('links: off')
})

test('a serve status that cannot be read is treated as a held port: nothing changes', async ($, on) => {
  const w = world(on, { [`${TS} serve status`]: { exitCode: 1 } })
  await start($)
  expect(await links($, 'on')).toBe(REFUSED.portTaken)
  changedNothing(w)
})

test('a server that never answers takes the job back out and stores nothing', async ($, on) => {
  const w = world(on, { 'curl -s': { stdout: '000' } })
  await start($)
  const pending = links($, 'on')
  await w.clock.advance(60_000)
  expect(await pending).toContain('the file server did not answer')
  expect(w.argv.some(a => a.includes('--bg'))).toBe(false)
  expect(w.argv.some(a => a[0] === 'launchctl' && a[1] === 'bootout')).toBe(true)
  expect(w.argv.some(a => a[0] === 'rm' && a.includes(NAMES.plist))).toBe(true)
  expect(await linksLine($)).toBe('links: off')
})

test('links off removes the shares, its own serve entry and the job, and stores off', async ($, on) => {
  const w = world(on, { [`${TS} serve`]: { stdout: OURS } }, { linksBase: BASE, isOff: true })
  w.files.set(PATHS.shares, '[]')
  w.files.set(NAMES.plist, 'plist')
  await start($)
  expect(await links($, 'off')).toContain('links off: every link is dead')
  expect(w.files.has(PATHS.shares)).toBe(false)
  expect(w.argv).toContainEqual([TS, 'serve', `--https=${LINKS_HTTPS_PORT}`, 'off'])
  expect(w.argv).toContainEqual(['launchctl', 'bootout', NAMES.target])
  expect(w.files.has(NAMES.plist)).toBe(false)
  expect(w.argv.some(a => a.includes('reset'))).toBe(false)
  expect(outcomes(w)).toEqual(['links-off'])
  expect(await linksLine($)).toBe('links: off')
})

test('links off leaves a serve entry that is not its own, and says so', async ($, on) => {
  const w = world(on, { [`${TS} serve`]: { stdout: THEIRS } }, { linksBase: BASE, isOff: true })
  await start($)
  expect(await links($, 'off')).toContain('left tailscale serve')
  expect(w.argv.some(a => a.includes('off'))).toBe(false)
})

test('links off with nothing installed runs no launchctl and no serve removal', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await links($, 'off')).toContain('links off')
  changedNothing(w)
})

test('links off says what stayed when a step fails, and still ends the links', async ($, on) => {
  const w = world(on, { [`${TS} serve`]: { stdout: OURS }, 'launchctl bootout': { exitCode: 5, stderr: 'Boot-out failed' }, 'launchctl print': { exitCode: 0 } }, { linksBase: BASE, isOff: true })
  w.files.set(PATHS.shares, '[]')
  w.files.set(NAMES.plist, 'plist')
  await start($)
  expect(await links($, 'off')).toContain('launchctl bootout failed: Boot-out failed; the job stays')
  expect(w.files.has(PATHS.shares)).toBe(false)
  expect(w.files.has(NAMES.plist)).toBe(true)
  expect(firings(w)[0]).toContain('links-off')
  expect(firings(w)[0]).toContain('reason=partial')
})

test('with links on a tick shares a new file, logs only its token prefix, and the pane links it over https', async ($, on) => {
  const w = world(on, {}, { linksBase: BASE, isOff: true })
  w.messages = [wrote('/tmp/project/notes/plan.md')]
  await start($)
  await step($)
  await w.clock.advance(30_000)
  const [share] = shares(w)
  expect(share!.path).toBe('/tmp/project/notes/plan.md')
  expect(share!.token).toMatch(/^[0-9a-f]{32}$/)
  expect(share!.expiresAt).toBe(T0 + 30_000 + LINK_TTL_MS)
  expect(outcomes(w)).toEqual(['share'])
  expect(firings(w)[0]).toContain(`reason=token=${share!.token.slice(0, 8)} expires=`)
  expect(w.files.get(LOG)).not.toContain('plan.md')
  expect(w.files.get(LOG)).not.toContain(share!.token)
  const write = w.argv.find(a => a[0] === '/bin/sh')!
  expect(write[2]).toContain('umask 077')
  expect(write[2]).toContain('mv "$2" "$3"')
  expect(write[6]).toBe(PATHS.shares)

  w.files.set(share!.path, '')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['No summary yet.', 'FILES', `${BASE}/${share!.token}/plan.mdnotes/plan.md`])
  await ui.unmount()
})

test('a later touch renews the expiry and keeps the token; a quiet tick writes nothing', async ($, on) => {
  const w = world(on, {}, { linksBase: BASE, isOff: true })
  w.messages = [wrote('/tmp/project/plan.md')]
  await start($)
  await step($)
  await w.clock.advance(30_000)
  const first = shares(w)[0]!
  const writes = () => w.argv.filter(a => a[0] === '/bin/sh').length
  expect(writes()).toBe(1)
  await w.clock.advance(60_000)
  expect(writes()).toBe(1)
  w.messages.push(wrote('/tmp/project/plan.md'))
  await step($)
  await w.clock.advance(30_000)
  const renewed = shares(w)[0]!
  expect(renewed.token).toBe(first.token)
  expect(renewed.expiresAt).toBe(T0 + 120_000 + LINK_TTL_MS)
  expect(writes()).toBe(2)
})

test('a secret-looking file is listed with no link and never reaches the shares file', async ($, on) => {
  const w = world(on, {}, { linksBase: BASE, isOff: true })
  w.messages = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 's', tool: 'SendUserFile', input: { files: ['/tmp/project/.env'] } }] }]
  w.files.set('/tmp/project/.env', '')
  await start($)
  await step($)
  await w.clock.advance(30_000)
  expect(shares(w)).toEqual([])
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['No summary yet.', 'FILES', '.env'])
  await ui.unmount()
})

test('a file that is gone shows with no link', async ($, on) => {
  const w = world(on, {}, { linksBase: BASE, isOff: true })
  w.messages = [wrote('/tmp/project/plan.md')]
  await start($)
  await step($)
  await w.clock.advance(30_000)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['No summary yet.', 'FILES', 'plan.md'])
  await ui.unmount()
})

test('with links off nothing touches the shares file', async ($, on) => {
  const w = world(on, {}, { isOff: true })
  w.messages = [wrote('/tmp/project/plan.md')]
  await start($)
  await step($)
  await w.clock.advance(30_000)
  expect(w.argv.filter(a => a[0] === '/bin/sh')).toEqual([])
  expect(w.files.has(PATHS.shares)).toBe(false)
  expect(firings(w)).toEqual([])
})

test('a share write that fails logs without a path, and the next tick tries again', async ($, on) => {
  const w = world(on, { '/bin/sh -c': { exitCode: 1 } }, { linksBase: BASE, isOff: true })
  w.messages = [wrote('/tmp/project/plan.md')]
  w.files.set('/tmp/project/plan.md', '')
  await start($)
  await step($)
  await w.clock.advance(30_000)
  expect(outcomes(w)).toEqual(['documents-failed'])
  expect(w.files.get(LOG)).not.toContain('plan.md')
  await w.clock.advance(30_000)
  expect(outcomes(w)).toEqual(['documents-failed', 'documents-failed'])
  const row = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
  expect((await row.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['No summary yet.', 'FILES', 'plan.md'])
  await row.unmount()
})

test('a wheel tick over the section scrolls older files; one over the rest leaves them, and the keys pass on', async ($, on) => {
  const w = world(on, {}, { isOff: true })
  on('ui.scroll', async () => ({}))
  w.messages = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map(p => wrote(`/tmp/project/${p}`))
  await start($)
  await step($)
  await w.clock.advance(30_000)
  const rows = async () => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PANE })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => !t.startsWith('file:') && t !== 'No summary yet.')
    await ui.unmount()
    return texts
  }
  const wheel = (by: number, row?: number) =>
    $.ui.scroll({ component: 'Pane', requestId: PLUGIN, offset: 0, by, bodyRows: 40, contentRows: 40, origin: { kind: 'person' }, ...(row === undefined ? {} : { pointer: { column: 2, row } }) } as never)
  expect(await rows()).toEqual(['FILES 1–3 of 5'])
  await wheel(1, 38)
  expect(await rows()).toEqual(['FILES 2–4 of 5'])
  await wheel(1, 2)
  await wheel(1)
  expect(await rows()).toEqual(['FILES 2–4 of 5'])
  await wheel(9, 39)
  expect(await rows()).toEqual(['FILES 3–5 of 5'])
  await wheel(-9, 36)
  expect(await rows()).toEqual(['FILES 1–3 of 5'])
})
