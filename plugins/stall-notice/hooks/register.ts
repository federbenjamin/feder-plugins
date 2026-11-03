import type { Register } from 'claude-code'
import { record } from './shared/record.ts'
import { dueCalls, isTimed, noticeText, sleptMs, TICK_MS } from './stall.ts'
import type { RunningCall } from './stall.ts'

// Times each subagent tool call from its start to its result. A call still running at STALL_MS
// gets one prompt to the main session, which starts a turn as soon as that session is idle.
// Calls are held only here, so a plugin reload stops timing the calls then running.

const PLUGIN = 'stall-notice'

export const register: Register = on => {
  const calls = new Set<RunningCall>()
  let tick: { cancel: () => void } | undefined
  let lastTick = 0

  on('session.start', async ($, e, next) => {
    tick?.cancel()
    tick = undefined
    if (e.isInteractive) {
      lastTick = await $.clock.now()
      tick = $.clock.every(TICK_MS, async () => {
        const now = await $.clock.now()
        const slept = sleptMs(lastTick, now)
        lastTick = now
        for (const c of calls) c.startedAt += slept

        const due = dueCalls(calls, now)
        if (due.length === 0) return
        for (const c of due) c.isNoticed = true
        const running = new Set((await $.agent.list()).filter(a => a.status === 'running').map(a => a.id))
        const stalled = due.filter(c => running.has(c.agentId))
        if (stalled.length === 0) return
        try {
          const sent = await $.prompt.submit({ text: noticeText(stalled, now) })
          if (sent.drop !== undefined) {
            await record($, PLUGIN, 'submit-failed', `calls=${stalled.length}`)
            return
          }
          for (const c of stalled) await record($, PLUGIN, 'notice', `agent=${c.agentId} tool=${c.tool}`)
        } catch {
          await record($, PLUGIN, 'submit-failed', `calls=${stalled.length}`)
        }
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!isTimed(e)) return next(e)
    const call: RunningCall = { agentId: e.agentId, tool: e.tool, startedAt: await $.clock.now(), isNoticed: false }
    calls.add(call)
    try {
      return await next(e)
    } finally {
      calls.delete(call)
    }
  })

  on('session.end', async ($, e, next) => {
    calls.clear()
    return next(e)
  })
}
