# Stop-judge experiments

What was tried to make the judge choose better, and what each attempt showed, so a later experiment does not repeat it. All of it ran on 2026-11-03 and 2026-11-04, about 2,400 haiku calls, through the production model path.

A **nudge** is the judge telling the agent to keep working. The cases come from one person's own transcripts, so the cases, labels and raw outputs stay out of this repo.

The problem: the judge nudged too often, and on the wrong turns. Of 136 live nudges over two weeks, a hand review rated 65 wrong, 51 right and 20 unclear. That review was later found too strict: it disagreed with the operator on 3 of 9 cases they ruled on.

## Attempts

Numbers are nudges out of tries. "Stop" means turns that should stop (want fewer). "Continue" means turns that should continue (want more). Labels changed between stages, so compare only inside a row.

| # | Attempt | Cases | Before | After | Outcome |
|---|---|---|---|---|---|
| 1 | Remove the prompt's "reversible step the agent can take" clause | 47 | stop 19/38, continue 42/56 | stop 18/38, continue 39/56 | No effect |
| 2 | Prompt says which steps on a next-step line count | 47 | stop 19/38, continue 42/56 | stop 12/38, continue 24/56 | Fires less, chooses no better: 69% of nudges right before, 67% after. Dropped |
| 3 | Prompt states the operator's own standard, from 10 cases they ruled on | 27 | stop 15/30, continue 5/24 | stop 19/30, continue 4/24 | Worse on both. Dropped |
| 4 | Richer input: both sides of the last 8 exchanges, the turn's tool calls, a document it may ask to read | 32 | stop 26/42, continue 21/54 | stop 24/42, continue 19/54 | Inside the noise, 27% more input. It asked for a document in 0 of 288 tries |
| 5 | The standard on top of the richer input | 32 | stop 12/28, continue 14/36 | stop 12/28, continue 15/36 | No gain |
| 6 | Fixed questions: Haiku reports, plain code decides | 32 | stop 24/42, continue 22/54 | stop 14/42, continue 17/54 | Largest drop on stop, but continue fell too. This shape was kept |
| 7 | Grade each answer against a key, then rewrite and tune the questions | 32 | stop 24/42, continue 22/54 | stop 20/42, continue 34/54 | Continue rose, and the nudges now fall on the right side. No better on 36 new cases |
| 8 | Apply five operator rulings to the rules and labels | 32 | stop 24/45, continue 22/48 | stop 17/45, continue 40/48 | Best verdicts so far. Rulings: stop 6/6 to 1/6, continue 14/18 to 18/18. Frozen as the prompt |
| 9 | Prompt treats "asked for a proposal or thoughts" as a hold | 32 | stop 17/45, continue 40/48 | stop 11/45, continue 34/48 | Lost continue, and Haiku rarely used it. Dropped |
| 10 | Prompt gives "tell me what you see on your phone" as operator-only | 32 | stop 17/45, continue 40/48 | stop 10/45, continue 35/48 | Lost continue, fresh turns 4/50 to 6/50. Dropped |
| 11 | Code holds the step when the message that opened the turn asks for a proposal or thoughts | 32 | stop 17/45, continue 40/48 | stop 11/45, continue 40/48 | Kept. Scored on saved answers, and rests on 2 cases |

Accuracy of the answers in attempt 7, against a key written without seeing them: agent can do it 74% to 97%, effort 62% to 80%, still deciding 70% to 81%, design open 70% to 84%.

## The held-out test

The best version (attempts 8 and 11) against today's judge, on 47 turns no earlier round used, with labels written before the run. Each judge had 2 tries per turn.

| Label | Cases | Today's judge | New judge |
|---|---|---|---|
| Should stop | 38 | 2/76 (3%) | 2/76 (3%) |
| Should continue | 6 | 8/12 (67%) | 4/12 (33%) |
| Unsure | 3 | 0/6 | 2/6 |

Should stop is a tie. Should continue rests on 6 cases, so it is a warning and not a measurement. One of those labels looks wrong on a full read; without it the row is 7/10 against 4/10.

Read whole, the should-continue misses are:

- A pending job unrelated to the work, reported as blocking it.
- Open decisions read as blocking a step that did not depend on them.
- A high-effort step, which stops by design.

The code rule's one match here held a step where the agent had stated a small, low-risk approach. Whether that hold is right is unsettled: the proposal hold and the "low risk may start" ruling pull apart.

## What carries forward

- **Wording alone does not separate the cases.** Messages the operator objected to and messages they pushed past read the same; what differs is what they were thinking. Three wording edits moved both sides together.
- **An edit that lowers both sides is a failure,** not a trade to tune further.
- **Let code answer what code can see:** background jobs, refused tool calls, and whether a quoted hold is the operator's own words. In one round, 4 of 13 hold quotes were the agent's own words, and the check threw them out.
- **The tuning set overstates the problem.** It was built from turns the operator objected to, so today's judge scored 53% there and 3% on ordinary turns. Use both kinds.
- **Replay is not live.** Of 12 turns that nudged live, today's judge nudged 8 of 24 tries in replay. The cause is unknown, because the log does not keep what the live judge received.
- **Noise is large.** The same request sent in two batches moved 4 of 32 cases by half or more of their tries. Compare arms inside one batch and ignore small shifts.
- **Keep the code rule on the one message.** Matching any earlier operator message hits 28 of 93 cases.
- **Examples in the prompt must be invented and general.** Copying a scored case into the prompt spends that case.
- **Cost:** on the held-out turns, median input 4,544 to 4,597 tokens and output 93 to 173.

## For the next experiment

- Label first, from the operator's next words, then run. Their silence proves nothing: they may not have seen it.
- Draw new turns. The held-out set has been read and is spent.
- Add more should-continue cases: the held-out set had 6 of 47. A bare "go" does not find them, because 6 of the 7 read here followed a right stop.
- Next to measure: a pending job should block a step only when the step needs that job.
