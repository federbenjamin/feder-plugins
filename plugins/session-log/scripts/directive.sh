#!/usr/bin/env bash
# SessionStart command hook: prints the session-log directive (one line) and, after a compaction,
# the mod's prune result for that compaction. Reads session_id and source from the hook's stdin
# JSON; never fails (a hook error would surface as session noise). printf only: no heredoc.
INPUT=$(cat 2>/dev/null || true)
SID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$SID" ] || SID="unknown-$(date -u +%Y%m%dT%H%M%SZ)"
SOURCE=$(printf '%s' "$INPUT" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
DIR="${STOPSTOPPING_DIR:-$HOME/.claude/stopstopping}"
LOG="$DIR/session-logs/${SID}.md"
TPL="$DIR/session-logs/TEMPLATE.md"
printf '%s\n' "SESSION LOG — keep ${LOG} in the format of ${TPL}; each section comment says what goes in it. Missing: create it from the template at the first real request, or copy the log a handoff doc names. Present: read it before other work; it is the memory across compaction. Append as things happen, never rewrite a line, and update it before ending a multi-step turn. Main session only."
if [ "$SOURCE" = "compact" ]; then
  # The mod logs one prune, prune-skipped or prune-failed line per compaction: only when the
  # newest of them is a prune did this compaction move lines.
  PRUNED=$(grep -a -E " prune(-skipped|-failed)? session=${SID} " "$DIR/logs/session-log.log" 2>/dev/null | tail -1 | sed -n 's/^[^ ]* prune session=.* reason=moved=\([0-9]*\) archive=\(.*\)$/\1 \2/p')
  if [ -n "$PRUNED" ]; then
    printf '%s\n' "SESSION LOG PRUNE — moved ${PRUNED%% *} lines → ${PRUNED#* }"
  fi
fi
exit 0
