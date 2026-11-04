import { expect, test } from 'claude-code/testing'
import type { Doc } from '../types'
import { LINK_TTL_MS, LINKS_HTTPS_PORT, LINKS_LOCAL_PORT } from '../hooks/config.ts'
import { adoptShares, isSecretPath, linksJobNames, linksPaths, LOCAL_TARGET, mergeShares, newToken, parseShares, REFUSED, renderLinksPlist, servePortHolder, shareUrl, sharesText, tailnetBase, wantedShares } from '../hooks/links.ts'

const NOW = 1_000
const counter = () => {
  let n = 0
  return () => `token-${++n}`
}

test('the secret filter takes every pattern, in any segment and any case, and leaves ordinary paths alone', () => {
  for (const path of ['/r/.env', '/r/.env.local', '/r/server.pem', '/r/a.KEY', '/h/.ssh/id_rsa', '/h/.ssh/id_rsa.pub', '/h/.ssh/id_ed25519', '/h/.aws/credentials', '/r/my-credentials.md', '/r/secret.md', '/r/Secrets/plan.md', '/r/.env.d/plan.md']) {
    expect(isSecretPath(path)).toBe(true)
  }
  for (const path of ['/r/plan.md', '/r/environment.md', '/r/keys.md', '/r/a.key.md', '/r/monkey.txt', '/r/id_card.png']) expect(isSecretPath(path)).toBe(false)
})

test('a token holds 128 random bits as hex', () => {
  expect(newToken()).toMatch(/^[0-9a-f]{32}$/)
  expect(newToken()).not.toBe(newToken())
})

test('the shares file reads back what it wrote, and anything malformed as nothing', () => {
  const shares = [{ token: 't', path: '/a.md', expiresAt: 5 }]
  expect(parseShares(sharesText(shares))).toEqual(shares)
  for (const text of ['', 'not json', '{}', 'null']) expect(parseShares(text)).toEqual([])
  expect(parseShares('[{"token":"t","path":"/a.md"},7,{"token":"u","path":"/b.md","expiresAt":6}]')).toEqual([{ token: 'u', path: '/b.md', expiresAt: 6 }])
})

test('expiry is 7 days from the latest touch; a secret-looking or relative file is not wanted', () => {
  const doc = (path: string, touchedAt = 100): Doc => ({ path, touchedAt, touches: 1 })
  expect(wantedShares([doc('/r/a.md'), doc('/r/.env'), doc('notes/b.md')])).toEqual([{ path: '/r/a.md', expiresAt: 100 + LINK_TTL_MS }])
})

test('a new path gets a token and counts as changed', () => {
  const merged = mergeShares([], [{ path: '/a.md', expiresAt: 5_000 }], NOW, counter())
  expect(merged.shares).toEqual([{ token: 'token-1', path: '/a.md', expiresAt: 5_000 }])
  expect(merged.changed).toEqual(merged.shares)
  expect(merged.isChanged).toBe(true)
})

test('a live path keeps its token as it is touched; nothing new leaves the file unwritten', () => {
  const current = [{ token: 'keep', path: '/a.md', expiresAt: 5_000 }]
  const same = mergeShares(current, [{ path: '/a.md', expiresAt: 5_000 }], NOW, counter())
  expect(same).toEqual({ shares: current, changed: [], isChanged: false })
  const renewed = mergeShares(current, [{ path: '/a.md', expiresAt: 9_000 }], NOW, counter())
  expect(renewed.shares).toEqual([{ token: 'keep', path: '/a.md', expiresAt: 9_000 }])
  expect(renewed.changed).toEqual(renewed.shares)
})

test('an older touch from another session never shortens a link, and another session\'s entries stay', () => {
  const current = [{ token: 'keep', path: '/a.md', expiresAt: 9_000 }, { token: 'other', path: '/b.md', expiresAt: 8_000 }]
  expect(mergeShares(current, [{ path: '/a.md', expiresAt: 5_000 }], NOW, counter())).toEqual({ shares: current, changed: [], isChanged: false })
})

test('an expired entry is pruned on write, and its path gets a new token if it is still wanted', () => {
  const current = [{ token: 'dead', path: '/a.md', expiresAt: NOW }, { token: 'dead2', path: '/gone.md', expiresAt: 1 }]
  const merged = mergeShares(current, [{ path: '/a.md', expiresAt: 5_000 }], NOW, counter())
  expect(merged.shares).toEqual([{ token: 'token-1', path: '/a.md', expiresAt: 5_000 }])
  expect(merged.isChanged).toBe(true)
})

test('what is past expiry or secret-looking is never shared, even when asked or already in the file', () => {
  const merged = mergeShares([{ token: 's', path: '/r/.env', expiresAt: 9_000 }], [{ path: '/a.md', expiresAt: NOW }, { path: '/r/secret.md', expiresAt: 9_000 }], NOW, counter())
  expect(merged).toEqual({ shares: [], changed: [], isChanged: true })
})

