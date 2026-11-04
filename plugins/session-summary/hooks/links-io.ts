import type { EngineInterface } from 'claude-code'
import { LINKS_HTTPS_PORT, LINKS_LOCAL_PORT, LINKS_READY_TRIES, LINKS_READY_WAIT_MS, PLUGIN, TAILSCALE_APP_CLI, TAILSCALE_TIMEOUT_MS } from './config.ts'
import { adoptShares, LOCAL_TARGET, linksJobNames, linksPaths, mergeShares, newToken, parseShares, REFUSED, renderLinksPlist, servePortHolder, sharesText, tailnetBase, wantedShares } from './links.ts'
import type { Share } from './links.ts'
import { readDocuments, writeDocuments } from './pane.tsx'
import { isMacOS } from './shared/launchd.ts'
import { loadJob, readLine, unloadJob } from './shared/launchd-run.ts'
import { record, stateDirs } from './shared/record.ts'
import { stderrHead } from './shared/text.ts'

// /session-summary links' I/O: the job and the serve entry it turns on and off, and the shares file
// each session keeps in step with its documents list. links.ts holds the decisions.

async function tailscalePath($: EngineInterface): Promise<string> {
  const onPath = await readLine($, ['which', 'tailscale'])
  if (onPath !== '') return onPath
  return (await $.fs.exists(TAILSCALE_APP_CLI)) ? TAILSCALE_APP_CLI : ''
}

async function serveStatus($: EngineInterface, tailscale: string): Promise<string> {
  const r = await $.process.run([tailscale, 'serve', 'status', '--json'], { timeoutMs: TAILSCALE_TIMEOUT_MS })
  return r.exitCode === 0 ? r.stdout : ''
}

async function isServerUp($: EngineInterface): Promise<boolean> {
  for (let i = 0; i < LINKS_READY_TRIES; i++) {
    const r = await $.process.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '1', `${LOCAL_TARGET}/`])
    if (r.stdout.trim() === '404') return true
    await $.clock.sleep(LINKS_READY_WAIT_MS)
  }
  return false
}

export type LinksOn = { text: string; base?: string }

// Every refusal comes before anything on the machine changes; a failure after the job loaded takes
// the job back out.
export async function linksOn($: EngineInterface): Promise<LinksOn> {
  const { home, dir } = await stateDirs($)
  if (!isMacOS(await readLine($, ['uname', '-s']))) return { text: REFUSED.notMacOS }
  if (home === '' || dir === '') return { text: REFUSED.noHome }
  const tailscale = await tailscalePath($)
  if (tailscale === '') return { text: REFUSED.noTailscale }
  const status = await $.process.run([tailscale, 'status', '--json'], { timeoutMs: TAILSCALE_TIMEOUT_MS })
  if (status.exitCode !== 0) return { text: REFUSED.statusFailed }
  const tailnet = tailnetBase(status.stdout)
  if ('refusal' in tailnet) return { text: tailnet.refusal }
  if (servePortHolder(await serveStatus($, tailscale)) === 'other') return { text: REFUSED.portTaken }
  const python = await readLine($, ['which', 'python3'])
  if (python === '') return { text: REFUSED.noPython }
  const uid = await readLine($, ['id', '-u'])
  if (uid === '') return { text: REFUSED.noUid }

  const paths = linksPaths(dir)
  const names = linksJobNames(home, uid)
  await $.fs.write(paths.script, String(await $.fs.read(`${$.plugin.root}/scripts/file_server.py`)))
  const made = await $.process.run(['mkdir', '-p', names.logDir])
  if (made.exitCode !== 0) return { text: `cannot turn links on: mkdir ${names.logDir} failed: ${stderrHead(made.stderr)}` }
  const failure = await loadJob($, names, renderLinksPlist({ python, dir, home, uid }))
  if (failure !== '') return { text: `cannot turn links on: ${failure}` }
  const undo = async (why: string): Promise<LinksOn> => {
    await unloadJob($, names)
    await $.process.run(['rm', '-f', names.plist])
    return { text: `cannot turn links on: ${why}` }
  }
  if (!(await isServerUp($))) return undo(`the file server did not answer on ${LOCAL_TARGET}; its log is ${names.log}`)
  const serve = await $.process.run([tailscale, 'serve', '--bg', `--https=${LINKS_HTTPS_PORT}`, LOCAL_TARGET], { timeoutMs: TAILSCALE_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: 1, stderr: error instanceof Error ? error.message : 'it did not finish' }))
  if (serve.exitCode !== 0) return undo(`tailscale serve failed: ${stderrHead(serve.stderr)}`)
  await record($, PLUGIN, 'links-on', `https=${LINKS_HTTPS_PORT} local=${LINKS_LOCAL_PORT}`)
  return { text: `links on: ${tailnet.base}. Any device on your tailnet holding a link can read that one file for 7 days from when it joined the list or was last touched. /session-summary links off ends it.`, base: tailnet.base }
}

