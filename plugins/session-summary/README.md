# session-summary

<p align="center"><strong>A pane beside the chat that says what this Claude Code session is about, what it is doing now, and which files to open</strong></p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin for people who keep many sessions open at once. Switching into one should not mean re-reading its transcript: a pane on the right of the screen keeps three short texts for it.

- **So far**: one or two sentences on the session since it began, edited as it goes rather than rewritten.
- **Now**: one sentence on the most recent task.
- **Files**: the documents the session wrote or sent you, newest first.

Experimental: it is not part of the `stopstopping` bundle.

## Install

Needs Claude Code. This plugin is listed in the [feder-plugins](../../README.md) marketplace:

```
claude plugin install session-summary --marketplace federbenjamin/feder-plugins
```

It starts in the next session. To run it in every session without installing it, start Claude Code with `CLAUDE_CODE_PLUGIN_DIRS=<repo>/plugins/session-summary` in its environment, `<repo>` being your clone of this repository.

## How it works

- **A haiku call writes the texts.** It reads a tail window of the session's recent activity (16,000 characters, oldest first) and the previous texts, and answers a TASK verdict and four labelled texts, written in Simplified Technical English (ASD-STE100): sentences of 25 words or fewer, one fact each, active voice, plain words. NOW starts with an -ing word and names the work it concerns, and SO FAR covers the session as a whole. Tool results are left out; each tool call is one line (`→ Bash: <command>`, `→ Edit: <file>`). A prompt you send while a turn runs reaches the agent inside that turn but is missing from the messages Claude Code hands the plugin, so the plugin keeps it when you press Enter and puts it back in the window as your line, where it arrived.
- **Last prompt.** The plugin finds your newest typed prompt in the whole session and sends it apart from the window; LAST PROMPT sums it up in one sentence. While that prompt is unchanged, LAST PROMPT stays as it was written. SO FAR says where the task stands and does not repeat the request.
- **Task switches.** Each reply opens with `TASK: same` or `TASK: new`. `same` is the default: questions, status checks, corrections, clean-up and follow-ups all keep it, and so does a short or unclear prompt. `new` means you plainly started a different project or goal. On `same` the title holds word for word and SO FAR is edited; on `new` the title names the new work and SO FAR is written fresh, with at most one clause about earlier work. The capture records each verdict.
- **First prompt.** When a main turn starts while the pane is empty (a new session, or after `/clear`), one call runs at the turn's first model step, so the pane fills within seconds. Its title is marked provisional in the next call's request, which may replace it once the activity shows the work; after that the title holds as usual. A resumed session whose pane is restored from its capture makes no such call.
- **Your prompts.** Each prompt you send makes one call at the next model step, and the turn then earns its `ended` call, so LAST PROMPT and NOW follow you even in a short turn. That is about two calls per exchange, around $0.002.
- **Cadence.** 90 seconds after a main turn starts, every 10 minutes while it runs, and once more when it ends and hands back to you (status `ended`). A turn nothing has summarized that ends before the first 90 seconds, such as one a tool or a nudge started, makes no call. A call reading the same window as the last summary in the same turn is skipped, and the window is checked again 10 minutes later (a turn's first call is never skipped); a failed call is retried at the same 10 minutes. A turn whose first call comes due while the turn before's call is still running gets it as soon as that call lands, one call at a time.
- **Main turns only.** A turn starts the clock whatever started it: your prompt, a stop-judge nudge, a task notification. Subagent turns and cache-keepalive's ping turns are ignored.
- **Title**: what the whole session is working on, in three to six words, at the top of the pane. It names the work, not the latest step. The model keeps it word for word until you move the session to different work.
- **Files** are a list the plugin keeps, with no model call: a `Write` or `Edit` of a document (`.md`, `.txt`, `.html`, `.htm`, `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`) joins it, so does a document an agent's message names by full path (a report made with a shell command reaches you this way), and so does anything sent with `SendUserFile`, whatever its type. Only those three calls touch a file: a later `Write`, `Edit` or send moves a listed file to the top; a `Read`, a shell command or a relative name does not. Nothing leaves because it looks stale. The list is merged with the session's messages (Claude Code hands the plugin its newest 4096, so what they no longer hold stays where it was) on the 30-second tick after a main model step, and on every summary call, so it runs even with summary calls off. Files made only through shell commands, or by a subagent, are not seen.
- **Interactive sessions only.** A `claude -p` run makes no call and writes nothing; the command still answers there.
- **Resume.** A resumed session's pane starts from the texts and the file list its last call left (the capture file below). A `/clear` empties the pane and the list.

## The pane

The pane opens when an interactive session starts, on a darker background than the transcript, newest first: the title in bold over a rule; `● NOW` (green while a turn runs, `○` once it ended) with the age of the texts, at full brightness; then, dimmer and indented, `SO FAR` and `YOU ASKED`. `FILES` stands apart, pinned to the bottom of the pane: at most three rows, newest first, one line each, relative to the session's directory, opening on a click where the terminal supports it. The mouse wheel over the section scrolls to older files, and past three files its header says where you are (`FILES 4–6 of 12`). With no files it is hidden. In a short pane the texts are cut from the bottom so the section stays on screen; a text cut this way cannot be scrolled to. The age refreshes every 30 seconds. The input source and prompt variant are not drawn; `/session-summary show` prints them. It reads `No summary yet.` until the session's first summary, with `FILES` under it once there are any.

Claude Code decides where a pane goes. In the fullscreen layout (`"tui": "fullscreen"`) it docks on the right of the transcript from 110 columns. Below that, and on the main-screen layout, it sits above the prompt. A pane opened at session start waits undrawn on a terminal under 144 columns; `/session-summary` opens it at any width. The same command brings it back after you close it.

## Experiment switches

Three switches, read at every call, so they change a running session:

- **Input source**: `messages` (default: the tail window of the session's messages) or `session-log` (the tail of the session's own log file, from the session-log plugin; with no log file the call falls back to `messages` and logs `log-missing`).
- **Prompt variant**: `edit` (default: start from the previous So far, change only what is no longer true), `rewrite` (no stability rule) or `append` (So far may only replace its last sentence or add one).
- **Cadence**: `first` and `every`, in seconds.

## Usage

| Command | Effect |
| --- | --- |
| `/session-summary` | Open the pane |
| `/session-summary off` / `on` | Stop or resume summary calls, in every session |
| `/session-summary first <seconds>` | The first call this long after a main turn starts (default 90) |
| `/session-summary every <seconds>` | Later calls this long after the last one (default 600) |
| `/session-summary source messages` / `session-log` | The input source |
| `/session-summary variant <name>` | The prompt variant: `edit`, `rewrite` or `append` |
| `/session-summary links on` / `off` | File links over Tailscale, for viewing this machine's sessions from another one (below). Off by default |
| `/session-summary show` | The texts, the files, the settings, the links state, this session's calls, tokens and dollars, and the capture path |
| `/session-summary now` | One summary call at once, with the session's status (`running` mid-turn, else `ended`), even when switched off or the window is unchanged; prints its outcome, then what `show` prints. The timer's schedule is unchanged. Interactive sessions only |
| anything else | Print the usage line |

The command is registered in every session, `claude -p` included, so `claude -p "/session-summary off"` works from a script.

## File links over Tailscale

A `file://` link opens on the machine you click it on, so it fails when you view a session over SSH from another computer. `/session-summary links on` makes the rows `https://` links into a small file server on the machine running the session. Clicks then work from any device on your tailnet. macOS only.

**What it installs.** A launchd job (`com.session-summary.links`) that keeps a Python file server running, bound to `127.0.0.1` only, and one `tailscale serve` entry that proxies https port 8692 to it (local port 8693). `links on` refuses, changing nothing, when the machine is not a Mac, when Tailscale is missing, not running or has no HTTPS (turn on HTTPS Certificates in the Tailscale admin console), or when another target already holds port 8692. Your other `tailscale serve` entries are never touched. A LaunchAgent starts at your login, so after a reboot the server runs once you have logged in.

**What is exposed.** Any device on your tailnet holding a link can read that one file. Tailscale Serve reaches your tailnet only, not the internet. A link is `https://<machine>:8692/<token>/<file name>` with a random 128-bit token; there is no listing, no way to guess a token, and every other request gets the same empty 404. The server only reads; nothing can change a file through it. A link shows the file as it is when opened, not as it was when shared. Anyone you hand a link to who is on your tailnet can open it.

**The 7-day rule.** A file is shared when it joins the list or a `Write`, `Edit`, send or agent message touches it, and a link lasts 7 days from that latest touch. A touch renews it and the link stays the same. Past expiry, or once the file is gone, the row shows dimmed with no link; a new touch shares it again under a new link.

**Never shared.** Paths where any segment looks secret: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, `*credentials*`, `*secret*`, in any case. The plugin leaves them out and the server refuses them again, following symlinks. Their rows show with no link. This goes by name: a secret in a file called `notes.md` that you write or send is shared like any other.

**Files macOS guards.** The job runs outside your terminal, so macOS may refuse it files in Documents, Desktop or Downloads until you grant Python access under Privacy & Security; until then such a link answers 404.

**Turning it off.** `/session-summary links off` deletes the list of shares, so every link is dead at once, then removes that one `tailscale serve` entry and the job. Run it before you uninstall the plugin: the job outlives the plugin otherwise. Sessions on a machine with links off show `file://` links. The job runs a copy of the server under the state folder, so after a plugin update run `links on` again to pick up a new server.

## Log

Every call, and every tick that skips one, appends one line to `~/.claude/stopstopping/logs/session-summary.log` (`STOPSTOPPING_DIR` replaces the folder):

```
<utc> <outcome> session=<id> ms=<n> reason=source=<arm> variant=<name> in=<n> out=<n> cached=<n> usd=<x>
```

A call the timer did not start ends its line with its trigger: `manual` for `/session-summary now`, `first` for the first-prompt call, `prompt` for a later prompt's call.

`in` and `cached` are the uncached and cache-read input tokens; `usd` is priced at haiku's rates per token category.

| Outcome | Meaning |
| --- | --- |
| `summary` | The reply carried all four lines; the pane has them |
| `parse-partial` | Some of the four lines came back; the missing ones kept their previous text |
| `parse-failed` | No line came back; the pane is unchanged |
| `skip-same` | The window was the same as the last summary's in this turn; no call |
| `skip-inflight` | A call was due while one of the same turn was still running or waiting for the turn before's, or the turn ended while its call waited; no call |
| `log-missing` | Source `session-log` with no log file for the session; that call read `messages` |
| `api-error` | The call failed; the reason names why |
| `aborted` | The call was cut: its 20-second limit, or the session ended |
| `turn-id-mismatch` | A main turn completed under another id than the running one's, which stays running; the reason names both ids; no call |
| `documents-failed` | The file list or the shares file could not be updated; the next tick tries again |
| `links-on` | `/session-summary links on` finished; the reason names the two ports |
| `links-off` | `/session-summary links off` ran; the reason is `clean`, or `partial` when something stayed |
| `share` | A file was newly shared or its link renewed; the reason holds the token's first 8 characters and the expiry, never the path |

Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/session-summary.log | sort | uniq -c
```

Calls, tokens and dollars per source and variant:

```
awk '$2 !~ /^(skip|log-missing|turn-id-mismatch|documents-failed|links-|share)/ { split($5,s,"="); split($6,v,"="); split($7,i,"="); split($8,o,"="); split($9,c,"="); split($10,u,"="); k=s[3]" "v[2]; n[k]++; tin[k]+=i[2]; tout[k]+=o[2]; tc[k]+=c[2]; usd[k]+=u[2] } END { for (k in n) printf "%s: %d calls, in %d, out %d, cached %d, $%.4f\n", k, n[k], tin[k], tout[k], tc[k], usd[k] }' ~/.claude/stopstopping/logs/session-summary.log
```

The file server appends one line per request to `~/.claude/stopstopping/logs/session-summary-links.log`, in the same shape: the status as the outcome, an empty session, and the token's first 8 characters (`-` for a request that holds no token), never the path:

```
<utc> <status> session= ms=<n> reason=token=<prefix>
```

Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/session-summary-links.log | sort | uniq -c
```

## Capture

Every call appends one JSON line to `~/.claude/stopstopping/session-summaries/<session id>.jsonl`: `at`, `status`, `source`, `variant`, the `previous` texts, the `task` verdict (`same`, `new`, or null when the reply had none), the `input` it read and `inputChars`, the new `title`, `soFar` and `now`, the file list as `files` (each `path`, `touchedAt` and `touches`, never a link's token), the `outcome`, `ms`, the token `usage` and `usd`. Compare two sources or variants by reading their captures side by side.

## Settings

`/session-summary`'s settings (`isOff`, `firstSeconds`, `everySeconds`, `source`, `variant`, and `linksBase`, the links' https base, empty while links are off) live in the engine's store under this plugin's name and are shared by every session. An invalid stored field falls back to its default alone.

Links keep two files under `~/.claude/stopstopping/session-summary/`: `shares.json`, readable by you only, holding each live link's token, path and expiry (the file the server reads per request, written atomically by every session), and `file_server.py`, the copy the job runs.
