import { parseCommand } from './shared/settings.ts'
import type { Grammar } from './shared/settings.ts'

// The /keepalive command's pure side: the grammar and the lines it prints. The off flag itself is
// per conversation, in `$.state`'s timing, not in `$.store`.

// Anything that is not off or on reports the state, so it parses as status.
export type Action = { kind: 'status' } | { kind: 'off' } | { kind: 'on' }

const GRAMMAR: Grammar<Action> = {
  empty: { kind: 'status' },
  words: { off: { kind: 'off' }, on: { kind: 'on' } },
  valued: {},
  usage: { kind: 'status' },
}

// `/keepalive off|on`.
export function keepaliveCommand(args: string): Action {
  return parseCommand(args, GRAMMAR)
}

// The off flag after the action, and the line the command prints.
export function keepaliveReply(isOff: boolean, action: Action): { isOff: boolean; text: string } {
  switch (action.kind) {
    case 'off':
      return { isOff: true, text: 'keepalive off: no pings in this conversation until /keepalive on' }
    case 'on':
      return { isOff: false, text: 'keepalive on: pings resume from your next request' }
    case 'status':
      return { isOff, text: `keepalive is ${isOff ? 'off' : 'on'}; /keepalive off or /keepalive on` }
  }
}
