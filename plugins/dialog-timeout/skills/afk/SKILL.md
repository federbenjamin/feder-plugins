---
name: afk
argument-hint: "[optional priorities or notes before leaving]"
description: The human is leaving — switch to unattended mode and keep working through everything queued without stopping. Use when the user says "/afk", "I'm leaving", "going afk", "heading out — keep going", "keep working while I'm gone", or otherwise hands off the queued work to continue without them, and stay in this mode until they return.
---

The human is away. Work through everything queued in this session, any priorities passed with the command first, without stopping to ask: no "shall I proceed?", no waiting for confirmation on a reversible step. Standing rules (git safety, approval flows, secrets) still apply; this mode changes pacing, never permissions.

The run ends only when the queue is exhausted. Until then, a status note, summary, or finished milestone goes in the same message as the next tool call. When everything left waits on background work, let it run in the background and pause; its exit wakes you.

## Deciding

Decide by default: a reversible step, anything a rule file, plan, ticket, or the code answers, and any near-tie. Log each as one line under Decisions in the questions file.

Write down a question only for a product decision nothing in the repo answers. Park the work that waits on it and go on with the rest. Blocked items that share one unknown are one question naming each of them.

Write to the file at once: compaction loses a question held only in the chat. The file is `afk-questions.md` in the folder your instructions name for documents for the user, else `docs/afk/` in the repo:

```markdown
# Decisions
- <what you chose> — <why, one line>

# Open questions

## Q1 — <short title>
- Context: what was being done, why it blocked
- Question: the decision needed
- Recommendation: your answer and why
- Parked: what work waits on this
```

When later work answers an open question, move it to Decisions with the answer.

## Ending the run

When every item is done, blocked, or parked, in this order:

1. **Write a handoff doc** beside the questions file: what was done, what is parked and why, the next step, and the questions file's path. It is the run's record; the chat is not.
2. **Stop every background shell you started** (dev servers, watchers, tails, long polls), or name one that must keep running and say why. Remove nothing else: a file the run made that the repo should not keep (a test-only hook or agent definition, an index) moves into the handoff doc's folder.

Then end with one message: the handoff path and the shells you stopped, nothing else.

## When the human returns

An automatic message, such as `automessage: user is /afk`, does not end unattended mode: keep working. The next message the human types does: point them at the handoff doc and the questions file, answer what they ask, and resume parked work as answers arrive.
