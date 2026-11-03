# stall-notice

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that tells a session when one of its subagents may be hung.

A subagent stuck on a tool call sends no error and no completion notification, so the session that started it can wait on it indefinitely.

## Install

This is one part of the [feder-plugins](../../README.md) marketplace. It is not in the `stopstopping` bundle.

```
claude plugin install stall-notice --marketplace federbenjamin/feder-plugins
```

It starts in the next interactive session.

## What it does

- **Times every subagent tool call.** It measures from the call's start to its result. Its 30-second timer runs only while a subagent is in a turn, so it does no work when no subagent is running.
- **Sends one notice per stuck call.** At 5 minutes it sends a prompt to the main session naming the subagent and the tool. The prompt starts a turn once the session is idle, so a hung foreground subagent, which keeps the session busy, gets no notice until that ends.
- **Skips calls that are not stalls.** A subagent idle between turns has no running call, so it is never flagged. A nested Agent call is not timed, because it runs as long as its agent does. Time the machine spent asleep does not count.
- **Leaves the decision to the agent.** It stops nothing. The notice asks the session to check the subagent's work and stop it if it is stuck.

A plugin reload stops timing the calls running at that moment. `claude -p` and other non-interactive sessions are not watched.

## Log

One line per firing goes to `~/.claude/stopstopping/logs/stall-notice.log`: `notice` for each call in a sent notice, `submit-failed` when the prompt could not be sent. Lines hold the agent id and tool name, never the call's input. Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/stall-notice.log | sort | uniq -c
```

## License

MIT © Benjamin Feder. See [LICENSE](LICENSE).
