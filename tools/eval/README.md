# stop-judge-eval

Dev tooling, never installed: it measures the stop judge (`plugins/stop-judge`) over firings a person has graded, so a prompt change ships only after it is measured. It is a mod, not a script, because production calls the model through `$.model.complete`, which prepends the CLI's identity block to the system prompt; `claude -p --system-prompt` would replace it and measure a different request. It is not listed in `.claude-plugin/marketplace.json`. Load it with `--plugin-dir` only.

`hooks/judge/` is a generated copy of the judge's `config.ts`, `decide.ts`, `input.ts`, `judge.ts`, `plan-io.ts`, `prompt.ts` and `hooks/shared/` (a plugin cannot import outside its folder): edit `plugins/stop-judge`, then run `node scripts/sync-shared.ts`. The run builds every request with the judge's own `judgeRequest`, reads every reply with its `judgeOutcome`, and sends the production request: haiku, the fixed instructions marked for the prompt cache, 1024 tokens, effort low, 20 s timeout.

## Steps

1. **Extract** the judged stops from a stop-judge firing log (`~/.claude/stopstopping/logs/stop-judge.log`). Each record holds what the judge read at that firing, rebuilt from the session's transcript with the judge's own builder: `input` (the whole user message), `final` (the agent's last message), `opening` (the message that opened the turn, which the proposal check reads), `operator_text` (what the operator typed, which a quote is checked against), plus `id`, `ts`, `session`, `outcome`, `judge_reason`. Ids are `F<line index of the log>`. A firing whose transcript is gone gets `final: null`. A named plan is read as it is now, not as it was at the firing. A `stop-lowconf` line in an old log counts as judged.

   ```
   claude --plugin-dir tools/eval --setting-sources "" -p "/eval-extract --log $HOME/.claude/stopstopping/logs/stop-judge.log --out tools/eval/out/records.jsonl"
   ```

   Paths are not expanded by the command (no `~`); a relative one is under the session's directory.

2. **Grade** a sample of the records blind (without `outcome` or `judge_reason`) by [`rubric.md`](rubric.md): one JSON line per record, `{"id","verdict","case","confidence","reason"}`, into `grade-out-<n>.jsonl` files in one folder. Graders may be people or strong models; the recorded baseline used three Opus graders.

3. **Run and score** the judge over the graded ids, on the shipped prompt alone or paired with a candidate:

   ```
   claude --plugin-dir tools/eval --setting-sources "" -p "/eval-judge --key tools/eval/out/records.jsonl --ids <ids file> --graders <folder of grade-out-*.jsonl> --out tools/eval/out/<date>-<name>.jsonl --candidate <prompt file> --repeats 2 --workers 4"
   ```

   Calls: records × arms × repeats (190 × 2 × 2 = 760 haiku calls). `--candidate` is a file holding a whole system prompt; with it the `candidate` arm sends that text where the `base` arm sends `PROMPT`, on the same input, and without it only `base` runs. Its reply must answer the same fixed questions, since `decide.ts` reads them. `--repeats` (default 2) runs every arm that many times, so the run measures its own noise. A record's arms are sent side by side, so both meet the same API conditions. `--key` takes the extract's JSON lines or a JSON object of records by id; `--graders` takes a folder (its `grade-out-*.jsonl`) or one grades file. `--setting-sources ""` keeps the installed plugins from loading beside it. Keep the `--out` file: it is the run's raw output.

`tools/eval/out/` is ignored by git. Records and grades come from real transcripts: never commit them. `fixtures/records.sample.jsonl` and `fixtures/grades.sample.jsonl` are synthetic: eight records and their grades, the shapes above. Their source is `fixtures/samples.ts`, which the tests import; edit it and run `node scripts/sync-shared.ts` to rewrite the two files (`--check` fails on drift).

## What it no longer does

- **The minutes arms.** `--arms off,on`, the minutes fact and the `by gap` lines left with the prompt they tested. A paired run compares two prompts now.
- **Change the decision code in an arm.** Both arms read their replies with the shipped `decide.ts`. To measure a change to it, replay the saved `text` of an `--out` file through the new code; no model call is needed.
- **Change the input in an arm.** Both arms send the record's `input`. A change to `input.ts` is measured by extracting a second set of records with it and comparing two runs, which meet different API conditions.
- **See the live input of an old firing.** A record is a rebuild. From this version on, the capture file holds the exact input of each judged turn (`plugins/stop-judge/README.md`); `/eval-extract` does not read it yet.

## Output

`/eval-judge` writes one line per call to `--out`: `{ id, arm, repeat, live, new, new_outcome, reason, text, ms, error, usage, prompt }`. `text` is the model's whole reply and `prompt` the whole user message it was sent. `live` is the logged outcome; `new_outcome` is what the judge would log now (`continue` is a nudge), before the gates that need a live session (the prompt box, a newer turn). It answers:

```
calls n: r records × a arms × k repeats; errors n
live (logged at the firing): false-block a/b = x% | catch c/d = y%
base #1: false-block a/b = x% | catch c/d = y%          (one line per arm and repeat)
noise, records that differ between two repeats of one arm: base x, candidate y
arms, records that differ between base and candidate in one repeat: z
graded stop: candidate blocks more on n, base on m, sign test p=…
graded continue: candidate catches more on n, base on m, sign test p=…
base false blocks: [<id> <case> <blocks>/<calls>, …]
base misses: [<id> <grade confidence> <case> <blocks>/<calls>, …]
differ, read these by hand: [<id> <grade> base a/k candidate b/k, …]
system prompt: …
written <out>
```

A false block is a `continue` on a record graded `stop`; a catch is a `continue` on one graded `continue`. Calls with an error (timeout, API error, no answers) are counted under `errors` and left out of every ratio.

**Reading it.** The arms are compared with each other, not with an earlier run: the `base` arm in the same run is the baseline. An arm difference counts only past the noise: when `arms` is no larger than `noise`, and the sign tests are far from small, the run measured no change, whichever way the ratios lean. The graders' labels are not the authority over the arms: read every `differ` record's two replies in the `--out` file before concluding.

**The tail.** The judge reads the transcript's last 8 MB, and the transcript has grown since. So the extract reads every line with its byte offset (`grep -a -b ''`) and rebuilds the file as the judge read it: the file ends at the turn's last agent row with text (the last one timed no later than 2 s past the firing log's stamp), since the judge reads right after it. Rows written after it, while the judge called the model (its nudge, a prompt the operator sent then), are not in it. The extract cuts the last 8 MB as `tail -c` does. A firing with no agent row falls back to every line timed before the stamp.

## Baseline

None carried between runs. A run's `base` arm is its baseline.

## Checks

`claude plugin test tools/eval` runs `tests/`; `bash scripts/check.sh` runs it with `tsc` and `validate`.
