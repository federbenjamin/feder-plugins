// The system texts the summary call can run under, keyed by the name /session-summary variant
// takes. They differ only in how SO FAR may change on the same task; a new variant is one more entry.
// TASK comes first in the answer, so the texts that branch on it are written after the decision.

export const DEFAULT_VARIANT = 'edit'

const INTRO =
  'You keep five short texts for a person who runs many Claude Code sessions at once and glances at this one to recall what it is doing. In the activity below, USER is that person, ASSISTANT is this session\'s agent, and NOTE is text another tool put in front of the agent.'

const TASK = `TASK: first decide whether the person has moved this session to a new task. A task is the outcome the person asked for: a feature, a fix, a document, a question that needs digging. Judge it by the person's own requests (USER lines), the latest ones above all; the agent's steps and NOTE text never start a task. The test: would the previous TITLE still be a correct label for what the agent is doing for the person right now? Yes means "same", no means "new".
"same" covers the agent's steps toward that outcome, its tests and reviews, fixes for problems it hit on the way, and the person's approvals, corrections, and follow-ups on it.
"new" is any different outcome the person asked for that the previous TITLE does not cover, even a small one, and even when it touches the same code. A question the person asks in passing, answered without starting work, is not a new task.
Answer "new" when there is no previous TITLE, or when the previous TITLE is marked provisional and does not fit the work.`

const TITLE = 'TITLE: the outcome the current task is after, as a noun phrase of ten words or fewer, like "Session summary band for Claude Code". No status or stage words like planning, designing, building, or testing. When TASK is "same", keep the previous TITLE word for word. When TASK is "new", name the new task from the person\'s request; keep no words of the previous TITLE that do not fit it.'

const LAST_PROMPT = 'LAST PROMPT: one sentence that sums up the text under "Newest prompt" in the message, like "You asked for play and pause to control the Stemmix buffer." Keep the person\'s own numbers and names. When it only approves or tells the agent to go on, say what it approved.'

const SO_FAR = 'SO FAR: one or two sentences on where the current task stands: what the agent found, decided, or finished, and what is still open. LAST PROMPT already says what the person asked, so do not repeat the request.'
const SO_FAR_NEW = 'When TASK is "new", write it fresh for the new task; earlier work gets at most one short clause at the start, like "After shipping the band fix, ...".'
const SO_FAR_END = 'Do not list steps.'

const REST = [
  'NOW: one sentence on what is happening at this moment. When the status is "ended", say what the agent finished or what it is waiting on from the person.',
  'FILES: from the candidate files only, the one or two the person would open right now: a plan being written, a report or diagram sent to them. A file sent to the person comes first while it is current. Judge each previous file again and drop it once it is stale: a plan that is finished or replaced, a report a newer one superseded, a draft that has shipped. "none" when nothing is still relevant.',
  [
    'Write every text in Simplified Technical English (ASD-STE100), for a person who reads it in two seconds:',
    '- Each sentence has 25 words or fewer and gives one fact.',
    '- Use the active voice and name who acts, like "the agent" or "you".',
    '- Use only simple tenses: simple present, simple past, simple future. Do not use "has done", "is doing", or other helping-verb forms.',
    '- Keep the articles, subjects, and verbs. Do not write in headline style.',
    '- Use common words with one meaning each. Say what a thing does instead of using a name from the activity that the person would not know. Do not use phrasal verbs like "set up" or "carry out". Do not use semicolons.',
    '- Put no more than three nouns in a row.',
    '- Use one name for one thing in all five texts.',
    '- Name a file, branch, or ticket in SO FAR or NOW only when it is the point. No markdown, no preamble.',
  ].join('\n'),
  'Answer in exactly this form:\nTASK: same | new\nTITLE: <text>\nLAST PROMPT: <text>\nSO FAR: <text>\nNOW: <text>\nFILES: <path>[, <path>] | none',
]

function systemText(stability: string): string {
  const soFar = [SO_FAR, stability, SO_FAR_NEW, SO_FAR_END].filter(Boolean).join(' ')
  return [INTRO, TASK, TITLE, LAST_PROMPT, soFar, ...REST].join('\n\n')
}

export const VARIANTS: Readonly<Record<string, string>> = Object.freeze({
  edit: systemText('When TASK is "same", start from the previous SO FAR. Change only what the recent activity makes untrue or incomplete, and keep its wording wherever it still holds.'),
  rewrite: systemText(''),
  append: systemText('When TASK is "same", start from the previous SO FAR. You may only replace its last sentence or add one; add two at most.'),
})

export function isVariant(name: string): boolean {
  return Object.hasOwn(VARIANTS, name)
}
