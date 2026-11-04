# stop-judge

<p align="center"><strong>Nudges a Claude Code agent that stopped early to ask something it could have decided itself</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/federbenjamin/feder-plugins" alt="License"></a>
</p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin for people who want the agent to keep working. When a turn ends, a small model (haiku) reads the recent conversation and the agent's final message and answers fixed questions about the next step the message leaves open: what blocks it, whether you held or forbade it, how big it is, how hard to undo. Plain code decides from those answers. When nothing holds the step (the agent ended on "want me to run the tests?", or on a step it could have taken), the plugin sends the agent a short reminder as if you had typed it, and the agent carries on.

## Install

Needs Claude Code. This is one part of the [feder-plugins](../../README.md) marketplace: install `stopstopping`, which installs this plugin under its own name as a dependency, or this plugin alone; installing both changes nothing.

```
claude plugin install stop-judge --marketplace federbenjamin/feder-plugins
```

It starts in the next session.

## How it works

- **Nothing blocks.** The judge runs after the turn has ended; the reminder lands a few seconds later.
- **The reminder is a user-style prompt.** It reads `STOP JUDGE — nothing holds it: <the step>.` and the agent answers it like any message from you. It carries no rule text and does not tell the agent what to do.
- **Once per prompt.** After one reminder the judge stays quiet until you type again. A reminder is never sent while there is text in your prompt box: you are answering. Nor is one sent once a newer turn has started, since it would queue behind that turn and land on work it was never about.
- **Headless runs too.** A `claude -p` agent in a repo or worktree is judged; an unattended run is where a caught early stop pays most. A `claude -p` run started in a temporary folder is a script's and passes without a model call (`pass-scripted`).
- **Passes without a model call** for subagent turns, interrupted turns, a keepalive ping turn, a scripted run, and a turn with no final text.

## How it decides

Haiku reports; it never decides. The fixed instructions in `hooks/prompt.ts` ask it to find the step and answer about it, and `hooks/decide.ts` reads the answers in this order. The first that holds is a stop:

| Reason logged | When |
| --- | --- |
| `no step left open` | The final message only reports or answers |
| `blocked: <what>` | A background job, a refused call, or something only you can do |
| `operator holds it` | A quote of yours says you are deciding |
| `operator asked for a proposal` | The message that opened the turn asks for a proposal or for thoughts |
| `operator forbade it` | A quote of yours forbids this kind of action |
| `instructions conflict` | A plan or message says two different things about the step |
| `operator choice open` | The step depends on a pick you have not made |
| `new work` | Nothing in the request or the work gives a reason for it |
| `design open` | It changes behaviour someone relies on, above low effort, with no stated risk and cost |
| `high effort` | Hours of work or more |
| `hard to undo` | It cannot be taken back, or it reaches someone else |

With none of them, the reason is `nothing holds it`, and the reminder goes.

A quote counts only when its words are in what you typed, ignoring case and punctuation, so an agent's own "say go" holds nothing. The proposal check is plain code on the opening message alone, with any `<pasted_content>` block removed; your next message clears it. It would also hold "go ahead with the proposal".

**What it reads and sends.** From the transcript's last 8 MB, to haiku through Claude Code's own model connection, at each judged turn: both sides of the last eight exchanges (400 characters a side), up to four older messages of yours (your first, and the latest three that ask to be consulted, 600 characters each), the message that opened the turn (3,000), facts code reads from the rows (background jobs not yet reported, tool calls refused this turn), the turn's tool calls by name and arguments (the last 30, with a failed call's error), up to two things the agent said along the way, the first 3,000 characters of a plan-like Markdown file under your home folder that the turn names, and the final message (the last 4,000). The judge reads no other file of yours.

**Measured.** Replayed over saved turns, two or three tries each, against the judge this one replaced, with each nudge counted (a nudge is the judge telling the agent to keep working):

| Nudged | Old judge | This judge | Wanted |
| --- | --- | --- | --- |
| 32 tuning cases: should stop | 24/45 (53%) | 11/45 (24%) | Fewer |
| 32 tuning cases: should continue | 22/48 (46%) | 40/48 (83%) | More |
| 25 fresh random turns | 2/50 | 4/50 | Fewer |

The tuning cases shaped the questions, and the proposal check rests on 2 of them. Its 4 nudges on the fresh sample are 2 tries on each of 2 cases.

On 47 held-out turns no earlier round used, with labels written first, it is no better than the old judge: should stop ties at 2/76, and should continue is 4/12 against the old judge's 8/12. That last row rests on 6 turns, so it is a warning rather than a measurement. [`EXPERIMENTS.md`](EXPERIMENTS.md) has the detail. These are replays: they have not yet been compared with live firings, which is what the capture is for.

