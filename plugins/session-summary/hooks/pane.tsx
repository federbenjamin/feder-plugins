import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Summary } from '../types'
import { PLUGIN, SHAPE } from './config.ts'
import { EMPTY_SUMMARY, paneLines } from './summary.ts'

export const summaryAtom = atom({ plugin: 'session-summary', key: 'summary' } as const, EMPTY_SUMMARY, { shape: SHAPE })

export const registerPane: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PLUGIN }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(await read($, summaryAtom), await $.clock.now())
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text dimColor={line.dim}>{line.text}</Text>
        ))}
      </Box>
    )
  })
}

// Every read and write of the atom goes through this file: `claude plugin validate` refuses a
// read or update whose atom was made in another file.
export async function readSummary($: EngineInterface): Promise<Summary> {
  return read($, summaryAtom)
}

export async function writeSummary($: EngineInterface, change: (s: Summary) => Summary): Promise<Summary> {
  return update($, summaryAtom, change)
}
