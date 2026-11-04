import type { Doc } from '../types'
import { LINK_TTL_MS, LINKS_ACCESS_LOG, LINKS_HTTPS_PORT, LINKS_LABEL, LINKS_LOCAL_PORT } from './config.ts'
import { logPath } from './shared/firing.ts'
import { jobNames, plistText } from './shared/launchd.ts'
import type { JobNames } from './shared/launchd.ts'
import { isRecord } from './shared/typed.ts'

// /session-summary links' pure side. The shares file is the contract with scripts/file_server.py,
// which re-reads it per request; scripts/test_file_server.py runs these functions against that
// server, so a change to either side fails there.

export type Share = { token: string; path: string; expiresAt: number } // expiresAt: ms since the epoch

export function parseShares(text: string): Share[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((s): Share[] =>
    isRecord(s) && typeof s.token === 'string' && typeof s.path === 'string' && typeof s.expiresAt === 'number' ? [{ token: s.token, path: s.path, expiresAt: s.expiresAt }] : [],
  )
}

export function sharesText(shares: readonly Share[]): string {
  return `${JSON.stringify(shares)}\n`
}

// Any segment of the path, so a file inside a folder named for secrets stays out too. Kept in step
// with SECRET_SEGMENT in file_server.py; the server test compares the two.
const SECRET_SEGMENT = /^\.env|\.pem$|\.key$|^id_(rsa|ed25519|ecdsa|dsa)|credentials|secret/i

export function isSecretPath(path: string): boolean {
  return path.split('/').some(segment => SECRET_SEGMENT.test(segment))
}

// 128 bits, hex: the file server takes nothing else as a token.
export function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function shareUrl(base: string, token: string, path: string): string {
  return `${base}/${token}/${encodeURIComponent(path.split('/').at(-1) ?? '')}`
}

// What the list asks to have shared: each file not secret-looking, until 7 days past its latest
// touch. A relative path (a capture from before the list kept absolute ones) waits for its first merge.
export function wantedShares(docs: readonly Doc[]): { path: string; expiresAt: number }[] {
  return docs.filter(d => d.path.startsWith('/') && !isSecretPath(d.path)).map(d => ({ path: d.path, expiresAt: d.touchedAt + LINK_TTL_MS }))
}

export type Merged = { shares: Share[]; changed: Share[]; isChanged: boolean }

// The file's entries with this session's wanted ones merged in: an expired entry is pruned, a path
// keeps its token while its entry lives, and an entry only ever moves to a later expiry, so a
// session that last touched a file sooner never shortens another's link. `changed` is what was
// newly shared or renewed; `isChanged` says the file needs writing.
export function mergeShares(current: readonly Share[], wanted: readonly { path: string; expiresAt: number }[], now: number, token: () => string): Merged {
  const live = new Map<string, Share>()
  for (const share of current) {
    const seen = live.get(share.path)
    if (share.expiresAt > now && !isSecretPath(share.path) && (seen === undefined || share.expiresAt > seen.expiresAt)) live.set(share.path, share)
  }
  const changed: Share[] = []
  for (const { path, expiresAt } of wanted) {
    if (expiresAt <= now || isSecretPath(path)) continue
    const seen = live.get(path)
    if (seen !== undefined && seen.expiresAt >= expiresAt) continue
    const share = { token: seen?.token ?? token(), path, expiresAt }
    live.set(path, share)
    changed.push(share)
  }
  const shares = [...live.values()]
  return { shares, changed, isChanged: sharesText(shares) !== sharesText(current) }
}

// Each document with its entry in the file, if it has one.
export function adoptShares(docs: readonly Doc[], shares: readonly Share[]): Doc[] {
  const byPath = new Map(shares.map(s => [s.path, s]))
  return docs.map(({ share: _, ...doc }) => {
    const share = byPath.get(doc.path)
    return share === undefined ? doc : { ...doc, share: { token: share.token, expiresAt: share.expiresAt } }
  })
}

