import type { EngineInterface } from 'claude-code'
import { expandHome, namedDocs, planOf } from './input.ts'
import type { Turn } from './input.ts'

// The plan the turn names, as far as it exists and reads; a file over the read cap is left out.
export async function readPlan($: EngineInterface, turn: Turn, home: string): Promise<{ path: string; body: string } | null> {
  const named = namedDocs(turn, home)
  const present = await Promise.all(named.map(p => $.fs.exists(expandHome(p, home)).catch(() => false)))
  const path = planOf(named.filter((_, i) => present[i]))
  if (path === null) return null
  try {
    return { path, body: await $.fs.read(expandHome(path, home)) }
  } catch {
    return null
  }
}
