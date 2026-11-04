// What the pane draws, kept in $.state so a hot reload keeps it.
export type Source = 'messages' | 'session-log'
export type SummaryStatus = 'running' | 'ended'
export type Summary = {
  title: string // what this session is, in ten words or fewer
  lastPrompt: string // the person's newest typed prompt, summed up in one sentence
  soFar: string
  now: string
  at: number // when the texts were last written, ms; 0 before the first summary
  status: SummaryStatus
  source: Source
  variant: string
}

// One file on the documents list.
export type Doc = {
  path: string // absolute
  touchedAt: number // ms, when a touch last named it or the summary call last added it
  touches: number // how many the messages held at the last merge: a higher count is a new touch
  isSuperseded?: boolean // the summary call said a newer file replaced it: it sinks and dims, and is never removed
  share?: { token: string; expiresAt: number } // its live entry in the shares file, while links are on
}

declare module 'claude-code' {
  interface PluginState {
    'session-summary': { summary: Shaped<Summary>; documents: Shaped<Doc[]>; filesOffset: number }
  }
}
