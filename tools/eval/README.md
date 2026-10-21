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

3. **Run and score** the judge over the graded ids, both arms side by side:

   ```
   claude --plugin-dir tools/eval --setting-sources "" -p "/eval-judge --key tools/eval/out/records.jsonl --ids <ids file> --graders <folder of grade-out-*.jsonl> --out tools/eval/out/<date>-<name>.jsonl --arms off,on --repeats 2 --workers 4"
   ```

   Calls: records × arms × repeats (190 × 2 × 2 = 760 haiku calls). `--arms` is `off`, `on`, or `off,on` (the default); `off` is the round-3 request alone, `on` adds the minutes fact (below). `--repeats` (default 2) runs every arm that many times, so the run measures its own noise. A record's arms are sent side by side, so both meet the same API conditions. `--key` takes the extract's JSON lines or a JSON object of records by id; `--graders` takes a folder (its `grade-out-*.jsonl`) or one grades file. `--setting-sources ""` keeps the installed plugins from loading beside it. Keep the `--out` file: it is the run's raw output.

`tools/eval/out/` is ignored by git. Records and grades come from real transcripts: never commit them. `fixtures/records.sample.jsonl` and `fixtures/grades.sample.jsonl` are synthetic: eight records and their grades, the shapes above. Their source is `fixtures/samples.ts`, which the tests import; edit it and run `node scripts/sync-shared.ts` to rewrite the two files (`--check` fails on drift).

## Output

`/eval-judge` writes one line per call to `--out`: `{ id, arm, repeat, live, new, new_outcome, conf, shape, reason, text, ms, error, usage, prompt, minutes_since_operator, is_lower_bound }`. `text` is the model's whole reply and `prompt` the whole user message it was sent; the system prompt is `PROMPT` in `plugins/stop-judge/hooks/prompt.ts`, plus `MINUTES_SENTENCE` from `judge.ts` on the `on` arm. `live` is the logged outcome; `new_outcome` is what the judge would log now (`continue` is a nudge). It answers:

```
calls n: r records × a arms × k repeats; errors n
live (logged at the firing): false-block a/b = x% | catch c/d = y%
off #1: false-block a/b = x% | catch c/d = y%          (one line per arm and repeat)
noise, records that differ between two repeats of one arm: off x, on y
arms, records that differ between off and on in one repeat: z
graded stop: on blocks more on n, off on m, sign test p=…
graded continue: on catches more on n, off on m, sign test p=…
by gap (…):
  <5: stop n, continue m | off false-block a/b catch c/d | on … | on vs off: stop +a/-b continue +c/-d
  …                                                    (5-29, 30-119, 120+, none)
off false blocks: [<id> <case> <blocks>/<calls>, …]
off misses: [<id> <grade confidence> <case> <blocks>/<calls>, …]
differ, read these by hand: [<id> <grade> <gap> off a/k on b/k, …]
minutes cut at the judge's read: n | at the log stamp: m | no transcript: t
system prompt: …
written <out>
```

A false block is a `continue` on a record graded `stop`; a catch is a `continue` on one graded `continue`. Calls with an error (timeout, API error, no verdict, a `continue` with no reason) are counted under `errors` and left out of every ratio.

**Reading it.** The arms are compared with each other, not with an earlier run: the `off` arm in the same run is the baseline. An arm difference counts only past the noise: when `arms` is no larger than `noise`, and the sign tests are far from small, the run measured no change, whichever way the ratios lean. The graders' labels are not the authority over the arms: read every `differ` record's two replies in the `--out` file before concluding. The minutes fact can only change a verdict where the gap says something, so the `by gap` lines carry the effect; a bucket with a handful of graded `continue` records cannot show one.

**The minutes fact.** Each record's fact is computed once, from the session's transcript (found by session id, as the judge finds it), and both arms' calls carry it in the run file; only the `on` arm sends it. It is the fact the judge would send at that firing, from the 8 MB tail it read then. The transcript has grown since (on the recorded set the firing time lies before today's last 8 MB for 81 of 190 records), so the run reads every line with its byte offset (`grep -a -b ''`) and rebuilds the file as the judge read it: the judge reads right after the turn's last agent row with text, so the file ends at that row (the last one timed no later than 2 s past the firing log's stamp), and the judge's clock is that row's time. Rows written after it, while the judge called the model (its nudge, a prompt the operator sent then), are not in it. The run cuts the last 8 MB as `tail -c` does and applies the judge's own `minutesFact`: the exact gap when a typed row is in that tail, else "more than" the minutes since its oldest row. A firing with no agent row (`at the log stamp`) falls back to every line timed before the stamp, with the stamp as the clock. A record whose transcript is gone is judged without the fact and counted under `no transcript`.

## Baseline

None carried between runs. Round 3's recorded numbers (8/168 false blocks, 7/22 catches) came from an earlier harness that replaced the whole system prompt, not the production path, and one run of the fact on this path (9/168, 8/22) was compared against them: that comparison mixed the path, the fact, and haiku's run-to-run noise, and measured none of them. A run's `off` arm is its baseline.

## Checks

`claude plugin test tools/eval` runs `tests/`; `bash scripts/check.sh` runs it with `tsc` and `validate`.
