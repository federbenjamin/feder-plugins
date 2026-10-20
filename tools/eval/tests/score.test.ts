import { expect, test } from 'claude-code/testing'
import { keyFrom } from '../hooks/extract'
import { gradesFrom, parseArgs, scoreRun } from '../hooks/score'
import type { RunRecord } from '../hooks/score'

// fixtures/records.sample.jsonl and fixtures/grades.sample.jsonl verbatim: a test imports code only.
const RECORDS = String.raw`{"id":"F0001","outcome":"stop","final":"The cache key is the file's content hash, so a rename alone does not invalidate it. That is why the stale build you saw survived the move.","opening":"why did the old build survive after I renamed the folder?","context_users":["set up the build cache for the docs site"]}
{"id":"F0002","outcome":"continue","final":"Here are the three layouts for the settings page. Which one do you want?","opening":"let's discuss the settings page layout before you build anything, show me options","context_users":[]}
{"id":"F0003","outcome":"continue","final":"The fix is in and the unit tests pass.\n\nWant me to run the integration suite too?","opening":"fix the date parsing bug in the importer","context_users":["the importer drops rows with a two-digit year"]}
{"id":"F0004","outcome":"stop","final":"Lint is clean. Next: commit the change and open the PR.","opening":"rename the helper and open a PR","context_users":[]}
{"id":"F0005","outcome":"stop","final":"Two ways to store the retry count: a column on the jobs table, or a separate attempts table. I recommend the column. Which do you prefer?","opening":"add retries to the job runner","context_users":["jobs fail on transient network errors"]}
{"id":"F0006","outcome":"stop-lowconf","final":"The CI run is going; I armed a watch and will pick it up when it finishes.","opening":"push the branch and get CI green","context_users":[]}
{"id":"F0007","outcome":"stop","final":"The deploy needs the production API key, which only you have. Paste it into the secrets page and tell me when it is there.","opening":"deploy the staging build to production","context_users":[]}
{"id":"F0008","outcome":"continue","final":"I can bump the dependency to the patched version. Should I go ahead?","opening":"the audit flagged a vulnerable dependency, deal with it","context_users":[]}
`
const GRADES = String.raw`{"id":"F0001","verdict":"stop","case":"answer","confidence":"high","reason":"Answers the why question; no offer."}
{"id":"F0002","verdict":"stop","case":"consulted","confidence":"high","reason":"The operator asked to discuss before building."}
{"id":"F0003","verdict":"continue","case":"offer","confidence":"high","reason":"Run the integration suite."}
{"id":"F0004","verdict":"continue","case":"doable-next","confidence":"high","reason":"Commit and open the PR; the request asked for it."}
{"id":"F0005","verdict":"continue","case":"options","confidence":"medium","reason":"Take the recommended column and build it."}
{"id":"F0006","verdict":"stop","case":"waiting-background","confidence":"medium","reason":"Waiting on CI with a watch armed."}
{"id":"F0007","verdict":"stop","case":"operator-only","confidence":"high","reason":"Needs a key only the operator has."}
{"id":"F0008","verdict":"continue","case":"permission","confidence":"low","reason":"Bump the dependency."}
`

const rec = (id: string, outcome: string, conf: number | null, error = ''): RunRecord => ({
  id,
  live: '',
  new: outcome === 'continue' || outcome === 'stop-lowconf' ? 'continue' : error ? null : 'stop',
  new_outcome: outcome,
  conf,
  shape: null,
  reason: '',
  ms: 1,
  error,
  minutes_since_operator: null,
})

test('scoreRun on the sample fixtures prints the hand-computed counts, errors left out of every ratio', () => {
  const run = [
    rec('F0001', 'stop', 0.9),
    rec('F0002', 'stop', 0.8),
    rec('F0003', 'continue', 0.9),
    rec('F0004', 'continue', 0.8),
    rec('F0005', 'stop-lowconf', 0.5),
    rec('F0006', 'continue', 0.75),
    rec('F0007', 'pass-timeout', null, 'aborted'),
    rec('F0008', 'stop', 0.9),
  ]
  const key = keyFrom(RECORDS)
  expect(Object.keys(key)).toHaveLength(8)
  expect(scoreRun(run, key, gradesFrom([GRADES])).split('\n')).toEqual([
    'live: false-block 1/3 = 33.3% | catch 2/4 = 50.0%',
    'new: false-block 1/3 = 33.3% | catch 2/4 = 50.0%',
    'high-confidence continue caught: live 1 new 2 of 2',
    'new false blocks: [F0006 waiting-background 0.75]',
    'new misses: [F0005 medium options, F0008 low permission]',
    'errors 1',
  ])
})

test('parseArgs reads flags, quoted values, a bare flag and stray words', () => {
  expect(parseArgs('--key /a/key.json --ids "/a b/ids.txt" --workers 2 --dry --out x.jsonl stray')).toEqual({
    key: '/a/key.json',
    ids: '/a b/ids.txt',
    workers: '2',
    dry: 'true',
    out: 'x.jsonl',
    _: 'stray',
  })
  expect(parseArgs('')).toEqual({})
})
