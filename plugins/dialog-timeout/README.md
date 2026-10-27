# dialog-timeout

<p align="center"><strong>Ends a Claude Code turn left waiting on a permission prompt or question for 30 minutes, and tells the agent you are away</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/federbenjamin/feder-plugins" alt="License"></a>
</p>

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin for people who leave the agent working while they step away. When the agent stops on a permission prompt or a question and nobody answers, the session sits there for hours. This plugin waits 30 minutes, ends that turn, and sends the agent `automessage: user is /afk`. The `afk` skill that comes with it then has the agent carry on without you instead of waiting.

## Install

Needs Claude Code; tested on 2.1.295. This is one part of the [feder-plugins](../../README.md) marketplace: install `stopstopping`, which installs this plugin under its own name as a dependency, or this plugin alone; installing both changes nothing.

```
claude plugin install dialog-timeout --marketplace federbenjamin/feder-plugins
```

It starts in the next interactive session, with a 30-minute timeout.

## Features

- **Unblocks an unattended session.** A permission prompt or question left open for the set time ends the turn. The agent then gets `automessage: user is /afk` as your next message.
- **Comes with the `afk` skill.** It tells the agent to keep working through what is queued, decide what it can, write the questions only you can answer to `afk-questions.md` (in `docs/afk/` unless your agent instructions name a folder for docs), and end with a handoff doc beside it. Run `/dialog-timeout:afk` yourself when you step away.
- **Leaves you alone while you are there.** It only counts while a turn is running and a dialog holds the prompt box. Answer the dialog and the count starts over.
- **One setting for every session.** `/dialog-timeout` changes the minutes, or turns it off, in every open and future session at once. One session can take its own minutes from `DIALOG_TIMEOUT_MINUTES`.
- **Shows when it acts.** The status line says when it ended a turn, and shows `dialog-timeout off` while it is off.

## Usage

```
/dialog-timeout 10
```

| Command | Effect |
| --- | --- |
| `/dialog-timeout <minutes>` | Set the timeout, in whole minutes, and turn it on |
| `/dialog-timeout off` | Dialogs wait for you, in every session |
| `/dialog-timeout on` | Turn it back on at the last set minutes |
| `/dialog-timeout` | Show the current setting |

### One session's own minutes

Set `DIALOG_TIMEOUT_MINUTES` in the environment a session starts in to give that session its own minutes:

```
DIALOG_TIMEOUT_MINUTES=2 claude
```

That session uses those minutes in place of the stored ones, and every other session keeps the stored ones. A script that starts unattended sessions can set it so they give up sooner. `/dialog-timeout off` still wins: while it is off, no session ends a turn, whatever the variable says. In that session, `/dialog-timeout` shows the stored setting and adds `(this session: 2 min, from DIALOG_TIMEOUT_MINUTES)`, and setting minutes there changes the stored ones for the other sessions. A value that is not a whole number of at least 1 is ignored.

## How it works

Every 30 seconds while a turn runs, the plugin asks Claude Code's prompt box whether a dialog holds it. The dialog's age counts from the first check that saw it, so a timeout fires up to 30 seconds late. When the dialog has been open for the set minutes, the plugin ends the turn, closing the dialog unanswered, and submits the away message as you.

- **Headless runs.** `claude -p` and other non-interactive sessions are never touched.

## Log

Every firing appends one line to `~/.claude/stopstopping/logs/dialog-timeout.log` (`STOPSTOPPING_DIR` replaces the folder):

```
<utc> <outcome> session=<id> ms=<n> reason=<text>
```

Outcomes: `afk` (a dialog stayed open for the set minutes and the turn ended with `/afk`) and `afk-failed` (the turn could not be ended).

Read it back:

```
awk '{print $2}' ~/.claude/stopstopping/logs/dialog-timeout.log | sort | uniq -c
```

## Settings

The settings live in the engine's store under this plugin's name, so they carry whether it is installed alone or through the `stopstopping` bundle.

## Contributing

Report a problem or ask a question in [Issues](https://github.com/federbenjamin/feder-plugins/issues). Pull requests are welcome.

Run the plugin from a checkout with `claude --plugin-dir plugins/dialog-timeout`, which also writes the engine types `tsc -p` reads. Checks, from the repo root:

```
claude plugin test plugins/dialog-timeout
tsc -p plugins/dialog-timeout
claude plugin validate plugins/dialog-timeout --strict
```

## License

MIT © Benjamin Feder. See [LICENSE](LICENSE).
