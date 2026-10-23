// The system texts the summary call can run under, keyed by the name /session-summary variant
// takes. They differ only in how SO FAR may change; a new variant is one more entry.

export const DEFAULT_VARIANT = 'edit'

const INTRO =
  'You keep three short texts for a person who runs many Claude Code sessions at once and glances at this one to recall what it is doing. In the activity below, USER is that person, ASSISTANT is this session\'s agent, and NOTE is text another tool put in front of the agent.'

const SO_FAR = 'SO FAR: one or two sentences on what this session is about and what it has done since it began.'
const SO_FAR_END = 'Do not list steps.'

const REST = [
  'NOW: one sentence on what is happening at this moment. When the status is "ended", say what the agent finished or what it is waiting on from the person.',
  'FILES: from the candidate files only, the one or two the person would open right now (a plan being written, a report or diagram just sent to them). Prefer the newest. "none" when nothing fits.',
  'Plain words a person reads in two seconds. Name a file, branch, or ticket in SO FAR or NOW only when it is the point. No markdown, no preamble.',
  'Answer in exactly this form:\nSO FAR: <text>\nNOW: <text>\nFILES: <path>[, <path>] | none',
]

function systemText(stability: string): string {
  const soFar = [SO_FAR, stability, SO_FAR_END].filter(Boolean).join(' ')
  return [INTRO, soFar, ...REST].join('\n\n')
}

export const VARIANTS: Readonly<Record<string, string>> = Object.freeze({
  edit: systemText('Start from the previous SO FAR. Change only what the recent activity makes untrue or incomplete, and keep its wording wherever it still holds.'),
  rewrite: systemText(''),
  append: systemText('Start from the previous SO FAR. You may only replace its last sentence or add one; add two at most.'),
})

export function isVariant(name: string): boolean {
  return Object.hasOwn(VARIANTS, name)
}
