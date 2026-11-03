import { isRecord } from './typed.ts'

// A slash command's pure side, shared by every plugin's command: the stored settings read back
// field by field, and the args parsed into the plugin's own action. The hooks file applies it.

export type Grammar<A> = {
  empty: A // no words
  words: Readonly<Record<string, A>> // one word that is a verb
  valued: Readonly<Record<string, (value: string) => A | undefined>> // a verb and one value; undefined → usage
  other?: (word: string) => A | undefined // one word that is not a verb; undefined → usage
  usage: A // a third word, an unknown verb, a refused value
}

// Every word is lowercased. Verbs are looked up as own properties, so `constructor` is no verb.
export function parseCommand<A>(args: string, grammar: Grammar<A>): A {
  const [verb, value, extra] = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (verb === undefined) return grammar.empty
  if (extra !== undefined) return grammar.usage
  if (value === undefined) {
    const action = Object.hasOwn(grammar.words, verb) ? grammar.words[verb] : undefined
    return action ?? grammar.other?.(verb) ?? grammar.usage
  }
  const read = Object.hasOwn(grammar.valued, verb) ? grammar.valued[verb] : undefined
  return read?.(value) ?? grammar.usage
}

export type Checks<S> = { readonly [K in keyof S]: (v: unknown) => v is S[K] }

// Each field its check passes, else its default; a value that is not an object reads as every default.
export function readSettings<S extends object>(value: unknown, defaults: S, checks: Checks<S>): S {
  const stored: Record<string, unknown> = isRecord(value) ? value : {}
  const settings = { ...defaults }
  for (const key of Object.keys(checks) as (keyof S & string)[]) {
    const field = stored[key]
    if (checks[key](field)) settings[key] = field
  }
  return settings
}

export const isFlag = (v: unknown): v is boolean => typeof v === 'boolean'

export const isPositiveInteger = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0

export const isOneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (values as readonly string[]).includes(v)

// A command's number: digits only, so '1.5', '-3' and '1e3' are refused. The caller trims.
export function positiveInteger(word: string): number | undefined {
  if (!/^\d+$/.test(word)) return undefined
  const n = Number(word)
  return isPositiveInteger(n) ? n : undefined
}
