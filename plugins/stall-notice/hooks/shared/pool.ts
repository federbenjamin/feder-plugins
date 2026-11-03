// from federbenjamin/morning-report hooks/pipeline.ts
// Runs `work` over `items`, `limit` at once, results in item order. Once one item rejects, no
// lane starts another; items already running finish.
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  let failed = false
  const lane = async () => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await work(items[i]!)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return out
}