test('two entries for one path, from a lost write, fold into the later', () => {
  const merged = mergeShares([{ token: 'a', path: '/a.md', expiresAt: 5_000 }, { token: 'b', path: '/a.md', expiresAt: 6_000 }], [], NOW, counter())
  expect(merged.shares).toEqual([{ token: 'b', path: '/a.md', expiresAt: 6_000 }])
})

test('rows take their entry from the file and lose one the file no longer has', () => {
  const doc = { path: '/a.md', touchedAt: 1, touches: 1 }
  const other = { path: '/b.md', touchedAt: 1, touches: 1, share: { token: 'old', expiresAt: 3 } }
  expect(adoptShares([doc, other], [{ token: 't', path: '/a.md', expiresAt: 5 }])).toEqual([{ ...doc, share: { token: 't', expiresAt: 5 } }, { path: '/b.md', touchedAt: 1, touches: 1 }])
  const superseded = { ...doc, isSuperseded: true }
  expect(adoptShares([superseded], [{ token: 't', path: '/a.md', expiresAt: 5 }])).toEqual([{ ...superseded, share: { token: 't', expiresAt: 5 } }])
  expect(adoptShares([superseded], [])).toEqual([superseded])
})

test('a link is the base, the token and the encoded basename', () => {
  expect(shareUrl('https://host.example:1', 'tok', '/r/a b#1.md')).toBe('https://host.example:1/tok/a%20b%231.md')
})

test('the plist keeps a read-only local server running, with the copied script, its port and files', () => {
  const plist = renderLinksPlist({ python: '/usr/bin/python3', dir: '/h/o&m/state', home: '/h/o&m', uid: '501' })
  const { plist: plistPath, log, label } = linksJobNames('/h/o&m', '501')
  expect(plistPath).toBe('/h/o&m/Library/LaunchAgents/com.session-summary.links.plist')
  expect(plist).toContain(`<key>Label</key><string>${label}</string>`)
  expect(plist).toContain('<key>RunAtLoad</key><true/>')
  expect(plist).toContain('<key>KeepAlive</key><true/>')
  const args = ['/usr/bin/python3', '-I', '/h/o&amp;m/state/session-summary/file_server.py', '--port', String(LINKS_LOCAL_PORT), '--shares', '/h/o&amp;m/state/session-summary/shares.json', '--log', '/h/o&amp;m/state/logs/session-summary-links.log']
  expect(plist).toContain(`<array>\n${args.map(a => `    <string>${a}</string>`).join('\n')}\n  </array>`)
  expect(plist).toContain(`<key>StandardOutPath</key><string>${log.replace('&', '&amp;')}</string>`)
  expect(plist).toContain('<key>WorkingDirectory</key><string>/h/o&amp;m</string>')
  expect(linksPaths('/s')).toEqual({ shares: '/s/session-summary/shares.json', script: '/s/session-summary/file_server.py', accessLog: '/s/logs/session-summary-links.log' })
})

const STATUS = { BackendState: 'Running', Self: { DNSName: 'host.tailnet.example.' }, CertDomains: ['host.tailnet.example'] }

test('the base comes from the status, its trailing dot gone', () => {
  expect(tailnetBase(JSON.stringify(STATUS))).toEqual({ base: `https://host.tailnet.example:${LINKS_HTTPS_PORT}` })
})

test('a tailnet that cannot serve is refused with its reason', () => {
  expect(tailnetBase('not json')).toEqual({ refusal: REFUSED.statusFailed })
  expect(tailnetBase(JSON.stringify({ ...STATUS, BackendState: 'NeedsLogin' }))).toEqual({ refusal: REFUSED.notRunning })
  expect(tailnetBase(JSON.stringify({ ...STATUS, Self: { DNSName: '' } }))).toEqual({ refusal: REFUSED.noName })
  expect(tailnetBase(JSON.stringify({ ...STATUS, CertDomains: null }))).toEqual({ refusal: REFUSED.noHttps })
  expect(tailnetBase(JSON.stringify({ ...STATUS, CertDomains: [] }))).toEqual({ refusal: REFUSED.noHttps })
})

const serve = (proxy: string, port = LINKS_HTTPS_PORT) => JSON.stringify({ TCP: { [port]: { HTTPS: true } }, Web: { [`host.example:${port}`]: { Handlers: { '/': { Proxy: proxy } } } } })

test('the port is ours only under our own proxy; anything else, or an unreadable status, is left alone', () => {
  expect(servePortHolder('{}')).toBe('none')
  expect(servePortHolder(serve('http://127.0.0.1:1', 443))).toBe('none')
  expect(servePortHolder(serve(LOCAL_TARGET))).toBe('ours')
  expect(servePortHolder(serve(`${LOCAL_TARGET}/`))).toBe('ours')
  expect(servePortHolder(serve('http://127.0.0.1:1'))).toBe('other')
  expect(servePortHolder(JSON.stringify({ TCP: { [LINKS_HTTPS_PORT]: { TCPForward: '127.0.0.1:1' } } }))).toBe('other')
  expect(servePortHolder('')).toBe('other')
  expect(servePortHolder('null')).toBe('other')
})