**Cost.** About 2,500 tokens of fixed instructions are marked for the prompt cache, so a call within five minutes of another pays them at the cache-read price; a typical call also sends about 2,500 tokens of its own, and spends about 180 output tokens. `maxTokens` is 1024. On a model that cannot turn thinking off, the engine adds 2,048 tokens of room for thinking on top of that cap, and thinking counts in `output_tokens`, so a call can report more than its cap: replies with about 180 tokens of text reached 955 in testing.

## Usage

| Command | Effect |
| --- | --- |
| `/stop-judge` | On or off, context on or off, outcome counts of the last 7 days, `DECISIONS.md` line count and date |
| `/stop-judge off` / `on` | Stop or resume judging, in every session |
| `/stop-judge context off` / `on` | Keep or leave out `DECISIONS.md` at session start |
| `/stop-judge derive [all]` | Derive `DECISIONS.md` from your sessions |
| anything else | Print the usage line |

The command is registered in every session, `claude -p` included, so a script can run `claude -p "/stop-judge off"`. `derive` alone needs an interactive session (it asks before it spends).

`STOP_JUDGE_NESTED=1` in the environment opts a process out: it logs `pass-nested` and makes no model call.

## Log

Every turn the judge sees appends one line to `~/.claude/stopstopping/logs/stop-judge.log` (`STOPSTOPPING_DIR` replaces the folder):

```
<utc> <outcome> session=<id> ms=<n> reason=<text>
```

On a judged turn the reason is `<decision's reason>; step: <the step>; why: <haiku's words>`.