// Each step runs whatever the one before came to: the shares go first, so every link is dead from
// the start. Only the links' own serve entry is removed.
export async function linksOff($: EngineInterface): Promise<string> {
  const { home, dir } = await stateDirs($)
  const notes: string[] = []
  if (dir !== '') {
    const { shares, script } = linksPaths(dir)
    await $.process.run(['rm', '-f', shares, script])
  }
  const tailscale = await tailscalePath($)
  if (tailscale !== '') {
    const holder = servePortHolder(await serveStatus($, tailscale))
    if (holder === 'other') notes.push(`left tailscale serve's entry on https port ${LINKS_HTTPS_PORT}: it is not one links made, or its status could not be read`)
    if (holder === 'ours') {
      const off = await $.process.run([tailscale, 'serve', `--https=${LINKS_HTTPS_PORT}`, 'off'], { timeoutMs: TAILSCALE_TIMEOUT_MS })
      if (off.exitCode !== 0) notes.push(`tailscale serve --https=${LINKS_HTTPS_PORT} off failed: ${stderrHead(off.stderr)}`)
    }
  }
  if (home !== '') {
    const { plist, logDir } = linksJobNames(home, '')
    if ((await $.fs.exists(plist)) || (await $.fs.exists(logDir))) {
      const uid = await readLine($, ['id', '-u'])
      if (uid === '') notes.push('`id -u` failed, so the launchd job stays')
      else {
        const names = linksJobNames(home, uid)
        const { failure } = await unloadJob($, names)
        if (failure !== '') notes.push(`${failure}; the job stays`)
        else await $.process.run(['rm', '-rf', names.plist, names.logDir])
      }
    }
  }
  await record($, PLUGIN, 'links-off', notes.length > 0 ? 'partial' : 'clean')
  return notes.length > 0 ? `links off, with leftovers: ${notes.join('; ')}` : 'links off: every link is dead; the file server and its tailscale serve entry are gone'
}

// Written whole under a name of its own, then renamed: several sessions write this file, and the
// server reads it per request. It holds bearer tokens, so it is readable by its owner only.
async function writeShares($: EngineInterface, path: string, shares: readonly Share[]): Promise<void> {
  const folder = path.slice(0, path.lastIndexOf('/'))
  const temp = `${path}.${await $.session.id()}.tmp`
  const r = await $.process.run(['/bin/sh', '-c', 'umask 077 && mkdir -p "$1" && cat > "$2" && mv "$2" "$3"', 'sh', folder, temp, path], { stdin: sharesText(shares) })
  if (r.exitCode !== 0) throw new Error(`shares write exited ${r.exitCode}`)
}

// Brings the shares file and this session's rows into step: level-triggered, so a list from before
// links came on is shared too, and an entry another session's write lost comes back next tick.
export async function syncShares($: EngineInterface, isCurrent: () => boolean): Promise<void> {
  const { dir } = await stateDirs($)
  if (dir === '') return
  const { shares: path } = linksPaths(dir)
  const docs = await readDocuments($)
  const current = (await $.fs.exists(path)) ? parseShares(String(await $.fs.read(path))) : []
  const merged = mergeShares(current, wantedShares(docs), await $.clock.now(), newToken)
  if (merged.isChanged) await writeShares($, path, merged.shares)
  for (const share of merged.changed) await record($, PLUGIN, 'share', `token=${share.token.slice(0, 8)} expires=${new Date(share.expiresAt).toISOString()}`)
  await writeDocuments($, list => (isCurrent() ? adoptShares(list, merged.shares) : list))
}
