import type { EngineInterface } from 'claude-code'
import { firingReason } from './call.ts'
import type { Trigger } from './call.ts'
import { addEntry, conciseAction, conciseRequest, conciseResult, EMPTY_CONCISE, lastResponse, settleEntry } from './concise.ts'
import { CONCISE_COMMAND, CONCISE_REQUEST, CONCISE_USAGE, CONCISE_VARIANT, PLUGIN } from './config.ts'
import { openPane, writeConcise } from './pane.tsx'
import { PRICES, usageUsd } from './shared/pricing.ts'
import { record } from './shared/record.ts'

// /summarize: shorter copies of the agent's responses, listed in the pane's section above FILES. A
// run prints no copy, because a command's printed text is recorded for the model and the point is
// to keep the copies out of the context. A newer run on the same response cuts an unfinished one
// before it; a /clear empties the list.

export type ConciseState = {
  isInteractive: boolean
  runs: Map<number, AbortController> // the running calls, by entry id
}

export const newConciseState = (): ConciseState => ({ isInteractive: false, runs: new Map() })

function stopAll(state: ConciseState): void {
  for (const run of state.runs.values()) run.abort()
  state.runs.clear()
}

async function summarize($: EngineInterface, state: ConciseState, trigger: Extract<Trigger, 'summarize' | 'summarize-every'>): Promise<void> {
  const reason = { source: 'messages', variant: CONCISE_VARIANT, trigger } as const
  let id: number | undefined
  const settle = (status: 'ready' | 'failed', text: string, at: number) => writeConcise($, c => (id === undefined ? c : settleEntry(c, id, status, text, at)))
  try {
    const startedAt = await $.clock.now()
    const response = lastResponse(await $.session.messages())
    const { entries } = await writeConcise($, c => addEntry(c, 'working', 'Shortening the last response.', startedAt))
    id = entries[0]!.id
    // A run whose entry just gave way has nowhere to write.
    for (const [other, run] of state.runs) {
      if (!entries.some(e => e.id === other)) run.abort()
    }
    if (response === '') {
      await settle('failed', 'The agent has no response to shorten yet.', startedAt)
      await record($, PLUGIN, 'skip-no-response', firingReason(reason))
      return
    }
    const mine = new AbortController()
    state.runs.set(id, mine)
    let reply
    try {
      reply = await $.model.complete({ ...CONCISE_REQUEST, ...conciseRequest(response) }, { signal: mine.signal })
    } finally {
      if (state.runs.get(id) === mine) state.runs.delete(id)
    }
    const endedAt = await $.clock.now()
    const result = conciseResult(reply, CONCISE_REQUEST.maxTokens)
    await settle(result.status, result.text, endedAt)
    await record($, PLUGIN, result.outcome, firingReason({ ...reason, usage: reply.usage, usd: usageUsd(reply.usage, PRICES[CONCISE_REQUEST.model]), failure: result.failure }), endedAt - startedAt)
  } catch (error) {
    const failure = error instanceof Error ? error.message : 'summarize failed'
    await settle('failed', 'The call failed. Run /summarize again.', 0).catch(() => undefined)
    await record($, PLUGIN, 'api-error', firingReason({ ...reason, failure }))
  }
}

export async function runConcise($: EngineInterface, state: ConciseState, args: string): Promise<{ text?: string }> {
  const action = conciseAction(args)
  if (action === 'usage') return { text: CONCISE_USAGE }
  if (!state.isInteractive) return { text: '/summarize shows its result in the pane, in interactive sessions only' }
  if (action !== 'once') await writeConcise($, c => ({ ...c, isEvery: action === 'every' }))
  if (action === 'off') return { text: 'summarize off: no new summaries; the ones in the pane stay' }
  await openPane($)
  if (action === 'every') return { text: 'summarize every: a summary of each new response, until /summarize off' }
  void summarize($, state, 'summarize')
  return {}
}

// A main turn finished with a response: older summaries are one response older, and `every` makes a new one.
export async function conciseResponse($: EngineInterface, state: ConciseState): Promise<void> {
  if (!state.isInteractive) return
  try {
    const { isEvery } = await writeConcise($, c => ({ ...c, responses: c.responses + 1 }))
    if (isEvery) await summarize($, state, 'summarize-every')
  } catch {
    // the session is ending: its list is about to be emptied
  }
}

export async function startConcise($: EngineInterface, state: ConciseState, isInteractive: boolean): Promise<void> {
  stopAll(state)
  state.isInteractive = isInteractive
  await $.command.register({
    name: CONCISE_COMMAND,
    description: "Show shorter copies of the agent's responses in the session summary pane, outside the context",
    argumentHint: '[on|every|off]',
    immediate: true,
  })
  // A reload dropped the runs that were writing these.
  await writeConcise($, c => ({ ...c, entries: c.entries.filter(e => e.status !== 'working') }))
}

// A /clear empties the list, and `every` stays as the person set it.
export async function endConcise($: EngineInterface, state: ConciseState): Promise<void> {
  stopAll(state)
  try {
    await writeConcise($, c => ({ ...EMPTY_CONCISE, nextId: c.nextId, isEvery: c.isEvery }))
  } catch {
    // the section keeps the old text until the next run
  }
}
