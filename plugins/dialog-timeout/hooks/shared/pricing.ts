// USD per million tokens, per token category.
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

export const PRICES: Readonly<Record<'haiku' | 'sonnet', Price>> = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  // Cache reads and writes are charged at the input price: the derive estimate was measured that way.
  sonnet: { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 },
}

export function usageUsd(
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
  price: Price,
): number {
  const sum =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite
  return sum / 1_000_000
}
