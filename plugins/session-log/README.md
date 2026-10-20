# session-log

<p align="center"><strong>One markdown session log per Claude Code session, pruned at compaction, with the handoff and finish-session skills</strong></p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that gives every session one log the agent keeps as it works: what it did, what is left, and what was decided. The log is the memory that survives compaction, and the source the `handoff` skill reads.

## Install

This is one part of the [stopstopping](../../README.md) marketplace: install `stopstopping` or this plugin, not both (both would load the same hooks twice).

```
claude plugin install session-log --marketplace federbenjamin/stopstopping
```

## How it works

At every session start the plugin rewrites `session-logs/TEMPLATE.md` under `~/.claude/stopstopping/` (`STOPSTOPPING_DIR` replaces the folder), and a SessionStart command hook tells the agent, in one line:

```
SESSION LOG — keep <dir>/session-logs/<session-id>.md in the format of <dir>/session-logs/TEMPLATE.md; each section comment says what goes in it. Missing: create it from the template at the first real request, or copy the log a handoff doc names. Present: read it before other work; it is the memory across compaction. Append as things happen, never rewrite a line, and update it before ending a multi-step turn. Main session only.
```

The template has three sections, each with a comment saying what goes in it:

| Section | Line shape |
| --- | --- |
| Work log | `- HH:MMZ <fact> (<sha>)` |
| Todo | `- [ ] <task>`, flipped to `- [x]` when done |
| Decisions | `- <date> [user] <ruling>: "<their words>"` for words said in this session; `- <date> [agent] <pick> over <A>, <B>`, with ` -- <reason>` when not obvious; a line that ends `replaces: "<quote>"` supersedes the earlier one |

## What moves at compaction

When the main conversation is compacted, the plugin appends the line `- HH:MMZ compacted` to the Work log and moves lines to `<session-id>.archive.md` beside the log, under the same headings:

- every Work-log line above the previous `compacted` line (a line stays in the log across exactly one compaction);
- every `- [x]` Todo line;
- every Decisions line a later line supersedes with `replaces: "<quote>"`. A quote that matches none or several earlier lines moves nothing and is logged as a warning.

A `- [ ]` Todo line and any Decisions line nothing replaces never move. The archive is written before the log, so a crash between the two leaves a line in both places, never in neither. After a compaction the directive carries a second line, `SESSION LOG PRUNE — moved <k> lines → <archive>`.

## Skills

- `/session-log:handoff`: writes a thin handoff doc for a fresh session, to `~/.claude/stopstopping/handoffs/<session-id>-<slug>-handoff.md` unless your instructions name a folder for documents.
- `/session-log:finish-session`: closes a session with every leftover done or on the open list, handing off only what is open.

## Log

Every firing appends one line to `~/.claude/stopstopping/logs/session-log.log`:

```
<utc> <outcome> session=<id> ms=<n> reason=<text>
```

Outcomes: `template` (the template was written), `prune` (a compaction moved lines; the reason holds the count and the archive path), `prune-warning` (an unusable `replaces:` quote), `prune-skipped` (the log lacks one of the three sections).

Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/session-log.log | sort | uniq -c
```

## Settings

None.

## License

MIT, see [LICENSE](../../LICENSE).
