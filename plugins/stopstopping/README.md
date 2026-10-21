# stopstopping

Installs four plugins that keep an agent working instead of stopping to ask. This plugin holds no code of its own: it is a dependency list, so installing it installs each part under its own plugin name.

- **dialog-timeout** ends a turn left on a permission prompt or question for 30 minutes and tells the agent you are away (`/afk`).
- **cache-keepalive** keeps an idle session's prompt cache warm with a short ping, and ends on a handoff.
- **stop-judge** judges each early stop and nudges the agent to carry on; `/stop-judge derive` writes a `DECISIONS.md` of your own rules from your sessions.
- **session-log** keeps one markdown session log per session, pruned at compaction, and ships the handoff and finish-session skills.

## Install

```
claude plugin marketplace add federbenjamin/stopstopping
claude plugin install stopstopping@stopstopping
```

Or install a single part by its name: `claude plugin install stop-judge@stopstopping`. A part keeps its own plugin name and settings whether installed alone or through this plugin, and installing a part beside this plugin changes nothing.

See the [repository README](../../README.md) for the files the parts write and their logs.
