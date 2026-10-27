# feder-plugins

Claude Code plugins by federbenjamin, in one marketplace: the mods that keep an agent working instead of stopping to ask, and the nightly status. Seven plugins: dialog-timeout, cache-keepalive, stop-judge, session-log, session-summary (experimental, not in the bundle), morning-report (the nightly status and patterns catalog, not in the bundle), and the bundle `stopstopping` (a dependency-only plugin: no code, no copies).

<!-- >>> git-workflow (generated block; do not edit by hand) -->
## Git workflow

- `main` changes only through a PR, squash-merged.
<!-- <<< git-workflow -->

## Project state

- 2026-10-20: public and installable; the maintainer is the only known user. Retires at the first report from another user.
- 2026-10-20: reads the user's own Claude Code transcripts on their machine only, on an explicit /stop-judge derive; writes under ~/.claude/stopstopping/. The only data that leaves is the model calls the judge (the transcript tail, to haiku), derive (typed turns) and session-summary (a tail window of the session's messages or its session-log file, to haiku, on a timer, in interactive sessions) make through Claude Code's own model connection. Does not retire: a fact of the product.
- 2026-10-26: morning-report reads the user's own transcripts of the last run's window each night (or on /morning-run), and sends them to `summaryModel` and the summaries to `reportModel` through Claude Code's own model connection; it writes only inside its `dataDir`, plus its firing log. Never commit a status, a summary, a transcript, or an extract to this repo. Does not retire: a fact of the product.

## Conventions

- Mod code: `$` only in hooks files (`hooks/register.ts` and the I/O modules it imports, `hooks/shared/record.ts` among them); decisions live in pure modules, exported from the other `hooks/*.ts` and tested in `tests/*.test.ts`.
- Transcript parsing that reads whole files lives in a script the mod runs (morning-report's `scripts/extract.py`), not in the mod: `$.fs.read` caps a file at 4 MiB and a hook gets 10 s of its own CPU.
- Generated copies: `hooks/shared/`, `tools/eval/hooks/judge/` and `tools/eval/fixtures/*.sample.jsonl` (from `fixtures/samples.ts`) are written by `scripts/sync-shared.ts`. Edit the source, run `node scripts/sync-shared.ts`, commit both; `scripts/check.sh` fails on drift.
- Logs: every mechanism appends one line per firing to `~/.claude/stopstopping/logs/<plugin>.log` in `shared/firing.ts`'s line shape; its README names the read-back command.
- Checks: `bash scripts/check.sh` before every push.

## Don'ts

- Public repo: nothing tracked names a path on a maintainer's machine or a private tool; `scripts/check.sh` greps for them.