| Outcome | Meaning |
| --- | --- |
| `continue` | Nothing held the step; the reminder was sent |
| `stop` | A stop reason held; the line's reason names it |
| `pass-off` | `/stop-judge off` |
| `pass-subagent` | A subagent's turn |
| `pass-aborted` | The turn was interrupted or failed rather than answered |
| `pass-nested` | `STOP_JUDGE_NESTED` was set |
| `pass-scripted` | A `claude -p` run started in a temporary folder |
| `pass-nudged` | A reminder was already sent for your last prompt |
| `pass-keepalive` | The turn answered a keepalive ping |
| `pass-notext` | No final message, or the session's transcript was not found |
| `pass-typing` | Nothing held the step, and there was text in your prompt box |
| `pass-late` | Nothing held the step, and a newer turn had started; the reminder was dropped |
| `pass-timeout` | The model call was cut or ran past 20 seconds |
| `pass-error` | The call failed, or its reply held no answers |

Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/stop-judge.log | sort | uniq -c
```

How often each stop reason fired:

```
awk '$2 == "stop"' ~/.claude/stopstopping/logs/stop-judge.log | sed -E 's/.* reason=([^;]*);.*/\1/' | sort | uniq -c
```

## Capture

Every turn that reached the model appends one JSON line to `~/.claude/stopstopping/stop-judge-captures/<session id>.jsonl`: `at`, `turnId`, the exact `input` sent and `inputChars`, the `plan` it attached, the raw `reply`, the parsed `answers`, the `quotes` (`gate` and `ban`, each the `quote` and whether `isOperators`), the `decision` (`decision` and `why`), the `outcome` and `reason` of the firing line, `ms`, the token `usage` and `usd`. The fixed instructions are not repeated: they are `hooks/prompt.ts` at the installed version. `outcome` differs from `decision` when a gate stopped a nudge (`pass-late`, `pass-typing`). A line holds your words and the agent's, stays on your machine, and is never pruned: delete the folder whenever you like.

Read it back:

```
jq -c '{at, outcome, why: .decision.why, step: .answers.step, usage}' ~/.claude/stopstopping/stop-judge-captures/<session id>.jsonl
cat ~/.claude/stopstopping/stop-judge-captures/*.jsonl | jq -s 'map(.usage) | {calls: length, input: (map(.input_tokens) | add), cached: (map(.cache_read_input_tokens) | add), written: (map(.cache_creation_input_tokens) | add), output: (map(.output_tokens) | add)}'
```

## Settings

The judge's on/off lives in the engine's store under this plugin's name, so it carries whether the plugin is installed alone or through the `stopstopping` bundle. Context on/off is the `context-off` file alone: the session-start hook obeys it, and `/stop-judge` reports what the file says.

## Derive

`/stop-judge derive` writes `~/.claude/stopstopping/DECISIONS.md` from your own sessions: the few actions you must approve before they happen, how you want the agent to work with you, and the principles you apply when choosing between two workable options. The agent reads it at the start of every session; the judge never does.

- **What it reads.** Your top-level Claude Code transcripts under `~/.claude/projects/` (subagent transcripts and scripted runs in temporary folders are skipped), and only the messages you typed, each with what the agent had just done. Nothing leaves your machine except the model calls themselves.
- **Estimate first.** It counts your typed turns, then asks `<n> sessions, <t> of <total> typed turns, ~$X.XX. Run?`. Cancel spends nothing. The first estimate uses a measured $0.0013 per turn plus an allowance for the final call; after a run, that run's measured cost per turn replaces it.
- **The newest 2,000 typed turns** by default (about 20 reader batches, about $3); `/stop-judge derive all` reads every session.
- **In the background.** After Run, readers (Sonnet, four at a time, 120 turns per batch) look for where you delegated, redirected or overruled the agent, or stated a rule or the reason behind a choice; a finding survives only if its quote is your exact words in that batch. One more call writes the file from those findings and the current file. The status line counts the batches beside the `stop-judge off` marker when the judge is off; a toast says how the run ended, and the status line goes back to the marker alone. Ending the session stops the run, and the next one starts over.
- **Refresh overwrites.** The old file is kept as `DECISIONS.md.prev`, and is an input to the new one: a rule whose transcripts have aged out survives until newer sessions contradict it. A file that fails the format check, or keeps no bullet, is not written, and the old one stays.

The file:

```
# Decisions (derived 2026-10-20, 117 sessions, 2000 turns, 2026-09-20 to 2026-10-20)

Decide everything you can yourself. Bring only what is listed under "Bring to me" to the operator.

## Bring to me
- Visual design choices are mine: show options and let me pick. -- "i am the designer" (2026-10-12)
## How to work with me
### Reporting
- Keep reports short, in plain language. -- "I cant parse that" (2026-10-14)
## Principles
### Fixes
- The root cause wins over a workaround, with the smallest change that fixes it. -- "smallest fix, root cause" (2026-10-15)
```

"Bring to me" is only what must wait for your approval: your product or taste choices, an action that reaches other people or cannot be undone, unusual spending, and what only you can supply (a login, a device, a refused permission). It holds at most five bullets and may be empty. What you want to see or be told goes under "How to work with me" as something to report after doing it. Where you pushed back on an agent overreaching, the file holds a rule for doing that job right, not a gate. A principle is written as what wins over what, and when, with project names removed, so it decides choices in projects the file never mentions.

In the file, every bullet ends in one or two of your quotes (at most 200 characters, `"` written as `'`) and the date of the session they came from. A bullet whose quote matches no finding and no quote of the current file is dropped. The quotes are evidence for you and for the next derive; the agent never sees them. What the session-start hook prints is kept under 9,000 characters by dropping bullets from the end of whichever of "How to work with me" and "Principles" holds more, because a hook's output over 10,000 characters reaches the model only as a short preview.

**Session start.** A `SessionStart` command hook in `hooks/hooks.json` prints the file without the quotes and dates, so the agent gets the rules and not the words or mood they were typed in. `/stop-judge context off` writes `~/.claude/stopstopping/context-off`, which the hook checks, and `context on` removes it.

**Editing it by hand** is fine; the next derive reads your edits as the current file. An agent editing a file under `~/.claude/stopstopping/` may need an allow rule for that folder in your permission settings.

**Log lines** in `stop-judge.log`, the outcome as the line's second field and the rest as the reason (`<utc> context session=<id> ms=0 reason=chars=<n>`):

| Outcome | Reason |
| --- | --- |
| `context` | `chars=<n>`: the file was printed at session start |
| `derive` | `sessions=<n> turns=<t> batches=<b> cost=$<usd> failed-batches=<k> dropped-lines=<l> dropped-bullets=<m>` |
| `derive-cancelled` | `sessions=<n> turns=<t>` |
| `derive-error` | `<why>`: nothing was written |

## Code

`$` is called only in the hooks files; the decisions are pure modules with their tests in `tests/`.

| File | Job |
| --- | --- |
| `hooks/register.ts` | the hooks: the judge on `turn.complete`, the `/stop-judge` command, the context log at session start |
| `hooks/derive-run.ts` | `/stop-judge derive`: the scan, the confirm, and the detached reader and synthesis loop (`startDerive`) |
| `hooks/status.ts` | the status line, written by the command and by a derive run |
| `hooks/config.ts` | the judge's constants: the request, the input's limits, the patterns |
| `hooks/prompt.ts` | the fixed instructions |
| `hooks/input.ts`, `hooks/plan-io.ts` | the user message built from the transcript tail; reading the plan it names |
| `hooks/decide.ts` | the answers in a reply, the quote check, the decision order |
| `hooks/judge.ts` | the rows that end a turn, the request, the gates, the capture's shape |
| `hooks/settings.ts` | the stored setting, the command grammar, the status texts |
| `hooks/derive.ts`, `hooks/derive-prompts.ts`, `hooks/decisions.ts` | the derive pipeline, its prompts, and the `DECISIONS.md` format |
| `hooks/shared/` | generated copies of the repo's `shared/` (the row filter, the firing log and its one append, the event predicates and the main-turn tracker, the settings reader and command grammar, `pool`) |

## Experiments

[`EXPERIMENTS.md`](EXPERIMENTS.md) records every attempt to tune the judge and what each one showed. Read it before changing the prompt or the input.
