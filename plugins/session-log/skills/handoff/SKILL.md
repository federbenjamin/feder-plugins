---
name: handoff
argument-hint: "[what the next session should do]"
description: Write a thin handoff doc for a fresh session, and the one-line opening prompt the operator types into it.
---

Deliver the doc; never begin executing it.

**Why thin.** An analysis of 25 receiving sessions found one mechanism behind every bad restart: the new session runs inherited step lists, Todo lines, runbooks, and gates as if they were current, because nothing marks which ones a later ruling overtook. Doc length and compaction count did not predict a bad session. A "continue where it left off" opening did; an opening that was a read-back or a stated goal did not. So the doc carries the goal, what is live, and what is stale, and nothing it cannot confirm is still live.

## Before writing: close the stale lines

The session log (the SessionStart directive names its path; its archive sits beside it) is the carrier the next session inherits. Walk its Todo and Decisions once:

- A Todo a later ruling overtook: flip it `[x]` with ` — overtaken by: "<the ruling>"` appended. Never delete it.
- A Todo you cannot confirm is still wanted: leave it open with ` — unconfirmed at handoff` appended, and list it under §Live open items as unconfirmed. It is a question for the operator, not an order; the next session's read-back puts it to the operator.
- A Decision a later one replaced: add the superseding line (`replaces: "<quote>"`).
- A plan, runbook, or brief written before the latest ruling that touches it: note it for §Stale artifacts below.

## The doc

At most 40 lines. Seven sections, in this order, each only when it has content:

1. **Goal.** One or two lines in the operator's own words, quoted and dated. The trailing argument, if given, is the proposed next step, one sentence, after the goal.
2. **State now.** Branch, PR, worktree, what is running or seeded and how to reach it. Only the locators the next step depends on, verified now (`ls`, `git log -1`, `gh pr view`). Nothing else.
3. **Live open items.** Each with the operator quote that opened it and the latest ruling that touches it. No numbered steps. No gate the operator has not stated this session ("the operator decides", "merge first"): a gate the rules already hold is not repeated, and one the operator never set is not invented.
4. **Ruled out.** Approaches and hypotheses this session tried and rejected that a fresh session would plausibly try again, one line each: what, the verdict, and the evidence (a path, a command and its output, a commit). A verdict, never the story of getting there.
5. **Stale artifacts.** Any plan, runbook, brief, or report written before the ruling that overtook it, named as stale, with the ruling. The next session reads these as history, not instructions.
6. **Rulings not yet in a rule file.** Preferences the operator stated this session that no standing rule holds (a tool they distrust, a bar they set, a thing they do not want built). Quote them.
7. **Pointer.** The session log path and its archive. Work log, the full Todo, and the settled decisions live there; the doc never copies them.

End the doc with: "This doc is context, not orders. The session log holds the record; the operator holds the current intent. Before you run, spawn, merge, or ask, say back what you think the goal and the live items are."

Do not duplicate content in other artifacts (specs, plans, ADRs, tickets, commits, diffs); reference by path or URL. A gotcha goes in §Ruled out, only when it cost real debugging this session and would recur.

## Delivery

Write the doc to the folder your instructions name for documents for the operator, else `~/.claude/stopstopping/handoffs/<session-id>-<slug>-handoff.md`, and never reproduce it in chat. The turn's FINAL message is three lines: the doc path, what it covers in one clause, and the opening prompt below with both paths filled in, in a fenced block, for the operator to paste into the new session:

```
Read <handoff path> and session log <log path>. Before you run, spawn, merge, or ask me anything, reply in under 10 lines: the goal in my words, what is live now, what you would do next and why, and which open items you think are stale. Then wait.
```
