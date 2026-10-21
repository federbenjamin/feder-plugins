import type { EngineInterface, Register } from 'claude-code'
import { extractRecord, firingsOf, keyFrom, pushMark, ROW_GREP, tailMinutesFact, transcriptRows } from './extract.ts'
import type { EvalRecord, LineMark } from './extract.ts'
import { judgeRequest, MINUTES_FACT, transcriptFindArgv } from './judge/judge.ts'
import { pool } from './judge/shared/pool.ts'
import type { TranscriptRow } from './judge/shared/typed.ts'
import { gradesFrom, parseArgs, runRecordOf, scoreRun } from './score.ts'
import type { RunRecord } from './score.ts'

// Dev-only commands that measure the stop judge on the production model path ($.model.complete,
// which prepends the CLI identity block to `system`). Pure logic is in score.ts and extract.ts.

const JUDGE = 'eval-judge'
const EXTRACT = 'eval-extract'
const JUDGE_USAGE = `/${JUDGE} --key <grade-key.json | records.jsonl> --ids <ids file> --graders <dir of grade-out-*.jsonl | one grades file> --out <run.jsonl> [--workers 4]`
const EXTRACT_USAGE = `/${EXTRACT} --log <stop-judge.log> --out <records.jsonl>`
const DEFAULT_WORKERS = 4
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

type Judged = { record: RunRecord; usage: unknown; hasTranscript: boolean }

async function judgeOne(
  $: EngineInterface,
  r: EvalRecord | undefined,
  id: string,
  marksOf: (session: string | null) => Promise<LineMark[] | null>,
): Promise<Judged> {
  if (r === undefined) return { record: runRecordOf(id, '', { isAnswered: false, reason: 'not in key' }, 0, null), usage: null, hasTranscript: false }
  const marks = await marksOf(r.session)
  // The fact production sent at this firing: from the tail it read then, not the whole file.
  const gap = marks === null ? null : tailMinutesFact(marks, r.ts)
  const minutes = gap?.minutes ?? null
  if (r.final === null) return { record: runRecordOf(id, r.outcome, { isAnswered: false, reason: 'no final message' }, 0, minutes), usage: null, hasTranscript: marks !== null }
  const startedAt = await $.clock.now()
  const reply = await $.model.complete(judgeRequest(r.final, r.opening, r.context_users, gap))
  const ms = (await $.clock.now()) - startedAt
  return { record: runRecordOf(id, r.outcome, reply, ms, minutes), usage: reply.usage, hasTranscript: marks !== null }
}

async function evalJudge($: EngineInterface, args: string): Promise<Answer> {
  const a = parseArgs(args)
  const workers = a.workers === undefined ? DEFAULT_WORKERS : Number(a.workers)
  if (!a.key || !a.ids || !a.graders || !a.out || !Number.isInteger(workers) || workers < 1) return { text: JUDGE_USAGE, exitCode: 2 }
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
  const judged = await pool(ids, workers, id => judgeOne($, key[id], id, marksOf))
  const lines = judged.map(({ record: r, usage }) =>
    JSON.stringify({ id: r.id, live: r.live, new: r.new, new_outcome: r.new_outcome, conf: r.conf, shape: r.shape, reason: r.reason, ms: r.ms, error: r.error, usage, minutes_since_operator: r.minutes_since_operator }),
  )
  await writeLines($, a.out, lines)
  const run = judged.map(j => j.record)
  return {
    text: [
      scoreRun(run, key, grades),
      `no transcript: ${judged.filter(j => !j.hasTranscript).length}`,
      `minutes fact: ${MINUTES_FACT ? 'on' : 'off'}`,
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
    await $.command.register({ name: JUDGE, description: 'Dev: run the stop judge over graded firings and score it', argumentHint: '--key --ids --graders --out [--workers]' })
    await $.command.register({ name: EXTRACT, description: 'Dev: rebuild judged-stop records from a stop-judge firing log', argumentHint: '--log --out' })
    return next(e)
  })

  on('command.run', { command: JUDGE }, async ($, e) => answer(JUDGE, evalJudge($, e.args)))
  on('command.run', { command: EXTRACT }, async ($, e) => answer(EXTRACT, evalExtract($, e.args)))
}
