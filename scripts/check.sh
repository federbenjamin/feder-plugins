#!/usr/bin/env bash
# Every gate for the repo, from the repo root: per plugin test, tsc and validate (the bundle is a
# dependency list with no code: validate only), morning-report's Python tests, then the marketplace,
# the generated copies, the script tests, and the public-repo grep. Exits non-zero on the first failure.
set -eu
cd "$(dirname "$0")/.."

for dir in plugins/dialog-timeout plugins/cache-keepalive plugins/stop-judge plugins/session-log plugins/session-summary plugins/morning-report tools/eval; do
  [ -d "$dir" ] || continue
  echo "== $dir"
  claude plugin test "$dir"
  if [ -d "$dir/.claude-plugin/types" ]; then
    tsc -p "$dir"
  else
    echo "tsc: skipped for $dir (no .claude-plugin/types; load it once with claude --plugin-dir $dir)"
  fi
  claude plugin validate "$dir" --strict
done

echo "== plugins/morning-report python (extract, the plist, the prompt contracts)"
python3 -m unittest discover -s plugins/morning-report/scripts -q

echo "== plugins/stopstopping"
claude plugin validate plugins/stopstopping --strict

echo "== marketplace"
claude plugin validate . --strict

echo "== generated copies"
node scripts/sync-shared.ts --check

echo "== script tests (the sync check, directive.sh against log.ts, the stop-judge context hook against decisions.ts, one definition per shared shape)"
node --test scripts/*.test.ts

echo "== public paths"
if git ls-files -z --cached --others --exclude-standard -- . ':(exclude)scripts/check.sh' |
  xargs -0 grep -I -n -E '(/Users/|~/\.agents|\.agents/|agent-build|agent-docs|agent-surfaces|pain[-_]scan|session-todo-list|sessionLogPrune|stop-judge\.py|transcripts\.py|contract\.md|principles\.md|/grilling|linear-run)'; then
  echo "check: a tracked file names a private path or tool (above)" >&2
  exit 1
fi

echo "check: ok"
