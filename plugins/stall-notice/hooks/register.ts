import type { Register } from 'claude-code'
import { record } from './shared/record.ts'
import { dueCalls, isTimed, noticeText, sleptMs, TICK_MS } from './stall.ts'
import type { RunningCall } from './stall.ts'

// Times each subagent tool call from its start to its result. A call still running at STALL_MS
// gets one prompt to the main session, which starts a turn as soon as that session is idle.
// The timer runs only while a subagent is in a turn; with none, the plugin does no work. It starts
// at the subagent's turn.start, because a timer started from a tool.call hook may not submit a
// prompt: that hook holds the turn the prompt would wait on.
// Calls are held only here, so a plugin reload stops timing the calls then running.

const PLUGIN = 'stall-notice'

export const register: Register = on => {
  const calls = new Set<RunningCall>()
  const agentsInTurn = new Set<string>()
  let startTick: (() => void) | undefined // set in an interactive session, which alone is watched
  let tick: { cancel: () => void } | undefined
  let lastTick = 0

  const stopTick = () => {
    tick?.cancel()
    tick = undefined
  }

  const forgetAll = () => {
    stopTick()
    calls.clear()
    agentsInTurn.clear()
  }

  on('session.start', async ($, e, next) => {
    forgetAll()
    startTick = !e.isInteractive
      ? undefined
      : () => {
          tick = $.clock.every(TICK_MS, async () => {
            const now = await $.clock.now()
            const slept = sleptMs(lastTick, now)
            lastTick = now
            for (const c of calls) c.startedAt += slept

            const due = dueCalls(calls, now)
            if (due.length === 0) return
            for (const c of due) c.isNoticed = true
            try {
              const running = new Set((await $.agent.list()).filter(a => a.status === 'running').map(a => a.id))
              const stalled = due.filter(c => running.has(c.agentId))
              if (stalled.length === 0) return
              const sent = await $.prompt.submit({ text: noticeText(stalled, now) })
              if (sent.drop !== undefined) {
                await record($, PLUGIN, 'submit-failed', `calls=${stalled.length}`)
                return
              }
              for (const c of stalled) await record($, PLUGIN, 'notice', `agent=${c.agentId} tool=${c.tool}`)
            } catch {
              await record($, PLUGIN, 'submit-failed', `calls=${due.length}`)
            }
          })
        }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (startTick !== undefined && e.agentId !== undefined) {
      agentsInTurn.add(e.agentId)
      if (tick === undefined) {
        lastTick = await $.clock.now()
        startTick()
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      agentsInTurn.delete(e.agentId)
      if (agentsInTurn.size === 0) stopTick()
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (startTick === undefined || !isTimed(e)) return next(e)
    const call: RunningCall = { agentId: e.agentId, tool: e.tool, startedAt: await $.clock.now(), isNoticed: false }
    calls.add(call)
    try {
      return await next(e)
    } finally {
      calls.delete(call)
    }
  })

  on('session.end', async ($, e, next) => {
    forgetAll()
    return next(e)
  })
}
