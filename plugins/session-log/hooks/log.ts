import { sessionLogPath, sessionLogsDir } from './shared/firing'

// Where a session's log files sit, and the directive the SessionStart hook prints.

export function logPaths(dir: string, sessionId: string): { view: string; store: string; legacy: string } {
  const base = sessionLogsDir(dir)
  return { view: sessionLogPath(dir, sessionId), store: `${base}/${sessionId}.jsonl`, legacy: `${base}/${sessionId}.legacy.md` }
}

// scripts/directive.sh prints this sentence; scripts/sync-shared.ts checks the two agree.
export function directiveText(viewPath: string): string {
  return `SESSION LOG — the session-log plugin keeps this session's log; never edit its files. Record with its tools as things happen: todo_add for work that will outlast the turn and todo_close the moment it is done, decide for each choice you make (the pick, what it was chosen over, why), ruling for the operator's own typed words, note for a finding that lives nowhere else. What you did (files, commits, pushes, pull requests) is recorded for you. log_read returns the open todos, the standing rulings and decisions and the recent work, for this session or another by id; read it before other work in a session that continues one. ${viewPath} is a view the plugin rewrites after every write. Main session only.`
}
