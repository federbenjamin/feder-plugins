// What the band draws, kept in $.state so a hot reload keeps it.
export type Source = 'messages' | 'session-log'
export type SummaryStatus = 'running' | 'ended'
export type Summary = {
  title: string // what this session is, in ten words or fewer
  lastPrompt: string // the person's newest typed prompt, summed up in one sentence
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
