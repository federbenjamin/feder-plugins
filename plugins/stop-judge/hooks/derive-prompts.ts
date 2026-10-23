import { DEFAULT_LINE } from './decisions.ts'

// The two prompts of /stop-judge derive: a reader per batch of typed turns, then one synthesis.

export const READER_PROMPT = `You read a batch of one person's sessions with a coding agent. Each turn shows what the agent had just done, then what the person typed. Your job is to learn how this person wants decisions split between themselves and the agent, how they want the agent to work with them, and the judgement they apply to the work itself.

The agent in these sessions is capable and well trained, so its preceding action is usually what such an agent does by default. Where the person simply approved it, there is little to learn. The signal is where they redirected, overruled, narrowed, widened, or stopped it, or said why.

Look for four kinds of signal:

- \`decide\`: a kind of choice the person wants the agent to make on its own. They delegated it, approved a pick after the fact without changing it, or told the agent to stop asking.
- \`bring\`: a kind of action the person must approve before it happens, so the agent stops and waits. Only these qualify: a product or taste choice that is theirs (how something looks or behaves for its users); an action that reaches other people or cannot be undone; spending beyond the usual; something only the person can supply (a login, a device, a permission the agent was refused). They said so, or took such a choice back. When the person pushed back because the agent overreached (deleted too much, committed the wrong thing, widened scope, ran something unasked), that is not \`bring\`: it is a \`how\` or \`principle\` finding for doing that job right without asking. When the person wants to see or be told about something, that is \`how\` (do it, then report it), not \`bring\`.
- \`how\`: a standing rule for how the agent works with the person: how it reports, asks, explains, or shows its work.
- \`principle\`: a rule of judgement about the work itself, for choosing between two workable options. Write it as "<what wins> over <what loses>, when <condition>". Then test it: with every product, repo, and feature name removed, it must still decide a choice in an unrelated project. Drop it if it does not.

Name the kind of choice, not the one instance. A one-off answer counts only when the person states the reason behind it, or when the same kind of choice comes back across turns. One finding states one rule; do not join two. Leave out anything that is only about the content of one project. An instruction for the task at hand, such as a reply shape or a "then wait" in one opening prompt, is not a standing rule unless the person says it always applies or it comes back across sessions; nor is a rule that only holds in one project's context, such as how to treat the facts in one document.

For each finding, write one JSON line:
{"side":"decide|bring|how|principle","topic":"<kind of choice, 2-6 words>","claim":"<one sentence the agent can follow>","quote":"<the person's exact words>","session":"<session id from the batch>","turn":<turn number>,"strength":"strong|medium|weak"}

The quote is copied character for character from an "operator typed" block of this batch, under 200 characters, never from the agent's text and never paraphrased; a finding without such a quote is not a finding. \`strong\` is a stated rule or a repeated pattern, \`medium\` one clear instance with a reason, \`weak\` an inference. Output only JSON lines.`

export const SYNTH_PROMPT = `You write one person's DECISIONS.md: the file their coding agent reads at the start of every session to know which choices to bring to the person, how to work with them, and the judgement to apply when a choice about the work is the agent's. Your input is the current file (or none yet) and reader findings, one JSON line each, taken from the person's own session transcripts: side (decide, bring, how, principle), topic, claim, a verbatim quote, session, turn, strength, and the session's date.

Write the whole file, in exactly this format and nothing else:

# Decisions (derived <date>, <N> sessions, <window>)

${DEFAULT_LINE}

## Bring to me
- <one-sentence rule> -- "<quote>" (YYYY-MM-DD)
## How to work with me
### <topic heading>
- <one-sentence rule> -- "<quote>" (YYYY-MM-DD)
## Principles
### <topic heading>
- <what wins over what, when> -- "<quote>" "<second quote>" (YYYY-MM-DD)

The first line's counts are replaced by the program; write it as shown. The second line is copied exactly. "Bring to me" holds the kinds of choice the person wants brought to them, one bullet each, no sub-headings. "How to work with me" holds the \`how\` findings: how the agent reports, asks, explains, and shows its work. "Principles" holds the \`principle\` findings: rules for choosing between workable options in the work itself, each written as what wins over what, and when, so it decides a choice in a project the findings never mention. All three section headings are always written, even over an empty section. There is no other section.

Each bullet is one sentence, then \` -- \`, then one or two quotes, then the date in parentheses. A quote is copied from a finding's quote or from a quote already in the current file, never invented, reworded, or joined from two; it is at most 200 characters, and each \`"\` inside it is written as \`'\`. Both quotes of a bullet come from the same session, and the date ending the line is that session's date as the finding gives it (or as the current file gives it, for a quote kept from it).

This file exists so the agent keeps working instead of stopping to ask. "Bring to me" means one thing: what the person must approve before it happens, so the agent stops and waits. It is not what the person wants to see, hear about, or be told; that is done, then logged or shown, and written under "How to work with me" (for example "say in the report when user-facing behaviour changed", never "get approval before changing it"). Very little belongs in "Bring to me": a product or taste choice that is the person's (how something looks or behaves for its users); an action that reaches other people or cannot be undone; spending beyond the usual; something only the person can supply (a login, a device, a permission the agent was refused); and a kind of choice the person said, more than once, they must approve first. At most five bullets, and an empty section is fine. A finding where the person pushed back because the agent overreached once (deleted too much, committed the wrong thing, widened scope, ran something unasked, changed a rule) is a rule for doing that job right, written where the agent acts ("keep user-local rules out of committed repos", "delete only what is in scope"), never an approval gate. A reader's \`bring\` label does not decide the section; the test above does.

A rule drawn from one task's instruction (a reply shape or a "then wait" asked for in one opening prompt) or from one project's context (how to treat the facts in one document) is not a standing rule: leave it out unless findings from another session state it too. Keep a rule that the findings or the current file still support; drop one that newer findings contradict; keep nothing only because it was already there. A \`decide\` finding never becomes a bullet: it only counts against a "Bring to me" bullet the person has since contradicted, which you then weaken or drop. Merge findings that state the same rule, prefer the person's own framing over a reader's claim, drop a \`weak\` finding no other finding supports, and order bullets by the strength of their evidence. A principle that names a product, repo, or feature it does not need is rewritten without it, or dropped. The sections do not compete for room: a strong principle is never dropped to make space for conduct, or the reverse. Keep the file short enough to read at a glance: the strongest rules, not every finding.`
