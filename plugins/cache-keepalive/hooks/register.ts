import type { EngineInterface, Register } from 'claude-code'
import type { KeepaliveTiming } from '../types'
import { isConversationReplaced, mainTurnEnded, mainTurnStarted, PERSON_ORIGINS } from './shared/events.ts'
import type { MainTurn } from './shared/events.ts'
import { record } from './shared/record.ts'
import { accountChangedText, accountOf, AUTH_STATUS, bumpText, capFor, COLD_LIMIT, COMMAND, followsFirstRequest, isAccountChanged, isDue, OFF_TOOL, TICK_MS, wasCold } from './keepalive.ts'
import { keepaliveCommand, keepaliveReply } from './settings.ts'

export { isConversationReplaced }

// Keeps the main conversation's prompt cache warm while the session sits open and idle: a short
// prompt LEAD_MS before the cache would expire. The cache lifetime runs from the start of the
// main thread's last answered request, and each such request resets it; a request with no
// response (interrupted before its first token, or dead on an API error) leaves it as it was.
// Bumps stop at the model's cap; the last one asks the agent to close the session (a closing skill, a handoff skill, or a handoff it writes) while the cache is still warm.
// The person's own next prompt resets the count. A bump that finds the cache already cold has
// just rebuilt it, so the bumps go on; COLD_LIMIT cold bumps in a row (the TTL dropped to 5m
// past plan usage, so every bump lands after expiry) stop them until the person is back. So
// does a change of account (`claude auth status`, polled each tick while the cache may be warm;
// a read that a prompt or a turn overlapped is discarded, and a failed read changes nothing):
// the prompt cache is the account's own, so the next request under another account rebuilds it
// whole. A bump that got no response left the cache as it was; it is not sent again, and the
// status line says so. `/keepalive off` stops them for the conversation, a typed prompt
// included, until `/keepalive on`.
//
// A compaction replaces the conversation, so the cache holds none of what the next request sends:
// the timing starts over and no bump comes until a request writes the new conversation; a request
// still running when the conversation was replaced (a compaction, /clear) times nothing. The bump
// after a conversation's first request is never counted cold: Claude Code sends that request's
// marked system message as a block list and, unmarked on the next request, as a plain string, so
// the next request misses the cache past the system prompt however warm it is.
//
// Every bump is submitted asUser, so the model reads the bare text without the engine's
// "The cache-keepalive plugin sent a message" frame. A bump is still not a rewind point: the
// rewind list holds the person's own prompts, and asUser keeps the plugin origin.

const PLUGIN = 'cache-keepalive'
const TIMING = { plugin: 'cache-keepalive', key: 'timing' } as const

const fresh = (): KeepaliveTiming => ({ lastSend: 0, bumpedFor: 0, firstSend: 0, bumps: 0, coldBumps: 0, model: '', account: '', isStopped: false, isOff: false })

// The account this session sends under, '' when logged out; undefined when the read failed or named no account.
async function currentAccount($: EngineInterface): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(AUTH_STATUS, { timeoutMs: 5_000 })
    return exitCode === 0 ? accountOf(stdout) : undefined
  } catch {
    return undefined
  }
}

// One load's timing writes: how many went out, and the newest of them that landed.
type Writes = { issued: number; newestLanded: number }

// Stores the timing `live` answers, whole. A write that lands after a later one landed (a
// state.set hook held it) put an older timing over a newer one, so it writes the timing again.
async function save($: EngineInterface, writes: Writes, live: () => KeepaliveTiming): Promise<void> {
  const write = ++writes.issued
  await $.state.set(TIMING, { ...live() })
  const isOvertaken = write < writes.newestLanded
  writes.newestLanded = Math.max(writes.newestLanded, write)
  if (isOvertaken) await save($, writes, live)
}

