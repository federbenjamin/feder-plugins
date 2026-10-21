import type { Arm, Grade, RunRecord } from './score.ts'

// The measurement of a run: each arm against the graders' labels, each arm against its own
// repeats (the noise), and the arms against each other, overall and by the minutes gap.

const isBlock = (r: RunRecord) => r.new_outcome === 'continue'
const ratio = (n: number, of: number) => `${n}/${of} = ${of === 0 ? 'n/a' : `${((100 * n) / of).toFixed(1)}%`}`
const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

// Minutes since the operator's last typed message; a lower bound falls in its bound's bucket.
export const GAP_BUCKETS = [
  { name: '<5', below: 5 },
  { name: '5-29', below: 30 },
  { name: '30-119', below: 120 },
  { name: '120+', below: Number.POSITIVE_INFINITY },
] as const

export function bucketOf(minutes: number | null): string {
  return minutes === null ? 'none' : GAP_BUCKETS.find(b => minutes < b.below)!.name
}

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

// Records where `on` blocks more often than `off`, and the reverse.
function split(ids: readonly string[], off: Map<string, Tally>, on: Map<string, Tally>): { more: number; less: number } {
  let more = 0
  let less = 0
  for (const id of ids) {
    const a = off.get(id)
    const b = on.get(id)
    if (!a || !b) continue
    if (rate(b) > rate(a)) more++
    else if (rate(b) < rate(a)) less++
  }
  return { more, less }
}

function pooled(ids: readonly string[], t: Map<string, Tally>): string {
  let blocks = 0
  let calls = 0
  for (const id of ids) {
    const x = t.get(id)
    if (x) {
      blocks += x.blocks
      calls += x.calls
    }
  }
  return `${blocks}/${calls}`
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
  const off = t.get('off')
  const on = t.get('on')
  if (off && on) {
    const across: number[] = []
    for (let repeat = 1; repeat <= repeats; repeat++) across.push(differing(scored, { arm: 'off', repeat }, { arm: 'on', repeat }))
    lines.push(`arms, records that differ between off and on in one repeat: ${mean(across).toFixed(1)}`)
    const s = split(stops, off, on)
    const c = split(continues, off, on)
    lines.push(`graded stop: on blocks more on ${s.more}, off on ${s.less}, sign test p=${signTest(s.more, s.less).toFixed(3)}`)
    lines.push(`graded continue: on catches more on ${c.more}, off on ${c.less}, sign test p=${signTest(c.more, c.less).toFixed(3)}`)
  }

  lines.push(`by gap (minutes since the operator's last typed message; blocks/calls over all repeats; "+a/-b": records on blocks more/less):`)
  const minutesOf = new Map(scored.map(r => [r.id, r]))
  for (const bucket of [...GAP_BUCKETS.map(b => b.name), 'none']) {
    const inBucket = (id: string) => bucketOf(minutesOf.get(id)!.minutes_since_operator) === bucket
    const bs = stops.filter(inBucket)
    const bc = continues.filter(inBucket)
    if (bs.length + bc.length === 0) continue
    const bounds = [...bs, ...bc].filter(id => minutesOf.get(id)!.is_lower_bound).length
    const parts = [`  ${bucket}: stop ${bs.length}, continue ${bc.length}${bounds > 0 ? `, lower bounds ${bounds}` : ''}`]
    for (const arm of arms) parts.push(`${arm} false-block ${pooled(bs, t.get(arm)!)} catch ${pooled(bc, t.get(arm)!)}`)
    if (off && on) {
      const s = split(bs, off, on)
      const c = split(bc, off, on)
      parts.push(`on vs off: stop +${s.more}/-${s.less} continue +${c.more}/-${c.less}`)
    }
    lines.push(parts.join(' | '))
  }

  for (const arm of arms) {
    const tally = t.get(arm)!
    const blocked = stops.filter(id => (tally.get(id)?.blocks ?? 0) > 0).map(id => `${id} ${gradeOf(id).case} ${tally.get(id)!.blocks}/${tally.get(id)!.calls}`)
    const missed = continues
      .filter(id => tally.has(id) && tally.get(id)!.blocks < tally.get(id)!.calls)
      .map(id => `${id} ${gradeOf(id).confidence} ${gradeOf(id).case} ${tally.get(id)!.blocks}/${tally.get(id)!.calls}`)
    lines.push(`${arm} false blocks: [${blocked.join(', ')}]`, `${arm} misses: [${missed.join(', ')}]`)
  }

  if (off && on) {
    const differ = scoredIds
      .filter(id => off.has(id) && on.has(id) && rate(off.get(id)!) !== rate(on.get(id)!))
      .map(id => {
        const m = minutesOf.get(id)!
        const gap = m.minutes_since_operator === null ? 'none' : `${m.is_lower_bound ? '>' : ''}${m.minutes_since_operator}m`
        return `${id} ${gradeOf(id).verdict} ${gap} off ${off.get(id)!.blocks}/${off.get(id)!.calls} on ${on.get(id)!.blocks}/${on.get(id)!.calls}`
      })
    lines.push(`differ, read these by hand: [${differ.join(', ')}]`)
  }
  return lines.join('\n')
}
