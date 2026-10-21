import type { EngineInterface, Register } from 'claude-code'
import { report } from './compare.ts'
import { extractRecord, firingsOf, keyFrom, pushMark, ROW_GREP, tailFact, transcriptRows } from './extract.ts'
import type { Cut, EvalRecord, LineMark } from './extract.ts'
import { judgeRequest, MINUTES_SENTENCE, transcriptFindArgv } from './judge/judge.ts'
import type { MinutesGap } from './judge/judge.ts'
import { pool } from './judge/shared/pool.ts'
import type { TranscriptRow } from './judge/shared/typed.ts'
import { ARMS, callsOf, gradesFrom, parseArgs, runRecordOf } from './score.ts'
import type { Arm, Call, RunRecord } from './score.ts'

// Dev-only commands that measure the stop judge on the production model path ($.model.complete,
// which prepends the CLI identity block to `system`). Pure logic is in score.ts and extract.ts.

const JUDGE = 'eval-judge'
const EXTRACT = 'eval-extract'
const JUDGE_USAGE = `/${JUDGE} --key <grade-key.json | records.jsonl> --ids <ids file> --graders <dir of grade-out-*.jsonl | one grades file> --out <run.jsonl> [--arms off,on] [--repeats 2] [--workers 4]`
const EXTRACT_USAGE = `/${EXTRACT} --log <stop-judge.log> --out <records.jsonl>`
const DEFAULT_WORKERS = 4
const DEFAULT_REPEATS = 2
const GRADES_FILE = /^grade-out-.*\.jsonl$/

type Answer = { text: string; exitCode?: number }

// A command's whole stdout through spawn: `$.process.run` keeps only the first 4 MiB.
async function stdoutOf($: EngineInterface, argv: string[]): Promise<{ text: string; code: number | null }> {
  const pieces = $.process.spawn({ argv })
  let text = ''
  for (;;) {
    const piece = await pieces.next()
    if (piece.done) return { text, code: piece.value.code }
    if (piece.value.stream === 'stdout') text += piece.value.text
  }
}

// Inputs are read through `cat`: `$.fs.read` rejects over 4 MiB, and an extract of a long log passes it.
async function readText($: EngineInterface, path: string): Promise<string> {
  const { text, code } = await stdoutOf($, ['cat', path])
  if (code !== 0) throw new Error(`cannot read ${path}`)
  return text
}

// JSON lines out through `tee`, for the same cap on `$.fs.write`; the empty write makes the folders.
async function writeLines($: EngineInterface, path: string, lines: readonly string[]): Promise<void> {
  await $.fs.write(path, '')
  if (lines.length === 0) return
  const { exitCode } = await $.process.run(['tee', path], { stdin: `${lines.join('\n')}\n` })
  if (exitCode !== 0) throw new Error(`cannot write ${path}`)
}

// Found by id, as the judge finds it; undefined when the transcript is gone.
async function transcriptOf($: EngineInterface, home: string, session: string | null): Promise<string | undefined> {
  if (home === '' || !session) return undefined
  return (await $.process.run(transcriptFindArgv(home, session))).stdout
    .split('\n')
    .find(l => l.trim() !== '')
    ?.trim()
}

async function sessionRows($: EngineInterface, home: string, session: string | null): Promise<TranscriptRow[] | null> {
  const path = await transcriptOf($, home, session)
  if (path === undefined) return null
  const { text, code } = await stdoutOf($, ['grep', '-a', '-E', ROW_GREP, path])
  return code === 0 || code === 1 ? transcriptRows(text) : null
}

// Every line of the transcript with its byte offset, so the judge's tail at any firing can be
// cut again; a line split between two pieces is carried to the next.
async function sessionMarks($: EngineInterface, home: string, session: string | null): Promise<LineMark[] | null> {
  const path = await transcriptOf($, home, session)
  if (path === undefined) return null
  const marks: LineMark[] = []
  let carry = ''
  const pieces = $.process.spawn({ argv: ['grep', '-a', '-b', '', path] })
  for (;;) {
    const piece = await pieces.next()
    if (piece.done) {
      if (carry !== '') pushMark(marks, carry)
      return piece.value.code === 0 || piece.value.code === 1 ? marks : null
    }
    if (piece.value.stream !== 'stdout') continue
    const lines = (carry + piece.value.text).split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) pushMark(marks, line)
  }
}

async function gradeTexts($: EngineInterface, path: string): Promise<string[]> {
  if ((await $.fs.stat(path)).kind !== 'dir') return [await readText($, path)]
  const names = (await $.fs.list(path))
    .filter(e => e.kind === 'file' && GRADES_FILE.test(e.name))
    .map(e => e.name)
    .sort()
  const texts: string[] = []
  for (const name of names) texts.push(await readText($, `${path}/${name}`))
  return texts
}

// A record's minutes fact, the same for both arms' calls: computed once, before any call.
type Fact = { gap: MinutesGap | null; cut: Cut | null; hasTranscript: boolean }

async function factOf(r: EvalRecord | undefined, marksOf: (session: string | null) => Promise<LineMark[] | null>): Promise<Fact> {
  if (r === undefined) return { gap: null, cut: null, hasTranscript: false }
  const marks = await marksOf(r.session)
  // The fact production sends at this firing: from the tail it read then, not the whole file.
  const fact = marks === null ? null : tailFact(marks, r.ts)
  return { gap: fact?.gap ?? null, cut: fact?.cut ?? null, hasTranscript: marks !== null }
}

