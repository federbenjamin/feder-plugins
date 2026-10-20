# stop-judge-eval

Dev tooling, never installed: it measures the stop judge (`plugins/stop-judge`) over firings a person has graded, so a prompt change ships only after it is measured. It is a mod, not a script, because production calls the model through `$.model.complete`, which prepends the CLI's identity block to the system prompt; `claude -p --system-prompt` would replace it and measure a different request. It is not listed in `.claude-plugin/marketplace.json`. Load it with `--plugin-dir` only.

`hooks/judge/` is a generated copy of the judge's `judge.ts`, `prompt.ts` and `hooks/shared/` (a plugin cannot import outside its folder): edit `plugins/stop-judge`, then run `node scripts/sync-shared.ts`. The run builds every request with the judge's own `buildSystem`, `buildUser`, `parseVerdict` and `decide`, and sends the production request: haiku, 300 tokens, effort low, 20 s timeout.

## Steps

1. **Extract** the judged stops from a stop-judge firing log (`~/.claude/stopstopping/logs/stop-judge.log`). Each record holds what the judge saw at that firing, rebuilt from the session's transcript with the judge's own parser: `final` (the agent's last message), `opening` (the message that opened the turn), `context_users` (the earlier operator messages it was shown), plus `id`, `ts`, `session`, `outcome`, `judge_reason`. Ids are `F<line index of the log>`. A firing whose transcript is gone gets `final: null`.

   ```
   claude --plugin-dir tools/eval --setting-sources "" -p "/eval-extract --log $HOME/.claude/stopstopping/logs/stop-judge.log --out tools/eval/out/records.jsonl"
   ```

   Paths are not expanded by the command (no `~`); a relative one is under the session's directory.

2. **Grade** a sample of the records blind (without `outcome` or `judge_reason`) by [`rubric.md`](rubric.md): one JSON line per record, `{"id","verdict","case","confidence","reason"}`, into `grade-out-<n>.jsonl` files in one folder. Graders may be people or strong models; the recorded baseline used three Opus graders.

3. **Run and score** the judge over the graded ids:

   ```
   claude --plugin-dir tools/eval --setting-sources "" -p "/eval-judge --key tools/eval/out/records.jsonl --ids <ids file> --graders <folder of grade-out-*.jsonl> --out tools/eval/out/run.jsonl --workers 4"
   ```

   One model call per id. `--key` takes the extract's JSON lines or a JSON object of records by id; `--graders` takes a folder (its `grade-out-*.jsonl`) or one grades file. `--setting-sources ""` keeps the installed plugins from loading beside it.

`tools/eval/out/` is ignored by git. Records and grades come from real transcripts: never commit them. `fixtures/records.sample.jsonl` and `fixtures/grades.sample.jsonl` are synthetic: eight records and their grades, the shapes above.

## Output

`/eval-judge` writes one line per id to `--out`: `{ id, live, new, new_outcome, conf, shape, reason, ms, error, usage, minutes_since_operator }`. `live` is the logged outcome; `new_outcome` is what the judge would log now (`continue` is a nudge). It answers:

```
live: false-block a/b = x% | catch c/d = y%
new: false-block a/b = x% | catch c/d = y%
high-confidence continue caught: live n new m of k
new false blocks: [<id> <case> <confidence>, …]
new misses: [<id> <grade confidence> <case>, …]
errors n
no transcript: n
minutes fact: on|off
written <out>
```

A false block is a `continue` on a record graded `stop`; a catch is a `continue` on one graded `continue`. Records with an error (timeout, API error, no verdict, a `continue` with no reason) are counted under `errors` and left out of every ratio.

**The minutes fact.** While `MINUTES_FACT` is on in `plugins/stop-judge/hooks/judge.ts`, each request states the minutes since the operator's last typed message. The run computes it per record from the session's transcript (found by session id, as the judge finds it): the newest typed row before the firing's `ts`. The whole transcript is read through a `grep` pre-filter, not the judge's 8 MB tail: on the recorded set the firing time lies before the tail's start for 81 of 190 records. A record whose transcript is gone is judged without the fact and counted under `no transcript`.

## Baseline

Round 3 of the judge prompt (the shipped `PROMPT`, no per-user text), over 190 graded firings (168 graded stop, 22 graded continue): **8/168 false blocks, 7/22 catches, 167/190 agree**. Haiku varies by about 3 records between runs of the same 190, so a change inside that band is no measured change.

## Checks

`claude plugin test tools/eval` runs `tests/score.test.ts`; `bash scripts/check.sh` runs it with `tsc` and `validate`.
