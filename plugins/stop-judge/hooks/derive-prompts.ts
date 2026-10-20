import { DEFAULT_LINE } from './decisions.ts'

// The two prompts of /stop-judge derive: a reader per batch of typed turns, then one synthesis.

export const READER_PROMPT = `You read a batch of one person's sessions with a coding agent. Each turn shows what the agent had just done, then what the person typed. Your job is to learn how this person wants decisions split between themselves and the agent, and what they want the agent to pick when the choice is the agent's.

Look for three kinds of signal:

- \`decide\`: a kind of choice the person wants the agent to make on its own. They delegated it, approved a pick after the fact without changing it, or told the agent to stop asking.
- \`bring\`: a kind of choice the person wants brought to them before the agent acts. They took the choice themselves, rejected one the agent made alone, or said they wanted to be asked.
- \`how\`: a standing rule for what to pick when the agent chooses: a preference between options, a quality bar, a default, a tool or model they want used or avoided.

Name the kind of choice (naming, scope of a fix, when to push, which tool, product behaviour, wording of their own text), not the one instance. A one-off answer counts only when the person states the principle behind it, or when the same kind of choice comes back across turns. Leave out anything that is only about the content of one project rather than how they want the agent to work with them.

For each finding, write one JSON line:
{"side":"decide|bring|how","topic":"<kind of choice, 2-6 words>","claim":"<one sentence the agent can follow>","quote":"<the person's exact words>","session":"<session id from the batch>","turn":<turn number>,"strength":"strong|medium|weak"}

The quote is copied character for character from an "operator typed" block of this batch, under 200 characters, never from the agent's text and never paraphrased; a finding without such a quote is not a finding. \`strong\` is a stated rule or a repeated pattern, \`medium\` one clear instance with a reason, \`weak\` an inference. Output only JSON lines.`

export const SYNTH_PROMPT = `You write one person's DECISIONS.md: the file their coding agent reads at the start of every session to know which choices to bring to the person and how to make the rest. Your input is the current file (or none yet) and reader findings, one JSON line each, taken from the person's own session transcripts: side (decide, bring, how), topic, claim, a verbatim quote, session, turn, strength, and the session's date.

Write the whole file, in exactly this format and nothing else:

# Decisions (derived <date>, <N> sessions, <window>)

${DEFAULT_LINE}

## Bring to me
- <one-sentence rule> -- "<quote>" (YYYY-MM-DD)
## How to decide
### <topic heading>
- <one-sentence rule> -- "<quote>" "<second quote>" (YYYY-MM-DD)

The first line's counts are replaced by the program; write it as shown. The second line is copied exactly. "Bring to me" holds the kinds of choice the person wants brought to them, one bullet each, no sub-headings. "How to decide" holds the rules for what wins when a choice is the agent's, grouped under short \`###\` topic headings. There is no other section.

Each bullet is one sentence, then \` -- \`, then one or two quotes, then the date in parentheses. A quote is copied from a finding's quote or from a quote already in the current file, never invented, reworded, or joined from two; it is at most 200 characters, and each \`"\` inside it is written as \`'\`. Both quotes of a bullet come from the same session, and the date ending the line is that session's date as the finding gives it (or as the current file gives it, for a quote kept from it).

Keep a rule that the findings or the current file still support; drop one that newer findings contradict; keep nothing only because it was already there. A \`decide\` finding never becomes a bullet: it only counts against a "Bring to me" bullet the person has since contradicted, which you then weaken or drop. Merge findings that state the same rule, prefer the person's own framing over a reader's claim, drop a \`weak\` finding no other finding supports, and order bullets by the strength of their evidence. Keep the file short enough to read at a glance: the strongest rules, not every finding.`
