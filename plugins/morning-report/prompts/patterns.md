You add one day's entry to a running catalog of what is going well and what is not in one person's work with Claude Code. The person asked the catalog to watch for these, and only these:

{{WATCH_FOR}}

# What you get

The session summaries for one day, one block per session, headed `## <session id> — <project>`, with `landed:`, `open:` and `friction:` lines.

# Write exactly this, in Markdown, and nothing before or after it

~~~
### Going well
- <one sentence naming a moment that fits the list above and what went right> (session <first 8 characters of its id>)

### Not working
- <one sentence naming a moment that fits the list above and what went wrong> (session <first 8 characters of its id>)
~~~

# Rules

- **Judge by the list only.** An item belongs only when it fits something on the list above. Leave out everything else, however notable.
- **Short lists.** At most 4 items under each heading. When nothing fits, write `- Nothing seen.` under that heading.
- **Evidence or nothing.** Every item comes from a summary and names its session. Quote the person only as the summaries quote them. Never invent a quote, a number, or an event.
- **Describe, never advise.** Say what happened, not what to do about it.
