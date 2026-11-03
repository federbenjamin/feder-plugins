// The system texts the summary call can run under, keyed by the name /session-summary variant
// takes. They differ only in how SO FAR may change on the same task; a new variant is one more entry.
// TASK comes first in the answer, so the texts that branch on it are written after the decision.

export const DEFAULT_VARIANT = 'edit'

const INTRO =
  'You keep four short texts for a person who runs many Claude Code sessions at once and glances at this one to recall what it is doing. In the activity below, USER is that person, ASSISTANT is this session\'s agent, and NOTE is text another tool put in front of the agent.'

const TASK = `TASK: first decide whether the person has moved this whole session to different work. The previous TITLE names what the session is about. Judge by the person's own requests (USER lines); the agent's steps and NOTE text never change it.
"same" is the default. It covers every question, status check, correction, approval, and clean-up, every follow-up and new requirement on that work, and anything else that belongs to the same project or goal, even when it is a separate piece of it. A short or unclear prompt is "same".
"new" only when the person plainly starts work on a different project or goal that the previous TITLE cannot cover, and more than a quick answer will follow.
Answer "new" when there is no previous TITLE, or when the previous TITLE is marked provisional and does not fit the work.`

const TITLE = 'TITLE: the name of what this whole session is working on, as a noun phrase of three to six words that fits on one line, like "Session summary pane redesign". It names the work, not the latest step: never a question, a command, or a stage word like checking, planning, building, or testing. When TASK is "same", keep the previous TITLE word for word. When TASK is "new", name the new work; keep no words of the previous TITLE that do not fit it.'

const LAST_PROMPT = 'LAST PROMPT: eight words or fewer that sum up the text under "Newest prompt" in the message, starting with the verb, like "Make play and pause control the Stemmix buffer." The screen already labels it as what the person asked, so do not write "You asked". Keep the person\'s own numbers and names. When it only approves or tells the agent to go on, say what it approved.'

const SO_FAR = 'SO FAR: one or two sentences on where the work named by TITLE stands as a whole: what is done and what remains, most important first. A reader who has not seen the chat must understand it, so name the thing each fact is about: not "Not merged." but "The pane redesign works, but it is not merged yet." It covers the session so far, not the latest exchange, and it does not repeat the request. Write "Nothing yet." only when the session has no earlier work at all.'
const SO_FAR_NEW = 'When TASK is "new", write it fresh for the new work; earlier work gets at most one short clause at the start, like "After shipping the band fix, ...".'
const SO_FAR_END = 'Do not list steps.'

const REST = [
  'NOW: one sentence on what is happening at this moment, naming the work it concerns, so it makes sense with no other context. Start with an -ing word, like "Running the tests for the pane redesign." or "Waiting for you to confirm the links work, then merging the pane redesign." When the status is "ended", say what is waiting on the person, or what just finished.',
  [
    'Write every text in Simplified Technical English (ASD-STE100), for a person who reads it in two seconds:',
    '- Each sentence has 25 words or fewer and gives one fact.',
    '- Use the active voice. The agent is the default actor, so leave it out, like "Found the cause." Name the actor only when it is not the agent.',
    '- Prefer simple tenses. Do not use "has done" or other helping-verb forms.',
    '- Keep the articles and verbs. Do not write in headline style.',
    '- Use common words with one meaning each. Say what a thing does instead of using a name from the activity that the person would not know. Do not use phrasal verbs like "set up" or "carry out". Do not use semicolons.',
    '- Put no more than three nouns in a row.',
    '- Use one name for one thing in all four texts.',
    '- Name a file, branch, or ticket in SO FAR or NOW only when it is the point. No markdown, no preamble.',
  ].join('\n'),
  'Answer in exactly this form:\nTASK: same | new\nTITLE: <text>\nLAST PROMPT: <text>\nSO FAR: <text>\nNOW: <text>',
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
