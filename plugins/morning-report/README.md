# morning-report

<p align="center"><strong>A nightly status of your Claude Code streams, for you and your agents, plus a running catalog of what is going well and what is not</strong></p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that reads your Claude Code sessions each night and writes two files: `status.md`, one block per stream of work saying which repo it lives in, what landed, what is left and who it waits on; and `patterns.md`, one dated entry a day of what went well and what did not, judged by a list you set. Nothing is injected into any session: you and your agents open the files when you want them.

## Install

This is one part of the [feder-plugins](../../README.md) marketplace.

```
claude plugin install morning-report --marketplace federbenjamin/feder-plugins
```

Then run `/morning-setup` once in any Claude Code session to write your Watch for list, and `/morning-setup schedule` (macOS) to run it each night. The status needs no setup; only the patterns catalog reads the list.

## What it writes

### `status.md`

One block per stream, the most recently touched first:

```
## <stream name>
- repo: <repo or folder name> (`<path>`)
- what: <one sentence: what this stream is>
- landed: <the last thing that landed, with its date>
- left: <the work still to do>
- waits on: you | the agent | <a named person, review or release> | nothing
- last touched: YYYY-MM-DD
```

Each night's status starts from the previous one: a stream no session touched is carried as it was, with its date unchanged. A stream silent for 30 days is listed once under `## Dropped` with the day it went, then left out. The plugin appends any previous stream the answer leaves out, so a stream leaves only through `## Dropped`; restores a stream's previous block when the answer moves its date though no summary names it (checked only when every summary stream name has a block of its own); orders the blocks; and applies the drops.

### `patterns.md`

One entry per day, oldest first:

```
## YYYY-MM-DD

### Going well
- <a moment that fits your Watch for list> (session <id>)

### Not working
- Nothing seen.
```

Only what fits the `## Watch for` list in your `profile.md` goes in. With no profile, or a list that reads `(none)`, the run writes the status and skips the entry. A day with no sessions, or only idle ones, gets no entry, and a rerun of a day replaces that day's entry. If the patterns answer lacks either list, the status is still written, the entry is skipped, and the reason lands in the run record, the notification and the firing log; `/morning-run --force` the same day writes it again.

## Usage

### Set up

`/morning-setup` writes `profile.md`, which holds one heading, `## Watch for`: what the catalog should notice each day.

1. **Consent.** The command counts your sessions from the last `setupDays` days (7 at most) and starts an interview in the same session. It shows what reading them would cost (the sessions, the summary calls on `summaryModel`, one `reportModel` call) and asks whether to read them, for how many days, or to skip. Counting reads the transcripts on this machine; nothing goes to a model yet.
2. **The scan**, only if you agreed: it summarizes those sessions and writes `runs/setup-scan.md`, the habits it saw. It takes a few minutes.
3. **One round** on what to watch for, starting from the scan's habits when there is a scan. The interview writes `profile.md` and shows it to you once.

Run `/morning-setup` again to change the list; it shows your current one first. A profile from an earlier version keeps working: the run reads its `## Watch for` section and ignores the rest, and the next `/morning-setup` writes the one heading.

