#!/usr/bin/env bash
# SessionStart command hook: prints the session-log directive (one line) and, when the session
# continues (after a compaction or a resume), the log's current view, so open todos and standing
# rulings reach the agent without a read call. Reads session_id and source from the hook's stdin
# JSON; never fails (a hook error would surface as session noise). printf only: no heredoc.
INPUT=$(cat 2>/dev/null || true)
SID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$SID" ] || SID="unknown-$(date -u +%Y%m%dT%H%M%SZ)"
SOURCE=$(printf '%s' "$INPUT" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
DIR="${STOPSTOPPING_DIR:-$HOME/.claude/stopstopping}"
LOG="$DIR/session-logs/${SID}.md"
printf '%s\n' "SESSION LOG — the session-log plugin keeps this session's log; never edit its files. Record with its tools as things happen: todo_add for work that will outlast the turn and todo_close the moment it is done, decide for each choice you make (the pick, what it was chosen over, why), ruling for the operator's own typed words, note for a finding that lives nowhere else. What you did (files, commits, pushes, pull requests) is recorded for you. log_read returns the open todos, the standing rulings and decisions and the recent work, for this session or another by id; read it before other work in a session that continues one. ${LOG} is a view the plugin rewrites after every write. Main session only."
if [ "$SOURCE" = "compact" ] || [ "$SOURCE" = "resume" ]; then
  # Only a log the plugin wrote: a `.md` with no store beside it was kept by hand.
  if [ -f "$DIR/session-logs/${SID}.jsonl" ] && [ -f "$LOG" ]; then
    printf '%s\n' "SESSION LOG VIEW —"
    cat "$LOG" 2>/dev/null
  fi
fi
exit 0
