# session-summary

<p align="center"><strong>A band above the prompt that says what this Claude Code session is about, what it is doing now, and which files to open</strong></p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin for people who keep many sessions open at once. Switching into one should not mean re-reading its transcript: a band at the bottom of the screen keeps three short texts for it.

- **So far**: one or two sentences on the session since it began, edited as it goes rather than rewritten.
- **Now**: one sentence on the most recent task.
- **Files**: one, at most two, paths you would open now (the plan the session is writing, the report it just sent you).

Experimental: it is not part of the `stopstopping` bundle.

## Install

Needs Claude Code. This plugin is listed in the [stopstopping](../../README.md) marketplace:

```
claude plugin install session-summary --marketplace federbenjamin/stopstopping
```

It starts in the next session. To run it in every session without installing it, start Claude Code with `CLAUDE_CODE_PLUGIN_DIRS=<repo>/plugins/session-summary` in its environment, `<repo>` being your clone of this repository.

## How it works

- **A haiku call writes the texts.** It reads a tail window of the session's recent activity (16,000 characters, oldest first) and the previous texts, and answers three labelled lines. Tool results are left out; each tool call is one line (`→ Bash: <command>`, `→ Edit: <file>`).
- **Cadence.** 90 seconds after a main turn starts, every 10 minutes while it runs, and once more when it ends and hands back to you (status `ended`). A turn that ends before the first 90 seconds makes no call. A call reading the same window as the last summary in the same turn is skipped, and the window is checked again 10 minutes later (a turn's first call is never skipped); a failed call is retried at the same 10 minutes. A turn whose first call comes due while the turn before's call is still running gets it as soon as that call lands, one call at a time.
- **Main turns only.** A turn starts the clock whatever started it: your prompt, a stop-judge nudge, a task notification. Subagent turns and cache-keepalive's ping turns are ignored.
- **Title**: what the session is, in ten words or fewer, at the top of the band. The model keeps it word for word unless the session's purpose changes.
- **Files** come from the `Write` and `Edit` calls and `SendUserFile` files in the session's messages (Claude Code hands the plugin its newest 4096), newest by their last mention in any tool call, up to 8, plus the files already shown. A file sent to you is marked as such and comes first while it is current. The model judges every shown file again on each call and drops it once it is stale (a plan finished or replaced, a report superseded, a draft shipped); a path it names that is not on the list is dropped. Files made only through shell commands are not seen.
- **Interactive sessions only.** A `claude -p` run makes no call and writes nothing; the command still answers there.
- **Resume.** A resumed session's band starts from the texts its last call left (the capture file below). A `/clear` empties the band.

## The band

The texts sit in the band directly above the prompt, at the bottom of the screen, in every layout and at any width, under a thin line and on a darker background than the transcript: the title in bold, then `SO FAR:` and `NOW:` with their texts starting in one column, then `RECENT FILES:` when there are any, then when the texts were last updated. The input source and prompt variant are not drawn; `/session-summary show` prints them. The band stays empty until the session's first summary. Claude Code's `[-]` mark at its right end collapses it.

## Experiment switches

Three switches, read at every call, so they change a running session:

- **Input source**: `messages` (default: the tail window of the session's messages) or `session-log` (the tail of the session's own log file, from the session-log plugin; with no log file the call falls back to `messages` and logs `log-missing`).
- **Prompt variant**: `edit` (default: start from the previous So far, change only what is no longer true), `rewrite` (no stability rule) or `append` (So far may only replace its last sentence or add one).
- **Cadence**: `first` and `every`, in seconds.

## Usage

| Command | Effect |
| --- | --- |
| `/session-summary` | Print the three texts, the same as `show` |
| `/session-summary off` / `on` | Stop or resume summary calls, in every session |
| `/session-summary first <seconds>` | The first call this long after a main turn starts (default 90) |
| `/session-summary every <seconds>` | Later calls this long after the last one (default 600) |
| `/session-summary source messages` / `session-log` | The input source |
| `/session-summary variant <name>` | The prompt variant: `edit`, `rewrite` or `append` |
| `/session-summary show` | The three texts, the settings, this session's calls, tokens and dollars, and the capture path |
| anything else | Print the usage line |

The command is registered in every session, `claude -p` included, so `claude -p "/session-summary off"` works from a script.

## Log

Every call, and every tick that skips one, appends one line to `~/.claude/stopstopping/logs/session-summary.log` (`STOPSTOPPING_DIR` replaces the folder):

```
<utc> <outcome> session=<id> ms=<n> reason=source=<arm> variant=<name> in=<n> out=<n> cached=<n> usd=<x>
```

`in` and `cached` are the uncached and cache-read input tokens; `usd` is priced at haiku's rates per token category.

| Outcome | Meaning |
| --- | --- |
| `summary` | The reply carried all three lines; the band has them |
| `parse-partial` | One or two lines came back; the missing ones kept their previous text |
| `parse-failed` | No line came back; the band is unchanged |
| `skip-same` | The window was the same as the last summary's in this turn; no call |
| `skip-inflight` | A call was due while one of the same turn was still running or waiting for the turn before's, or the turn ended while its call waited; no call |
| `log-missing` | Source `session-log` with no log file for the session; that call read `messages` |
| `api-error` | The call failed; the reason names why |
| `aborted` | The call was cut: its 20-second limit, or the session ended |

Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/session-summary.log | sort | uniq -c
```

Calls, tokens and dollars per source and variant:

```
awk '$2 !~ /^(skip|log-missing)/ { split($5,s,"="); split($6,v,"="); split($7,i,"="); split($8,o,"="); split($9,c,"="); split($10,u,"="); k=s[3]" "v[2]; n[k]++; tin[k]+=i[2]; tout[k]+=o[2]; tc[k]+=c[2]; usd[k]+=u[2] } END { for (k in n) printf "%s: %d calls, in %d, out %d, cached %d, $%.4f\n", k, n[k], tin[k], tout[k], tc[k], usd[k] }' ~/.claude/stopstopping/logs/session-summary.log
```

## Capture

Every call appends one JSON line to `~/.claude/stopstopping/session-summaries/<session id>.jsonl`: `at`, `status`, `source`, `variant`, the `previous` texts, the `input` it read and `inputChars`, the file `candidates`, the new `soFar`, `now` and `files`, the `outcome`, `ms`, the token `usage` and `usd`. Compare two sources or variants by reading their captures side by side.

## Settings

`/session-summary`'s settings (`isOff`, `firstSeconds`, `everySeconds`, `source`, `variant`) live in the engine's store under this plugin's name and are shared by every session. An invalid stored field falls back to its default alone.
