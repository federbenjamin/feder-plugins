import type { EngineInterface } from 'claude-code'
import { firingReason } from './call.ts'
import { conciseRequest, conciseResult, EMPTY_CONCISE, lastResponse } from './concise.ts'
import { CONCISE_COMMAND, CONCISE_REQUEST, CONCISE_VARIANT, PLUGIN } from './config.ts'
import { openPane, readConcise, writeConcise } from './pane.tsx'
import { PRICES, usageUsd } from './shared/pricing.ts'
import { record } from './shared/record.ts'

// /summarize: a shorter copy of the agent's last response, in the pane's bottom section. It prints
// nothing, because a command's printed text is recorded for the model and the point is to keep the
// copy out of the context. A newer run cuts the one before it; a /clear empties the section.

export type ConciseState = {
  isInteractive: boolean
  run: number // bumped by each run and reset, so an older run writes nothing
  controller: AbortController | undefined
}

export const newConciseState = (): ConciseState => ({ isInteractive: false, run: 0, controller: undefined })

function stop(state: ConciseState): void {
  state.controller?.abort()
  state.controller = undefined
  state.run++
}

async function summarize($: EngineInterface, state: ConciseState, id: number): Promise<void> {
  const isCurrent = () => id === state.run
  const reason = { source: 'messages', variant: CONCISE_VARIANT, trigger: 'summarize' } as const
  const write = (status: 'working' | 'ready' | 'failed', text: string, at: number) => writeConcise($, c => (isCurrent() ? { status, text, at, offset: 0 } : c))
  try {
    const startedAt = await $.clock.now()
    await write('working', 'Shortening the last response.', startedAt)
    const response = lastResponse(await $.session.messages())
    if (!isCurrent()) return
    if (response === '') {
      await write('failed', 'The agent has no response to shorten yet.', startedAt)
      await record($, PLUGIN, 'skip-no-response', firingReason(reason))
      return
    }
    const mine = new AbortController()
    state.controller = mine
    let reply
    try {
      reply = await $.model.complete({ ...CONCISE_REQUEST, ...conciseRequest(response) }, { signal: mine.signal })
    } finally {
      if (state.controller === mine) state.controller = undefined
    }
    const endedAt = await $.clock.now()
    const result = conciseResult(reply, CONCISE_REQUEST.maxTokens)
    await write(result.status, result.text, endedAt)
    await record($, PLUGIN, result.outcome, firingReason({ ...reason, usage: reply.usage, usd: usageUsd(reply.usage, PRICES[CONCISE_REQUEST.model]), failure: result.failure }), endedAt - startedAt)
  } catch (error) {
    const failure = error instanceof Error ? error.message : 'summarize failed'
    await write('failed', 'The call failed. Run /summarize again.', 0).catch(() => undefined)
    await record($, PLUGIN, 'api-error', firingReason({ ...reason, failure }))
  }
}

export async function runConcise($: EngineInterface, state: ConciseState): Promise<{ text?: string }> {
  if (!state.isInteractive) return { text: '/summarize shows its result in the pane, in interactive sessions only' }
  stop(state)
  void summarize($, state, state.run)
  await openPane($)
  return {}
}

export async function startConcise($: EngineInterface, state: ConciseState, isInteractive: boolean): Promise<void> {
  stop(state)
  state.isInteractive = isInteractive
  await $.command.register({
    name: CONCISE_COMMAND,
    description: "Show a shorter copy of the agent's last response in the session summary pane, outside the context",
    immediate: true,
  })
  // A reload dropped the run that was writing it.
  if ((await readConcise($)).status === 'working') await writeConcise($, () => EMPTY_CONCISE)
}

export async function endConcise($: EngineInterface, state: ConciseState): Promise<void> {
  stop(state)
  try {
    await writeConcise($, () => EMPTY_CONCISE)
  } catch {
    // the section keeps the old text until the next run
  }
}
