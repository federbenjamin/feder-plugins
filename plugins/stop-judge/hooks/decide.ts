import { PASTED_BLOCK, PROPOSAL_ASK } from './config.ts'
import { isRecord } from './shared/typed.ts'

// What a model reply comes to: the answers it holds, whether its quotes are the operator's own
// words, and the decision the answers make. Haiku reports; only this code decides.

export type Answers = Record<string, unknown>

const YES = 'yes'

// The reply's JSON object, first brace to last.
export function parseAnswers(text: string): Answers | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const v: unknown = JSON.parse(m[0])
    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

const norm = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// A quote counts only when its words are in what the operator typed: an agent's "say go" fails.
export function isOperatorQuote(quote: unknown, operatorText: string): boolean {
  if (typeof quote !== 'string') return false
  const q = norm(quote)
  return q !== '' && norm(operatorText).includes(q)
}

// What the operator's words hold a step by: all they typed, for the quotes, and the message that
// opened the turn, for a request for a proposal.
export type Said = { operatorText: string; opening: string }

export function asksForProposal(opening: string): boolean {
  return PROPOSAL_ASK.test(opening.replace(PASTED_BLOCK, ''))
}

const low = (a: Answers, key: string): string =>
  String(a[key] ?? '')
    .trim()
    .toLowerCase()

export type Decision = { decision: 'stop' | 'continue'; why: string }

// A stop reason wins; otherwise keep going. The order is the tested one.
export function decide(a: Answers, said: Said): Decision {
  const stop = (why: string): Decision => ({ decision: 'stop', why })
  const blocker = low(a, 'blocker')
  const effort = low(a, 'effort')
  if (['', 'none'].includes(low(a, 'step'))) return stop('no step left open')
  if (!['', 'none'].includes(blocker)) return stop(`blocked: ${blocker}`)
  if (isOperatorQuote(a.gate_quote, said.operatorText)) return stop('operator holds it')
  if (asksForProposal(said.opening)) return stop('operator asked for a proposal')
  if (isOperatorQuote(a.ban_quote, said.operatorText)) return stop('operator forbade it')
  if (low(a, 'instructions_conflict') === YES) return stop('instructions conflict')
  if (low(a, 'open_choice') === YES) return stop('operator choice open')
  if (low(a, 'new_work') === YES) return stop('new work')
  if (low(a, 'changes_behavior') === YES && low(a, 'states_risk_and_cost') !== YES && effort !== 'low') return stop('design open')
  if (effort === 'high') return stop('high effort')
  if (low(a, 'reversible') === 'hard') return stop('hard to undo')
  return { decision: 'continue', why: 'nothing holds it' }
}

// What the outcome needs of a model reply.
export type JudgeReply = { isAnswered: true; text: string } | { isAnswered: false; reason: string; error?: string }

export type QuoteCheck = { quote: unknown; isOperators: boolean }

export type Judged = {
  outcome: 'continue' | 'stop' | 'pass-error' | 'pass-timeout'
  reason: string // the firing line's
  nudge: string // what the reminder says; '' unless the decision is continue
  answers: Answers | null
  quotes: { gate: QuoteCheck; ban: QuoteCheck } | null
  decision: Decision | null
}

const squash = (v: unknown): string => String(v ?? '').split(/\s+/).filter(Boolean).join(' ')

// A reply's outcome, as the judge logs it: an unanswered call passes (a cut one as a timeout), a
// reply with no answers is an error, and the answers go through decide.
export function judgeOutcome(reply: JudgeReply, said: Said): Judged {
  const none = { nudge: '', answers: null, quotes: null, decision: null }
  if (!reply.isAnswered) return { ...none, outcome: reply.reason === 'aborted' ? 'pass-timeout' : 'pass-error', reason: reply.error ? `${reply.reason} ${reply.error}` : reply.reason }
  const answers = parseAnswers(reply.text)
  if (answers === null) return { ...none, outcome: 'pass-error', reason: `no answers in: ${reply.text.slice(0, 160)}` }
  const decision = decide(answers, said)
  const step = squash(answers.step)
  return {
    outcome: decision.decision,
    reason: `${decision.why}; step: ${step}; why: ${squash(answers.why)}`,
    nudge: decision.decision === 'continue' ? `${decision.why}: ${step}` : '',
    answers,
    quotes: {
      gate: { quote: answers.gate_quote, isOperators: isOperatorQuote(answers.gate_quote, said.operatorText) },
      ban: { quote: answers.ban_quote, isOperators: isOperatorQuote(answers.ban_quote, said.operatorText) },
    },
    decision,
  }
}