export function linksPaths(dir: string): { shares: string; script: string; accessLog: string } {
  return {
    shares: `${dir}/session-summary/shares.json`,
    script: `${dir}/session-summary/file_server.py`,
    accessLog: logPath(dir, LINKS_ACCESS_LOG),
  }
}

export function linksJobNames(home: string, uid: string): JobNames {
  return jobNames(LINKS_LABEL, home, uid)
}

// Runs the copy of the script under the state dir: an installed plugin's folder changes with its
// version, and launchd would keep restarting a path that is gone. `-I` keeps launchd's environment
// and the working folder out of what Python imports.
export function renderLinksPlist(r: { python: string; dir: string; home: string; uid: string }): string {
  const { script, shares, accessLog } = linksPaths(r.dir)
  return plistText({
    names: linksJobNames(r.home, r.uid),
    argv: [r.python, '-I', script, '--port', String(LINKS_LOCAL_PORT), '--shares', shares, '--log', accessLog],
    home: r.home,
    env: [
      ['HOME', r.home],
      ['PATH', '/usr/bin:/bin'],
    ],
    trigger: ['  <key>RunAtLoad</key><true/>', '  <key>KeepAlive</key><true/>'],
  })
}

export const LOCAL_TARGET = `http://127.0.0.1:${LINKS_LOCAL_PORT}`

export const REFUSED = {
  notMacOS: 'cannot turn links on: the file server runs as a launchd job, so links work on macOS only',
  noHome: 'cannot turn links on: HOME is not set',
  noUid: 'cannot turn links on: `id -u` failed or printed nothing',
  noPython: 'cannot turn links on: no python3 on PATH',
  noTailscale: 'cannot turn links on: Tailscale is not installed (no tailscale on PATH, no Tailscale app)',
  statusFailed: 'cannot turn links on: `tailscale status --json` failed; is Tailscale running?',
  notRunning: 'cannot turn links on: Tailscale is not running or not logged in',
  noName: 'cannot turn links on: Tailscale reports no DNS name for this machine; turn on MagicDNS for the tailnet',
  noHttps: 'cannot turn links on: the tailnet has no HTTPS; turn on HTTPS Certificates in the Tailscale admin console',
  portTaken: `cannot turn links on: tailscale serve already has another target on https port ${LINKS_HTTPS_PORT}, and links leave it alone`,
}

// The https base links are built on, from `tailscale status --json`, or why there is none.
export function tailnetBase(statusJson: string): { base: string } | { refusal: string } {
  let status: unknown
  try {
    status = JSON.parse(statusJson)
  } catch {
    return { refusal: REFUSED.statusFailed }
  }
  if (!isRecord(status) || status.BackendState !== 'Running') return { refusal: REFUSED.notRunning }
  const name = isRecord(status.Self) && typeof status.Self.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : ''
  if (name === '') return { refusal: REFUSED.noName }
  if (!Array.isArray(status.CertDomains) || status.CertDomains.length === 0) return { refusal: REFUSED.noHttps }
  return { base: `https://${name}:${LINKS_HTTPS_PORT}` }
}

// Who holds the links' https port, from `tailscale serve status --json`: nobody, links' own proxy,
// or something else. What cannot be read counts as something else: it is never touched.
export function servePortHolder(statusJson: string): 'none' | 'ours' | 'other' {
  let status: unknown
  try {
    status = JSON.parse(statusJson)
  } catch {
    return 'other'
  }
  if (!isRecord(status)) return 'other'
  const tcp = isRecord(status.TCP) ? status.TCP[String(LINKS_HTTPS_PORT)] : undefined
  if (tcp === undefined) return 'none'
  const web = isRecord(status.Web) ? Object.entries(status.Web).find(([host]) => host.endsWith(`:${LINKS_HTTPS_PORT}`))?.[1] : undefined
  const handlers = isRecord(web) ? web.Handlers : undefined
  if (!isRecord(handlers) || Object.keys(handlers).length !== 1) return 'other'
  const root = handlers['/']
  return isRecord(root) && typeof root.Proxy === 'string' && root.Proxy.replace(/\/$/, '') === LOCAL_TARGET ? 'ours' : 'other'
}
