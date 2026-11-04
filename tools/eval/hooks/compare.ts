import type { Arm, Grade, RunRecord } from './score.ts'

// The measurement of a run: each arm against the graders' labels, each arm against its own
// repeats (the noise), and the arms against each other.

const isBlock = (r: RunRecord) => r.new_outcome === 'continue'
const ratio = (n: number, of: number) => `${n}/${of} = ${of === 0 ? 'n/a' : `${((100 * n) / of).toFixed(1)}%`}`
const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

// Exact two-sided sign test: the chance of a split at least this uneven between `a` and `b`
// when each record that differs is a fair coin.
export function signTest(a: number, b: number): number {
  const n = a + b
  let tail = 0
  let choose = 1
  for (let i = 0; i <= Math.min(a, b); i++) {
    tail += choose
    choose = (choose * (n - i)) / (i + 1)
  }
  return Math.min(1, (2 * tail) / 2 ** n)
}

type Tally = { blocks: number; calls: number }
const rate = (t: Tally) => t.blocks / t.calls

// Blocks and calls of each record in one arm, over its repeats.
function tallies(scored: readonly RunRecord[], arm: Arm): Map<string, Tally> {
  const out = new Map<string, Tally>()
  for (const r of scored) {
    if (r.arm !== arm) continue
    const t = out.get(r.id) ?? { blocks: 0, calls: 0 }
    t.calls++
    if (isBlock(r)) t.blocks++
    out.set(r.id, t)
  }
  return out
}

// Records of two single runs (an arm's repeat each) whose outcome differs, over the records both judged.
function differing(scored: readonly RunRecord[], a: { arm: Arm; repeat: number }, b: { arm: Arm; repeat: number }): number {
  const of = (s: { arm: Arm; repeat: number }) => new Map(scored.filter(r => r.arm === s.arm && r.repeat === s.repeat).map(r => [r.id, isBlock(r)]))
  const x = of(a)
  const y = of(b)
  let n = 0
  for (const [id, blocked] of x) if (y.has(id) && y.get(id) !== blocked) n++
  return n
}

// Records where the candidate blocks more often than the base, and the reverse.
function split(ids: readonly string[], base: Map<string, Tally>, candidate: Map<string, Tally>): { more: number; less: number } {
  let more = 0
  let less = 0
  for (const id of ids) {
    const a = base.get(id)
    const b = candidate.get(id)
    if (!a || !b) continue
    if (rate(b) > rate(a)) more++
    else if (rate(b) < rate(a)) less++
  }
  return { more, less }
}

export function report(run: readonly RunRecord[], key: Record<string, { outcome: string }>, grades: Record<string, Grade>, arms: readonly Arm[], repeats: number): string {
  const ids = [...new Set(run.map(r => r.id))]
  const errors = run.filter(r => r.error !== '').length
  const scored = run.filter(r => r.error === '' && grades[r.id] !== undefined && key[r.id] !== undefined)
  const scoredIds = [...new Set(scored.map(r => r.id))]
  const ungraded = ids.filter(id => grades[id] === undefined || key[id] === undefined).length
  const gradeOf = (id: string) => grades[id]!
  const stops = scoredIds.filter(id => gradeOf(id).verdict === 'stop')
  const continues = scoredIds.filter(id => gradeOf(id).verdict === 'continue')
  const lines = [`calls ${run.length}: ${ids.length} records × ${arms.length} arm${arms.length === 1 ? '' : 's'} × ${repeats} repeat${repeats === 1 ? '' : 's'}; errors ${errors}`]
  if (ungraded > 0) lines.push(`ungraded or not in the key (not scored): ${ungraded}`)
  const live = (list: readonly string[]) => list.filter(id => key[id]!.outcome === 'continue').length
  lines.push(`live (logged at the firing): false-block ${ratio(live(stops), stops.length)} | catch ${ratio(live(continues), continues.length)}`)

  for (const arm of arms) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const one = scored.filter(r => r.arm === arm && r.repeat === repeat)
      const fb = one.filter(r => gradeOf(r.id).verdict === 'stop')
      const ct = one.filter(r => gradeOf(r.id).verdict === 'continue')
      lines.push(`${arm} #${repeat}: false-block ${ratio(fb.filter(isBlock).length, fb.length)} | catch ${ratio(ct.filter(isBlock).length, ct.length)}`)
    }
  }

  if (repeats >= 2) {
    const noise = arms.map(arm => {
      const pairs: number[] = []
      for (let i = 1; i <= repeats; i++) for (let j = i + 1; j <= repeats; j++) pairs.push(differing(scored, { arm, repeat: i }, { arm, repeat: j }))
      return `${arm} ${mean(pairs).toFixed(1)}`
    })
    lines.push(`noise, records that differ between two repeats of one arm: ${noise.join(', ')}`)
  }

  const t = new Map(arms.map(arm => [arm, tallies(scored, arm)]))
  const base = t.get('base')
  const candidate = t.get('candidate')
  if (base && candidate) {
    const across: number[] = []
    for (let repeat = 1; repeat <= repeats; repeat++) across.push(differing(scored, { arm: 'base', repeat }, { arm: 'candidate', repeat }))
    lines.push(`arms, records that differ between base and candidate in one repeat: ${mean(across).toFixed(1)}`)
    const s = split(stops, base, candidate)
    const c = split(continues, base, candidate)
    lines.push(`graded stop: candidate blocks more on ${s.more}, base on ${s.less}, sign test p=${signTest(s.more, s.less).toFixed(3)}`)
    lines.push(`graded continue: candidate catches more on ${c.more}, base on ${c.less}, sign test p=${signTest(c.more, c.less).toFixed(3)}`)
  }

  for (const arm of arms) {
    const tally = t.get(arm)!
    const blocked = stops.filter(id => (tally.get(id)?.blocks ?? 0) > 0).map(id => `${id} ${gradeOf(id).case} ${tally.get(id)!.blocks}/${tally.get(id)!.calls}`)
    const missed = continues
      .filter(id => tally.has(id) && tally.get(id)!.blocks < tally.get(id)!.calls)
      .map(id => `${id} ${gradeOf(id).confidence} ${gradeOf(id).case} ${tally.get(id)!.blocks}/${tally.get(id)!.calls}`)
    lines.push(`${arm} false blocks: [${blocked.join(', ')}]`, `${arm} misses: [${missed.join(', ')}]`)
  }

  if (base && candidate) {
    const differ = scoredIds
      .filter(id => base.has(id) && candidate.has(id) && rate(base.get(id)!) !== rate(candidate.get(id)!))
      .map(id => `${id} ${gradeOf(id).verdict} base ${base.get(id)!.blocks}/${base.get(id)!.calls} candidate ${candidate.get(id)!.blocks}/${candidate.get(id)!.calls}`)
    lines.push(`differ, read these by hand: [${differ.join(', ')}]`)
  }
  return lines.join('\n')
}
