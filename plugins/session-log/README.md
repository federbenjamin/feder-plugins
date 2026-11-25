# session-log

<p align="center"><strong>One log per Claude Code session, kept through six tools and a recorder, with the handoff and finish-session skills</strong></p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that gives every session one log: what it did, what is left, and what was decided. The agent never edits a file. It records through tools the plugin owns, and the plugin itself notes what the session did. The log is the memory that survives compaction, and the source the `handoff` skill reads.

## Install

This is one part of the [feder-plugins](../../README.md) marketplace: install `stopstopping`, which installs this plugin under its own name as a dependency, or this plugin alone; installing both changes nothing.

```
claude plugin install session-log --marketplace federbenjamin/feder-plugins
```

## How it works

Each session has two files under `~/.claude/stopstopping/session-logs/` (`STOPSTOPPING_DIR` replaces the folder):

- `<session-id>.jsonl`, the store: one event per line, append-only. The plugin is its only writer.
- `<session-id>.md`, the view: rewritten from the store after every write. A hand edit to it is lost at the next write.

At every session start, headless runs included, the plugin registers six tools, listed in front of the agent with no search step:

| Tool | Input | Does |
| --- | --- | --- |
| `todo_add` | `text`, optional `tag` | Adds an open todo and returns its id (`t1`) |
| `todo_close` | `id`, optional `note` | Closes it |
| `decide` | `pick`, `over` (one or more), `reason`, optional `replaces`, optional `by_session` | Records one choice the agent made; `by_session` marks a ruling another session relayed |
| `ruling` | `quote`, `meaning`, optional `key` and `value`, optional `replaces` | Records the operator's own words; with `key` and `value` it sets a session limit |
| `note` | `text` | Records a finding or a reason that lives nowhere else |
| `log_read` | optional `session` | Returns the view, for this session or another session's id |

A SessionStart command hook tells the agent about them in one line, and after a compaction or a resume prints the view below that line, so open todos and standing rulings come back without a read call.

### When a tool refuses or writes nothing

- A call from a subagent is refused. Subagents keep no log.
- `todo_close` on an id already closed replies `already closed`. An unknown id is an error that names the open ids.
- `decide` with no alternative in `over`, or no `reason`, is refused.
- `ruling` is refused when its quote is not in what the operator typed in this session. The plugin keeps each typed prompt for this check (a prompt from the terminal or a bridge, and a headless run's opening prompt; a prompt past 8,000 characters is kept as its two ends). The same quote recorded twice writes nothing the second time.
- `log_read` for a session with no store returns that session's `.md` as it is, so a log kept before the tools stays readable.

### What the plugin records itself

After a tool call of the main session succeeds, a recorder notes what it did. No model call is made.

| It records | From |
| --- | --- |
| A file written | A `Write`, `Edit` or `NotebookEdit` call |
| A commit, with its sha and subject | A Bash command that runs `git commit`, `git revert` or `git cherry-pick`, read from its output |
| A push | A Bash command that runs `git push` |
| A pull request opened or merged | A Bash command that runs `gh pr create` or `gh pr merge` |

It records nothing for a failed call, a subagent's call, a write to the log's own files, or a command that only mentions those words inside a quoted string, a heredoc or a comment.

### The view

```
# Session log — <session-id>

## Work log

- 2026-11-25 22:41Z commit 7b51b15 add the parser
- files written (14, newest 10): src/parse.ts ×3, …

## Todo

- [ ] t2 wire the parser into the CLI

## Decisions

- 2026-11-25 [agent] a hand-written parser over a parser generator -- the grammar has four rules (d1)
- 2026-11-25 [user] no new dependencies: "don't add packages for this" (r1)
tunable: retries=2 (was default)
- 2026-11-25 note: the fixture file is generated; edit its source (n1)
```

A closed todo leaves the view, and so does a decision or ruling that a later one names in `replaces`. The store keeps both.

### A log kept by hand

A session whose `.md` exists with no store was kept by hand, before the tools. At that session's first write the plugin moves the file to `<session-id>.legacy.md`, once, and the view names it.

## Skills

- `/session-log:handoff`: writes a thin handoff doc for a fresh session, to `~/.claude/stopstopping/handoffs/<session-id>-<slug>-handoff.md` unless your instructions name a folder for documents.
- `/session-log:finish-session`: closes a session with every leftover done or on the open list, handing off only what is open. With `cache-keepalive` installed, it also turns that plugin's pings off for the session.

## Log

Every firing appends one line to `~/.claude/stopstopping/logs/session-log.log`:

```
<utc> <outcome> session=<id> ms=<n> reason=<text>
```

| Outcome | When |
| --- | --- |
| `tools` | A session started; the reason counts the tools registered and names any refused |
| `todo-add`, `todo-close`, `decide`, `ruling`, `note` | That tool wrote, or replied without writing; the reason is its reply |
| `read` | `log_read` answered; the reason names the session, and `none` when it has no log |
| `refused` | A tool call was refused; the reason names the tool and why |
| `typed` | A typed prompt was kept for the quote check |
| `did` | The recorder wrote; the reason lists what (`file`, `commit`, `push`, `pr.create`, `pr.merge`) |
| `legacy` | A hand-kept `.md` was moved aside |
| `failed` | A read or write failed; nothing was recorded for that call |

Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/session-log.log | sort | uniq -c
```

## Settings

None.

## License

MIT, see [LICENSE](../../LICENSE).