**`/morning-setup schedule`** (macOS) installs a launchd job, `com.morning-report`. It runs `claude -p /morning-run` at `reportHour`, then hourly for four more hours, so a run that failed is tried again; once the day's run record exists, the later fires say `already written` and stop. The job's log is `~/Library/Logs/com.morning-report/run.log`. The job clears every environment variable but `HOME`, `PATH` and the login ones (`USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `SSH_AUTH_SOCK`), including any set with `launchctl setenv`, and runs from your home folder, so `schedule` first checks that `claude plugin list` lists the plugin enabled there; a plugin installed for one project, or under `CLAUDE_CONFIG_DIR`, is refused. After you uninstall the plugin, the job removes itself the next time it fires, and writes why to its log first. While the plugin is disabled, the job runs nothing. On other systems, run `claude -p /morning-run` each morning by hand, or put it in your own scheduler.

### Run by hand

- `/morning-run` writes the day's files for the sessions since the last run. A second run on the same day says `already written`.
- `/morning-run --force` redoes the day over the first run's window, from the same previous status.
- `/morning-run --backfill YYYY-MM-DD --until <ISO time>` writes that date's session summaries over the 24h before `--until`, and nothing else: no status, no patterns entry, and the watermark stays.

### Remove

```
/morning-setup remove
```

This unloads the launchd job and deletes its plist (`~/Library/LaunchAgents/com.morning-report.plist`) and its log folder. Your files stay in the data folder; the command prints its path. Then uninstall the plugin:

```
claude plugin uninstall morning-report@feder-plugins
```

## Configuration

Set them with `/plugin configure morning-report@feder-plugins`, or under `pluginConfigs["morning-report@feder-plugins"].options` in `~/.claude/settings.json`:

| Option | Default |
| --- | --- |
| `dataDir` | `~/.morning-report` |
| `summaryModel` | `sonnet` |
| `reportModel` | `opus`: writes the status and the patterns entry |
| `sessionLogsDir` | empty (skip): an optional folder of `<session-id>.md` logs to read beside the transcripts |
| `notifyCommand` | empty (skip): a command run with one message argument when a run finishes or fails |
| `gitCommit` | `false`. When on and `dataDir` is a folder of a git repo, each run commits that folder and pushes. A failed push is reported, never fatal. Ignore `state.json` in that repo. |
| `setupDays` | `7` (at most 7): how many days of sessions `/morning-setup` offers to read |
| `reportHour` | `5` (0–19): the hour `/morning-setup schedule` runs the job, then hourly for four hours to retry a failed run. Run `/morning-setup schedule` again after you change it. |

## Data folder

Everything lands in `dataDir`:

| File | Written by | Holds |
| --- | --- | --- |
| `status.md` | each nightly run | a copy of the newest `runs/<date>-status.md`: the one path to open for what is live |
| `patterns.md` | each nightly run with a Watch for list and sessions | one entry per date, replaced on a rerun of that date |
| `profile.md` | `/morning-setup` | the `## Watch for` list |
| `profile-<date>-old.md` | `/morning-setup` | the profile it replaced that day |
| `state.json` | each nightly run | the watermark, the window's start, the date written |
| `runs/<date>-status.md` | each nightly run | that day's status; the next run starts from the newest one before its own day |
| `runs/<date>-summaries.md` | each nightly run, and a backfill | the per-session summaries the status and patterns read |
| `runs/<date>-run.json` | each nightly run, last of its files | the window, sessions, active minutes overall and by project, stream and drop counts, whether patterns was written, seconds, token usage per model; its presence marks the day done |
| `runs/setup-scan.md` | `/morning-setup`, when you let it read your sessions | the habits it saw |

## How it works

1. **At `reportHour`:** launchd (macOS) runs `claude -p /morning-run`, and again on the hour for four hours. A fire whose day already has `runs/<date>-run.json`, or whose date `state.json` names, stops there.
2. **Extract:** `scripts/extract.py` pulls the window's sessions as prose: what you typed, the agent's text, and each subagent's task and final report. It keeps prompts you typed while a turn ran. It drops tool output, headless sessions, and, in a session where you ran `/morning-setup` or `/morning-run`, everything from that command on.
3. **Summarize:** one call to `summaryModel` per batch of sessions, a long session alone and short ones together (`prompts/summarizer.md`, with your profile inserted so friction follows your Watch for list).
4. **Status and patterns:** two `reportModel` calls at once. `prompts/status.md` reads the previous status, the sessions list (each session's folder and the date of its last message) and the summaries, and writes every block. `prompts/patterns.md` reads your Watch for list and the summaries, and writes the two lists. A window with no sessions, or whose summaries are all idle lines, makes neither call: the previous status is carried, with the drops applied. The sessions list shows a session run in a git worktree as its repo folder, with the worktree named after it.
5. **Output:** only when the status answer parses (every block has its `last touched` date, at least one block when the window had stream-worthy sessions) does the plugin write the files, then the run record, then advance the watermark and run `notifyCommand`. Otherwise nothing is written and the watermark stays, so the next fire covers the gap. A patterns answer that does not parse skips only its entry.

The window runs from the last successful run to now, capped at `MAX_WINDOW_MS` (`hooks/pipeline.ts`).

Failures:
- **Transient** (a rate limit, overload, a server error, a dropped connection): the call retries after the waits in `RETRY_DELAYS_S` (`hooks/shared/retry.ts`). The waits run as a `sleep` child process, because a `$.clock.sleep` would count against the hook's 10 s budget.
- **Permanent** (auth, billing, a bad model id): the run stops.
- **Still failing:** a session whose summary fails after its retries is listed as not summarized. The run fails only when more than half fail.

### Cost

Each night's run makes one `summaryModel` call per batch of sessions (a long session alone, short ones together) and two `reportModel` calls, one when there is no Watch for list and none on a day with no sessions. An example day of 34 sessions took 26 summary calls. The setup scan makes the same summary calls once, over up to 7 days, and one `reportModel` call; `/morning-setup` prints the count before it runs.

### Limits

- **Scheduled runs are macOS only.** On other systems, run `claude -p /morning-run` by hand or from your own scheduler.
- **launchd and the keychain.** The scheduled job runs `claude` headless. On a Mac where you have never run `claude` from a terminal in this login, it may not find your credentials; run `claude` once interactively first. The job's log shows the failure.
- **This machine only.** It reads the sessions on this machine, and the files stay in your data folder unless you turn on `gitCommit`.

## Log

Every `/morning-run`, `/morning-setup` and scan appends one line to `~/.claude/stopstopping/logs/morning-report.log`:

```
<utc> <outcome> session=<id> ms=<n> reason=<the command's answer>
```

Outcomes: `run-written`, `run-already`, `run-backfill`, `run-failed`, `run-usage` (bad arguments); `setup-interview`, `setup-schedule`, `setup-remove`, `setup-usage`, `setup-failed`; `scan`, `scan-failed`.

Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/morning-report.log | sort | uniq -c
```

## Development

From the repo root, `bash scripts/check.sh` runs this plugin's tests (`tests/*.test.ts` through `claude plugin test`, and `python3 -m unittest discover -s plugins/morning-report/scripts`), `tsc` and `claude plugin validate`. Load it from a checkout with `claude --plugin-dir plugins/morning-report`.