type Judged = { record: RunRecord; usage: unknown; prompt: string }

async function judgeOne($: EngineInterface, call: Call, r: EvalRecord | undefined, fact: Fact): Promise<Judged> {
  if (r === undefined) return { record: runRecordOf(call, '', { isAnswered: false, reason: 'not in key' }, 0, null), usage: null, prompt: '' }
  if (r.final === null) return { record: runRecordOf(call, r.outcome, { isAnswered: false, reason: 'no final message' }, 0, fact.gap), usage: null, prompt: '' }
  const request = judgeRequest(r.final, r.opening, r.context_users, fact.gap, call.arm === 'on')
  const startedAt = await $.clock.now()
  const reply = await $.model.complete(request)
  const ms = (await $.clock.now()) - startedAt
  return { record: runRecordOf(call, r.outcome, reply, ms, fact.gap), usage: reply.usage, prompt: request.prompt }
}

function armsOf(value: string | undefined): Arm[] | null {
  const words = (value ?? ARMS.join(',')).split(',').map(w => w.trim())
  const arms = ARMS.filter(arm => words.includes(arm))
  return arms.length === words.length && arms.length > 0 ? arms : null
}

async function evalJudge($: EngineInterface, args: string): Promise<Answer> {
  const a = parseArgs(args)
  const workers = a.workers === undefined ? DEFAULT_WORKERS : Number(a.workers)
  const repeats = a.repeats === undefined ? DEFAULT_REPEATS : Number(a.repeats)
  const arms = armsOf(a.arms)
  const isCount = (n: number) => Number.isInteger(n) && n >= 1
  if (!a.key || !a.ids || !a.graders || !a.out || !isCount(workers) || !isCount(repeats) || arms === null) return { text: JUDGE_USAGE, exitCode: 2 }
  const key = keyFrom(await readText($, a.key))
  const ids = (await readText($, a.ids))
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
  const grades = gradesFrom(await gradeTexts($, a.graders))
  const home = (await $.env.get('HOME')) ?? ''
  // One read per session, shared by its records and by lanes reading it at once; each line keeps
  // its bytes and time, and only a typed row whole.
  const sessions = new Map<string, Promise<LineMark[] | null>>()
  const marksOf = (session: string | null) => {
    const k = session ?? ''
    let marks = sessions.get(k)
    if (marks === undefined) {
      marks = sessionMarks($, home, session)
      sessions.set(k, marks)
    }
    return marks
  }
  const factList = await pool(ids, workers, id => factOf(key[id], marksOf))
  const facts = new Map(ids.map((id, i) => [id, factList[i]!]))
  const judged = await pool(callsOf(ids, arms, repeats), workers, call => judgeOne($, call, key[call.id], facts.get(call.id)!))
  await writeLines(
    $,
    a.out,
    judged.map(({ record, usage, prompt }) => JSON.stringify({ ...record, usage, prompt })),
  )
  const cuts = (cut: Cut) => factList.filter(f => f.cut === cut).length
  return {
    text: [
      report(
        judged.map(j => j.record),
        key,
        grades,
        arms,
        repeats,
      ),
      `minutes cut at the judge's read: ${cuts('answer')} | at the log stamp: ${cuts('stamp')} | no transcript: ${factList.filter(f => !f.hasTranscript).length}`,
      `system prompt: plugins/stop-judge/hooks/prompt.ts PROMPT${arms.includes('on') ? `; on adds the line "${MINUTES_SENTENCE}" and, in the user message, "Minutes since the operator's last typed message: [more than ]<n>"` : ''}`,
      `written ${a.out}`,
    ].join('\n'),
  }
}

async function evalExtract($: EngineInterface, args: string): Promise<Answer> {
  const a = parseArgs(args)
  if (!a.log || !a.out) return { text: EXTRACT_USAGE, exitCode: 2 }
  const firings = firingsOf(await readText($, a.log))
  const home = (await $.env.get('HOME')) ?? ''
  const records = new Map<string, EvalRecord>()
  // Session by session, so one transcript's rows are held at a time.
  for (const session of new Set(firings.map(f => f.firing.session))) {
    const rows = await sessionRows($, home, session)
    for (const f of firings) if (f.firing.session === session) records.set(f.id, extractRecord(f.id, f.firing, rows))
  }
  const out = firings.map(f => records.get(f.id)!)
  await writeLines(
    $,
    a.out,
    out.map(r => JSON.stringify(r)),
  )
  return { text: `records ${out.length}, no transcript or final ${out.filter(r => r.final === null).length}\nwritten ${a.out}` }
}

async function answer(name: string, work: Promise<Answer>): Promise<Answer> {
  try {
    return await work
  } catch (error) {
    return { text: `${name}: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: JUDGE, description: 'Dev: run the stop judge over graded firings and score it', argumentHint: '--key --ids --graders --out [--arms] [--repeats] [--workers]' })
    await $.command.register({ name: EXTRACT, description: 'Dev: rebuild judged-stop records from a stop-judge firing log', argumentHint: '--log --out' })
    return next(e)
  })

  on('command.run', { command: JUDGE }, async ($, e) => answer(JUDGE, evalJudge($, e.args)))
  on('command.run', { command: EXTRACT }, async ($, e) => answer(EXTRACT, evalExtract($, e.args)))
}
