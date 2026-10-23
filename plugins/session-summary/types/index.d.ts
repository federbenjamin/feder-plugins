// What the pane draws, kept in $.state so a hot reload keeps it.
export type Source = 'messages' | 'session-log'
export type SummaryStatus = 'running' | 'ended'
export type Summary = {
  soFar: string
  now: string
  files: string[]
  at: number // when the texts were last written, ms; 0 before the first summary
  status: SummaryStatus
  source: Source
  variant: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-summary': { summary: Shaped<Summary> }
  }
}
