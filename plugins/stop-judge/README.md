# stop-judge

<p align="center"><strong>Nudges a Claude Code agent that stopped early to ask something it could have decided itself</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/federbenjamin/stopstopping" alt="License"></a>
</p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin for people who want the agent to keep working. When a turn ends, a small model (haiku) reads the messages that framed the turn and the agent's final message, and decides whether the agent was right to hand control back. When it was not (it ended on "want me to run the tests?", or on a step it could have taken), the plugin sends the agent a short reminder as if you had typed it, and the agent carries on.

## Install

Needs Claude Code. This is one part of the [stopstopping](../../README.md) marketplace: install `stopstopping` or this plugin, not both (both would run the judge twice).

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
- **Minutes since you last wrote.** The request also states the whole minutes since your last typed message, and the prompt says how to read the gap (short: an active discussion, lean stop; long: unattended work, lean continue). `MINUTES_FACT` in `hooks/judge.ts` is the one switch; with it off the request is the measured text alone. Shipped value: on, pending the eval run that compares it against the numbers above.

## Usage

| Command | Effect |
| --- | --- |
| `/stop-judge` | On or off, context on or off, outcome counts of the last 7 days, `DECISIONS.md` line count and date |
| `/stop-judge off` / `on` | Stop or resume judging, in every session |
| `/stop-judge context off` / `on` | Keep or leave out `DECISIONS.md` at session start |
| `/stop-judge derive [all]` | Derive `DECISIONS.md` from your sessions |
| anything else | Print the usage line |

The command is registered in every session, `claude -p` included, so a script can run `claude -p "/stop-judge off"`. `context` and `derive` answer "lands in the next build" until the derivation ships.

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

On/off lives in the engine's store under this plugin's name. Installing the bundle instead of this plugin starts from the defaults (on), and so does switching back.

## Derive

`/stop-judge derive` is not built yet in this version.
