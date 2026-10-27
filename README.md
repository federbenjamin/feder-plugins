# feder-plugins

Seven [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugins by federbenjamin, in one marketplace. Five keep an agent working instead of stopping to ask: one ends a turn left on an open dialog, one keeps the prompt cache warm while you are away, one nudges the agent on when it stops early, one keeps a session log, and one keeps a pane saying what the session is doing. One writes a nightly status of your streams of work, for you and your agents, plus a running catalog of what is going well and what is not. The seventh is a bundle that installs the first four.

## Install

```
claude plugin install stopstopping --marketplace federbenjamin/feder-plugins
```

Or one plugin: the same command with `dialog-timeout`, `cache-keepalive`, `stop-judge`, `session-log`, `session-summary`, or `morning-report` in place of `stopstopping`. The bundle is a dependency list, so installing it installs the first four under their own names, and installing one beside it changes nothing. `session-summary` (experimental) and `morning-report` are not in the bundle.

## The plugins

- **[dialog-timeout](plugins/dialog-timeout/README.md)** ends a turn left on a permission prompt or question for 30 minutes and tells the agent you are away (`/afk`).
- **[cache-keepalive](plugins/cache-keepalive/README.md)** keeps an idle session's prompt cache warm with a short ping, and ends on a handoff.
- **[stop-judge](plugins/stop-judge/README.md)** judges each early stop and nudges the agent to carry on; `/stop-judge derive` writes a `DECISIONS.md` of your own rules from your sessions.
- **[session-log](plugins/session-log/README.md)** keeps one markdown log per session, pruned at compaction, and ships the handoff and finish-session skills.
- **[session-summary](plugins/session-summary/README.md)** keeps a band above the prompt that says what the session is about, what it is doing now, and which files to open, written by a haiku call while a turn runs (`/session-summary`). Experimental; not in the bundle.
- **[morning-report](plugins/morning-report/README.md)** writes `status.md` each night from your sessions, one block per stream (its repo, what landed, what is left, who it waits on), and `patterns.md`, a dated catalog of what went well and what did not against a list you set (`/morning-setup`). Not in the bundle; its files live in its own data folder.
- **[stopstopping](plugins/stopstopping/README.md)** is a dependency list that installs the first four.

## Files

Everything the plugins write for you to read lives under `~/.claude/stopstopping/` (`STOPSTOPPING_DIR` replaces it), except morning-report's status and patterns, which live in its `dataDir` ([its README](plugins/morning-report/README.md#data-folder)):

- `DECISIONS.md`: your decision rules, derived from your sessions
- `DECISIONS.md.prev`: the previous `DECISIONS.md`, kept by `/stop-judge derive` when it overwrites the file
- `last-run.json`: the measured cost per turn of the last derive run, written by `/stop-judge derive` for the next estimate
- `context-off`: an empty flag file `/stop-judge context off` writes (removed by `context on`); while it exists the session-start hook does not print `DECISIONS.md`
- `logs/`: one log per plugin
- `session-logs/`: the session logs and their template
- `handoffs/`: handoff documents
- `session-summaries/`: one file per session of session-summary's calls, what each read and wrote

## Logs

Every mechanism appends one line per firing to its log. Read one back with `awk '{print $2}' ~/.claude/stopstopping/logs/<plugin>.log | sort | uniq -c`.

| Plugin | Log |
| --- | --- |
| dialog-timeout | `~/.claude/stopstopping/logs/dialog-timeout.log` |
| cache-keepalive | `~/.claude/stopstopping/logs/cache-keepalive.log` |
| stop-judge | `~/.claude/stopstopping/logs/stop-judge.log` |
| session-log | `~/.claude/stopstopping/logs/session-log.log` |
| session-summary | `~/.claude/stopstopping/logs/session-summary.log` |
| morning-report | `~/.claude/stopstopping/logs/morning-report.log` |

## Settings

Settings (the judge on or off, the dialog timeout) live in the engine's store under each plugin's name. A part keeps its settings whether installed alone or through the bundle.

## Contributing

Report a problem or ask a question in [Issues](https://github.com/federbenjamin/feder-plugins/issues). Pull requests are welcome.

Checks, from the repo root:

```
bash scripts/check.sh
```

`tsc` needs the engine's types, which an interactive `claude --plugin-dir plugins/<name>` load writes to `plugins/<name>/.claude-plugin/types/`; without them `check.sh` skips `tsc` and says so. Files under `hooks/shared/` and `tools/eval/hooks/judge/`, and the eval's two sample `.jsonl` fixtures, are generated: edit the source and run `node scripts/sync-shared.ts`. `node --test scripts/*.test.ts` runs the tests of the sync check, of the session-log directive script, of the stop-judge session-start hook, and of the one-definition check (the firing-log append, the state dir, the call pool, the model-call retry, the stored-settings reader and slash-command grammar, and the main-turn tracker live only in `shared/`). morning-report's Python tests run with `python3 -m unittest discover -s plugins/morning-report/scripts`; `check.sh` runs them too.

## License

MIT © Benjamin Feder. See [LICENSE](LICENSE).
