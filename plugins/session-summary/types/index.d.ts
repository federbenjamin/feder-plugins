// What the pane draws, kept in $.state so a hot reload keeps it.
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

// The pane's bottom section: what /summarize last left there.
export type ConciseStatus = 'empty' | 'working' | 'ready' | 'failed'
export type Concise = {
  status: ConciseStatus
  text: string // the shorter copy, or what went wrong
  at: number // when the command last wrote it, ms; 0 while empty
  offset: number // the section's first showing row
}

declare module 'claude-code' {
  interface PluginState {
    'session-summary': { summary: Shaped<Summary>; concise: Shaped<Concise> }
  }
}
