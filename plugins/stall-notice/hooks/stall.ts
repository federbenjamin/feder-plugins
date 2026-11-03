// The decisions behind the stall notice: which calls are timed, which are due a notice, and what
// the notice says.

export const STALL_MS = 15 * 60_000
export const TICK_MS = 30_000
// A gap this long between ticks means the machine slept, and no tool ran through it.
export const SLEEP_GAP_MS = 5 * TICK_MS

// A nested Agent call runs as long as its agent does, and that agent's own calls are timed.
const NESTED_AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

export type RunningCall = { agentId: string; tool: string; startedAt: number; isNoticed: boolean }

export function isTimed(e: { tool: string; agentId?: string }): e is { tool: string; agentId: string } {
  return e.agentId !== undefined && !NESTED_AGENT_TOOLS.has(e.tool)
}

export function dueCalls(calls: Iterable<RunningCall>, now: number): RunningCall[] {
  return [...calls].filter(c => !c.isNoticed && now - c.startedAt >= STALL_MS)
}

// How far to move the running calls' start times: the whole gap when the machine slept through it.
export function sleptMs(lastTick: number, now: number): number {
  const gap = now - lastTick
  return gap >= SLEEP_GAP_MS ? gap : 0
}

export function noticeText(calls: readonly RunningCall[], now: number): string {
  const lines = calls.map(c => `Subagent ${c.agentId}: its ${c.tool} call has been running for ${Math.floor((now - c.startedAt) / 60_000)} minutes.`)
  return [...lines, 'It may be hung. Check what it was told to produce; if it is stuck, stop it with TaskStop and take the work back.'].join('\n')
}
