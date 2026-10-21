# stopstopping

Four [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugins that keep an agent working instead of stopping to ask: one ends a turn left on an open dialog, one keeps the prompt cache warm while you are away, one nudges the agent on when it stops early, and one keeps a session log. Install them through one bundle plugin or one by one.

## Install

```
claude plugin install stopstopping --marketplace federbenjamin/stopstopping
```

Or one part: the same command with `dialog-timeout`, `cache-keepalive`, `stop-judge`, or `session-log` in place of `stopstopping`. The bundle is a dependency list, so installing it installs the four parts under their own names, and installing a part beside it changes nothing.

## The plugins

- **[dialog-timeout](plugins/dialog-timeout/README.md)** ends a turn left on a permission prompt or question for 30 minutes and tells the agent you are away (`/afk`).
- **[cache-keepalive](plugins/cache-keepalive/README.md)** keeps an idle session's prompt cache warm with a short ping, and ends on a handoff.
- **[stop-judge](plugins/stop-judge/README.md)** judges each early stop and nudges the agent to carry on; `/stop-judge derive` writes a `DECISIONS.md` of your own rules from your sessions.
- **[session-log](plugins/session-log/README.md)** keeps one markdown log per session, pruned at compaction, and ships the handoff and finish-session skills.
- **[stopstopping](plugins/stopstopping/README.md)** is a dependency list that installs all four.

## Files

Everything the plugins write for you to read lives under `~/.claude/stopstopping/` (`STOPSTOPPING_DIR` replaces it):

- `DECISIONS.md`: your decision rules, derived from your sessions
- `DECISIONS.md.prev`: the previous `DECISIONS.md`, kept by `/stop-judge derive` when it overwrites the file
- `last-run.json`: the measured cost per turn of the last derive run, written by `/stop-judge derive` for the next estimate
- `context-off`: an empty flag file `/stop-judge context off` writes (removed by `context on`); while it exists the session-start hook does not print `DECISIONS.md`
- `logs/`: one log per plugin
- `session-logs/`: the session logs and their template
- `handoffs/`: handoff documents

## Logs

Every mechanism appends one line per firing to its log. Read one back with `awk '{print $2}' ~/.claude/stopstopping/logs/<plugin>.log | sort | uniq -c`.

| Plugin | Log |
| --- | --- |
| dialog-timeout | `~/.claude/stopstopping/logs/dialog-timeout.log` |
| cache-keepalive | `~/.claude/stopstopping/logs/cache-keepalive.log` |
| stop-judge | `~/.claude/stopstopping/logs/stop-judge.log` |
| session-log | `~/.claude/stopstopping/logs/session-log.log` |

## Settings

Settings (the judge on or off, the dialog timeout) live in the engine's store under each plugin's name. A part keeps its settings whether installed alone or through the bundle.

## Contributing

Report a problem or ask a question in [Issues](https://github.com/federbenjamin/stopstopping/issues). Pull requests are welcome.

Checks, from the repo root:

```
bash scripts/check.sh
```

`tsc` needs the engine's types, which an interactive `claude --plugin-dir plugins/<name>` load writes to `plugins/<name>/.claude-plugin/types/`; without them `check.sh` skips `tsc` and says so. Files under `hooks/shared/` and `tools/eval/hooks/judge/` are generated: edit the source and run `node scripts/sync-shared.ts`.

## License

MIT © Benjamin Feder. See [LICENSE](LICENSE).
