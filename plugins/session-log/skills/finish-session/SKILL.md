---
name: finish-session
description: Close a session with nothing left silent: every leftover done, or listed as open to do and handed off.
---

A session closes when every leftover is done or on the open list. Nothing stays as a `Next:` line, a hand-back candidate, or a hunch in your context.

## 1. Sweep

The session log is the record; a leftover found anywhere else is a logging gap, so append it there first. Read:

- the session log: open Todo lines, and Decisions that deferred something;
- this conversation: `Next:` lines, the "candidates, not done" from subagent hand-backs, a defect found during a change and left, and `afk-questions.md` when the session ran unattended;
- live state: a branch, worktree, PR, spawn, or background shell of this session still open.

Done when every item is a Todo line in the session log.

## 2. Close what is small

Done now if it is minutes of reversible work answered by a rule or the code (an archive, a copy, a doc row, a one-line fix). Take it, log one line. Everything else is open to do. A product decision or a history rewrite goes on the open list as one whole question, recommendation first.

## 3. Verify and report

Worktrees removed, spawns and shells stopped, the install green where setup changed; a branch or PR still open is an open item. Flip each done Todo line in the session log (`— done`).

Turn off the cache-keepalive pings for this session: call the `mcp__cache-keepalive__keepalive_off` tool (load it with ToolSearch when it is deferred). Absent, cache-keepalive is not installed: skip this.

## 4. Hand off only what is open

Open to do is empty: no handoff; the session is finished. Anything open: run the `handoff` skill, so a fresh session can pick the open items up.

End the message with exactly these two lists, followed by the handoff's three closing lines when there was one, and nothing else:

```
Done:
- <item>

Open to do:
- <item>
```
