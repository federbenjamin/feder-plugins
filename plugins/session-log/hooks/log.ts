import { sessionLogPath, sessionLogsDir } from './shared/firing'

// Where a session's log files sit, and the directive the SessionStart hook prints.

// `incoming` is the store as it is being written, moved over `store` once it is whole.
export function logPaths(dir: string, sessionId: string): { view: string; store: string; incoming: string; legacy: string } {
  const base = sessionLogsDir(dir)
  return { view: sessionLogPath(dir, sessionId), store: `${base}/${sessionId}.jsonl`, incoming: `${base}/${sessionId}.jsonl.tmp`, legacy: `${base}/${sessionId}.legacy.md` }
}

// scripts/directive.sh prints this sentence; scripts/sync-shared.ts checks the two agree.
export function directiveText(viewPath: string): string {
  return `SESSION LOG — the session-log plugin keeps this session's log; never edit its files. Record with its tools as things happen, since a later reader has only the log: todo_add for anything left open (work that will outlast the turn, and every question, confirmation or choice you leave with the operator) and todo_close the moment it is settled; decide for each choice you make, small ones included (the pick, what it was chosen over, why); ruling for the operator's own typed words; note for a finding or a check that lives nowhere else (what you measured, how you verified). What you did (files, commits, pushes, pull requests) is recorded for you. log_read returns the open todos, the standing rulings and decisions and the recent work, for this session or another by id; read it before other work in a session that continues one. ${viewPath} is a view the plugin rewrites after every write. Main session only.`
}
