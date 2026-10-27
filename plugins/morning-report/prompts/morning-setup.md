The morning-report mod sent this prompt for the person at this keyboard. Interview them in one round, then write their morning-report profile.

Each night the mod writes two files from the day's Claude Code sessions. The status lists every stream of work and where it stands; it needs no profile. The patterns catalog adds one dated entry a day: what went well and what did not, judged only by the profile's Watch for list. The profile is that list. A profile whose Watch for reads `(none)` keeps the status and skips the catalog.

# Their profile now

{{PROFILE}}

# How to run the interview

- When the profile above is not `(none yet)`, show its Watch for list to them first. The round then confirms or changes it; never start blank. Other headings an older profile holds are left out of the new one.
- Before writing, when `{{DATA_DIR}}/profile.md` exists, copy it to `{{DATA_DIR}}/profile-{{TODAY}}-old.md`.

First: may the mod read their sessions?
The mod can read their recent Claude Code sessions and show the habits it
sees, as a starting point for the list. This is what it would read: {{PREVIEW}}
When that reads `(no sessions…`, there is nothing to read: say so in one
line and go to the round.
Otherwise show them that line. Ask with AskUserQuestion whether to read
their sessions, and for how many days, from 1 to 7, or to skip it. Fewer
days cost fewer calls.

Then the scan, only if they said yes. Call the `morning_setup_scan` tool
with the number of days they chose. Tell them it takes a few minutes. When
it returns a file path, read that file: its Habits are the starting point
for the round. A note may follow the path, such as how many sessions were
not summarized; the path is still the scan, so pass the note on in one line
and go on. When they skipped, when there was nothing to read, or when the
tool returned anything but a file path (tell them in one line what it
returned), the round starts from their own words alone.

The round: what the catalog should watch for.
Show the scan's habits when there is a scan. Find out which moments in
their work they want the catalog to notice each day, going well or not:
habits to keep, mistakes that repeat, how the agents work with them. Ask one
open question at a time, with AskUserQuestion when options help and free
text when they do not.
Done when you have a short list, one item a line, in their words, or they
say they want none.

Then write {{DATA_DIR}}/profile.md under exactly this heading, in their
words, with `## ` and the heading alone on its line; the words after the
dash say what goes under it. Write `(none)` under it when they want none.

{{PROFILE_HEADINGS}}

Show it to them once. Then tell them: run `/morning-setup schedule` to have the status written each night (macOS; elsewhere, run `claude -p /morning-run` by hand). Then stop.
