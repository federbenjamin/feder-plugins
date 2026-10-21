# stopstopping

A Claude Code marketplace of mods that keep an agent working instead of stopping to ask: dialog-timeout, cache-keepalive, stop-judge, session-log, and the bundle `stopstopping` (a dependency-only plugin: no code, no copies).

<!-- >>> git-workflow (generated block; do not edit by hand) -->
## Git workflow

- `main` changes only through a PR, squash-merged.
<!-- <<< git-workflow -->

## Project state

- 2026-10-20: public and installable; the maintainer is the only known user. Retires at the first report from another user.
- 2026-10-20: reads the user's own Claude Code transcripts on their machine only, on an explicit /stop-judge derive; writes under ~/.claude/stopstopping/. The only data that leaves is the model calls the judge (the transcript tail, to haiku) and derive (typed turns) make through Claude Code's own model connection. Does not retire: a fact of the product.

## Rules

- Mod code: `$` is passed to functions only in `hooks/register.ts`; pure logic is exported from the other `hooks/*.ts` and tested in `tests/*.test.ts`.
- Generated copies: `hooks/shared/` and `tools/eval/hooks/judge/` are written by `scripts/sync-shared.ts`. Edit the source, run `node scripts/sync-shared.ts`, commit both; `scripts/check.sh` fails on drift.
- Logs: every mechanism appends one line per firing to `~/.claude/stopstopping/logs/<plugin>.log` in `shared/firing.ts`'s line shape; its README names the read-back command.
- Public repo: nothing tracked names a path on a maintainer's machine or a private tool; `scripts/check.sh` greps for them.
- Checks: `bash scripts/check.sh` before every push.
