import type { EngineInterface } from 'claude-code'
import { SETTINGS_KEY, settingsFrom, statusLine } from './settings.ts'

// The status line, written by the command and by a derive run: the stored settings and the run
// in flight, so neither hides the other.

// `progress`: the run's part of the status line while it runs.
export type DeriveRun = { controller: AbortController; done: number; total: number; progress: string | undefined }

export type StatusState = {
  derive: DeriveRun | undefined
  statusCalls: number // showStatus calls begun; only the newest writes the line
}

// The line from the settings stored now, so a judge-off marker set mid-run and the run's progress
// never hide each other, and a run's end restores the marker. Of two calls in flight, the one
// begun later read the store later: an earlier one finishing last would put an older setting
// back, so it writes nothing.
export async function showStatus($: EngineInterface, state: StatusState): Promise<void> {
  const call = ++state.statusCalls
  const settings = settingsFrom(await $.store.get(SETTINGS_KEY))
  if (call === state.statusCalls) $.ui.status(statusLine(settings, state.derive?.progress))
}

export async function setProgress($: EngineInterface, state: StatusState, run: DeriveRun, progress: string): Promise<void> {
  run.progress = progress
  if (state.derive === run) await showStatus($, state)
}