export const register: Register = on => {
  // The timing lives here for synchronous checks and is written through to $.state, which
  // keeps it across a hot reload; session.start reads it back.
  let t = fresh()
  const live = () => t
  const writes: Writes = { issued: 0, newestLanded: 0 }
  let mainTurn: MainTurn | undefined
  let isBumpPending = false // a bump was submitted and its turn has not started
  let isBumpTurn = false // the running main turn is a bump
  let tick: { cancel: () => void } | undefined
  let epoch = 0

  on('session.start', async ($, e, next) => {
    tick?.cancel()
    tick = undefined
    if (e.isInteractive) {
      const { value } = await $.state.get(TIMING)
      if (value) t = { ...fresh(), ...value }
      $.ui.status(t.isOff ? 'keepalive off' : undefined)
      // Claude Code's main-conversation TTL: 1h on a subscription within plan usage, 5m when
      // set so. Past plan usage it drops to 5m on its own; the first bump then finds the cache
      // cold and stops the rest (turn.complete below).
      const force = await $.env.get('FORCE_PROMPT_CACHING_5M')
      const is5m = force === '1' || force === 'true' || (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')) === '5m'
      const ttl = (is5m ? 5 : 60) * 60_000

      tick = $.clock.every(TICK_MS, async () => {
        const polledAt = await $.clock.now()
        // Polled only while a bump could still come: idle, not stopped or off, cache not expired.
        if (mainTurn === undefined && !t.isStopped && !t.isOff && t.lastSend > 0 && polledAt < t.lastSend + ttl) {
          const epochAtRead = epoch
          const account = await currentAccount($)
          if (epoch !== epochAtRead) return
          if (account !== undefined && isAccountChanged(t.account, account)) {
            t.isStopped = true
            $.ui.status(accountChangedText(t.account, account))
            await record($, PLUGIN, 'stopped-account', 'account changed')
            await save($, writes, live)
            return
          }
        }
        const now = await $.clock.now()
        if (!isDue({ ...t, now, ttl, isBusy: mainTurn !== undefined })) return
        t.bumpedFor = t.lastSend
        const cap = capFor(t.model)
        if (t.bumps >= cap) {
          $.ui.status(`keepalive: done (${cap}/${cap}), cache left to expire`)
          await record($, PLUGIN, 'done', `${cap}/${cap}`)
          await save($, writes, live)
          return
        }
        t.bumps++
        isBumpPending = true
        $.ui.status(`keepalive ${t.bumps}/${cap}`)
        try {
          await $.prompt.submit({ text: bumpText(t.bumps, cap), asUser: true })
          await record($, PLUGIN, 'bump', `${t.bumps}/${cap}`)
        } catch {
          isBumpPending = false
          $.ui.status('keepalive: submit failed')
        }
        await save($, writes, live)
      })
      // After the timer, so a refused registration costs the command, not the bumps.
      await $.command.register({
        name: COMMAND,
        description: 'Stop or resume the prompt-cache keepalive pings for this conversation',
        argumentHint: '[off|on]',
        immediate: true,
      })
      // The agent's way to `/keepalive off`, for a skill that closes the session.
      try {
        await $.tool.register({
          name: OFF_TOOL,
          description:
            "Turns off the prompt-cache keepalive pings for this conversation, as the person's /keepalive off does; they resume with /keepalive on. Call it when the session is finished and nothing more should be pinged.",
        })
      } catch (err) {
        $.ui.toast(`${OFF_TOOL} not registered: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const { isOff, text } = keepaliveReply(t.isOff, keepaliveCommand(e.args))
    t.isOff = isOff
    $.ui.status(isOff ? 'keepalive off' : undefined)
    await save($, writes, live)
    return { text }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__${OFF_TOOL}` }, async ($, e) => {
    const { isOff, text } = keepaliveReply(t.isOff, keepaliveCommand('off'))
    t.isOff = isOff
    $.ui.status('keepalive off')
    await record($, PLUGIN, 'off', 'turned off by the agent')
    await save($, writes, live)
    return { result: text }
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.has(e.origin.kind)) {
      epoch++
      t.bumps = 0
      t.coldBumps = 0
      t.isStopped = false
      isBumpPending = false
      $.ui.status(t.isOff ? 'keepalive off' : undefined)
      await save($, writes, live)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    epoch++
    mainTurn = mainTurnStarted(mainTurn, e)
    isBumpTurn = isBumpPending
    isBumpPending = false
    // Any main turn that is not a bump is the person's: the bump count leaves the status line.
    if (!isBumpTurn) $.ui.status(t.isOff ? 'keepalive off' : undefined)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const timing = t
    const startedAt = await $.clock.now()
    const read = currentAccount($)
    let isAnswered = false
    try {
      const stream = next(e)
      for await (const chunk of stream) {
        if (chunk.kind !== 'engine') isAnswered = true
        yield chunk
      }
      const result = await stream.result
      if (result.stopReason !== null) isAnswered = true
      return result
    } finally {
      if (isAnswered) {
        if (timing.lastSend === 0) timing.firstSend = startedAt
        timing.lastSend = startedAt
        timing.model = e.model
        const account = await read
        if (account !== undefined) timing.account = account
        if (timing === t) await save($, writes, live)
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      mainTurn = mainTurnEnded(mainTurn, e)
      if (mainTurn !== undefined) {
        // Another turn is running: its bump bookkeeping is not this completion's to touch.
        await record($, PLUGIN, 'turn-id-mismatch', `running=${mainTurn.turnId} completed=${e.turnId}`)
        return next(e)
      }
      if (isBumpTurn && t.lastSend > 0 && t.lastSend === t.bumpedFor) {
        $.ui.status('keepalive: ping got no response, cache left to expire')
        await record($, PLUGIN, 'no-response', 'ping got no response')
      } else if (isBumpTurn && e.usage && !followsFirstRequest(t)) {
        t.coldBumps = wasCold(e.usage) ? t.coldBumps + 1 : 0
        if (t.coldBumps >= COLD_LIMIT) {
          t.isStopped = true
          $.ui.status(`keepalive: cache cold ${COLD_LIMIT} pings in a row, stopped until your next prompt`)
          await record($, PLUGIN, 'stopped-cold', `${COLD_LIMIT} pings in a row`)
        } else if (t.coldBumps > 0) {
          $.ui.status('keepalive: cache was cold, rebuilt; pings go on')
        }
        await save($, writes, live)
      }
      isBumpTurn = false
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (isConversationReplaced(e, result)) {
      t = { ...fresh(), model: t.model, account: t.account, isOff: t.isOff }
      isBumpPending = false
      $.ui.status(t.isOff ? 'keepalive off' : undefined)
      await save($, writes, live)
    }
    return result
  })

  // /clear and an in-session resume end this conversation without a session.start for the next,
  // so its timing must not carry over.
  on('session.end', async ($, e, next) => {
    t = fresh()
    mainTurn = undefined
    isBumpPending = false
    isBumpTurn = false
    $.ui.status(undefined)
    await save($, writes, live)
    return next(e)
  })
}
