# stop-judge

<p align="center"><strong>Nudges a Claude Code agent that stopped early to ask something it could have decided itself</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/federbenjamin/stopstopping" alt="License"></a>
</p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin for people who want the agent to keep working. When a turn ends, a small model (haiku) reads the messages that framed the turn and the agent's final message, and decides whether the agent was right to hand control back. When it was not (it ended on "want me to run the tests?", or on a step it could have taken), the plugin sends the agent a short reminder as if you had typed it, and the agent carries on.

## Install

Needs Claude Code. This is one part of the [stopstopping](../../README.md) marketplace: install `stopstopping`, which installs this plugin under its own name as a dependency, or this plugin alone; installing both changes nothing.

```
claude plugin install stop-judge --marketplace federbenjamin/stopstopping
```

It starts in the next session.

## How it works

- **Nothing blocks.** The judge runs after the turn has ended; the reminder lands a few seconds later.
- **The reminder is a user-style prompt.** It reads `STOP JUDGE — <reason>.` and the agent answers it like any message from you. It carries no rule text and does not tell the agent what to do.
- **Once per prompt.** After one reminder the judge stays quiet until you type again. A reminder is never sent while there is text in your prompt box: you are answering.
- **Headless runs too.** `claude -p` sessions are judged as well; an unattended run is where a caught early stop pays most.
- **Passes without a model call** for subagent turns, interrupted turns, a keepalive ping turn, and a turn with no final text.
- **No per-user text.** The judge reads one fixed prompt and nothing from your files. Measured over 190 graded firings (22 that should have continued, 168 that were right to stop), that fixed prompt blocked 8 of 168 right stops and caught 7 of 22 early ones; adding per-user rules scored no better (12 of 168, 6 of 22). A "continue" counts only at confidence 0.7 or above.
- **Minutes since you last wrote.** The request also states the whole minutes since your last typed message (when the transcript tail the judge reads holds none, "more than" the minutes since the tail's oldest row), and the prompt says how to read the gap (short: an active discussion, lean stop; long: unattended work, lean continue). `MINUTES_FACT` in `hooks/judge.ts` is the one switch; with it off the request is the measured text alone. Shipped value: on, pending the eval run that compares it against the numbers above.

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

| Outcome | Meaning |
| --- | --- |
| `continue` | The judge was sure the stop was early; the reminder was sent |
| `stop` | The stop was right |
| `stop-lowconf` | The judge said "continue" below 0.7 confidence (or without one); nothing sent |
| `pass-off` | `/stop-judge off` |
| `pass-subagent` | A subagent's turn |
| `pass-aborted` | The turn was interrupted or failed rather than answered |
| `pass-nested` | `STOP_JUDGE_NESTED` was set |
| `pass-nudged` | A reminder was already sent for your last prompt |
| `pass-keepalive` | The turn answered a keepalive ping |
| `pass-notext` | No final message, or the session's transcript was not found |
| `pass-typing` | There was text in your prompt box |
| `pass-timeout` | The model call was cut or ran past 20 seconds |
| `pass-error` | The call failed or its reply held no verdict |

Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/stop-judge.log | sort | uniq -c
```

## Settings

The judge's on/off lives in the engine's store under this plugin's name, so it carries whether the plugin is installed alone or through the `stopstopping` bundle. Context on/off is the `context-off` file alone: the session-start hook obeys it, and `/stop-judge` reports what the file says.

## Derive

`/stop-judge derive` writes `~/.claude/stopstopping/DECISIONS.md` from your own sessions: which kinds of choice you want brought to you, and how you want the rest decided. The agent reads it at the start of every session; the judge never does.

- **What it reads.** Your top-level Claude Code transcripts under `~/.claude/projects/` (subagent transcripts and scripted runs in temporary folders are skipped), and only the messages you typed, each with what the agent had just done. Nothing leaves your machine except the model calls themselves.
- **Estimate first.** It counts your typed turns, then asks `<n> sessions, <t> of <total> typed turns, ~$X.XX. Run?`. Cancel spends nothing. The first estimate uses a measured $0.0013 per turn plus an allowance for the final call; after a run, that run's measured cost per turn replaces it.
- **The newest 2,000 typed turns** by default (about 20 reader batches, about $3); `/stop-judge derive all` reads every session.
- **In the background.** After Run, readers (Sonnet, four at a time, 120 turns per batch) look for where you delegated, took a choice back, or stated a standing rule; a finding survives only if its quote is your exact words in that batch. One more call writes the file from those findings and the current file. The status line counts the batches beside the `stop-judge off` marker when the judge is off; a toast says how the run ended, and the status line goes back to the marker alone. Ending the session stops the run, and the next one starts over.
- **Refresh overwrites.** The old file is kept as `DECISIONS.md.prev`, and is an input to the new one: a rule whose transcripts have aged out survives until newer sessions contradict it. A file that fails the format check, or keeps no bullet, is not written, and the old one stays.

The file:

```
# Decisions (derived 2026-10-20, 117 sessions, 2000 turns, 2026-09-20 to 2026-10-20)

Decide everything you can yourself. Bring only what is listed under "Bring to me" to the operator.

## Bring to me
- Ask before renaming anything public. -- "ask me before you rename anything public" (2026-10-12)
## How to decide
### Scope
- Fix the cause, with the smallest change that does it. -- "smallest fix, root cause" (2026-10-15)
```

Every bullet ends in one or two of your quotes (at most 200 characters, `"` written as `'`) and the date of the session they came from. A bullet whose quote matches no finding and no quote of the current file is dropped. The file is kept under 9,000 characters, dropping "How to decide" bullets from the end: a hook's output over 10,000 characters reaches the model only as a short preview.

**Session start.** A `SessionStart` command hook in `hooks/hooks.json` prints the file when it exists. `/stop-judge context off` writes `~/.claude/stopstopping/context-off`, which the hook checks, and `context on` removes it.

**Editing it by hand** is fine; the next derive reads your edits as the current file. An agent editing a file under `~/.claude/stopstopping/` may need an allow rule for that folder in your permission settings.

**Log lines** in `stop-judge.log`, the outcome as the line's second field and the rest as the reason (`<utc> context session=<id> ms=0 reason=chars=<n>`):

| Outcome | Reason |
| --- | --- |
| `context` | `chars=<n>`: the file was printed at session start |
| `derive` | `sessions=<n> turns=<t> batches=<b> cost=$<usd> failed-batches=<k> dropped-lines=<l> dropped-bullets=<m>` |
| `derive-cancelled` | `sessions=<n> turns=<t>` |
| `derive-error` | `<why>`: nothing was written |
