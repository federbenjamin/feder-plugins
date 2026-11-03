import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Summary } from '../types'
import { PANE_BACKGROUND, PANE_TITLE, PLUGIN, SHAPE } from './config.ts'
import { EMPTY_SUMMARY, paneLines } from './summary.ts'

export const summaryAtom = atom({ plugin: 'session-summary', key: 'summary' } as const, EMPTY_SUMMARY, { shape: SHAPE })

export function openPane($: EngineInterface) {
  return $.ui.open({ id: PLUGIN, title: PANE_TITLE, backgroundColor: PANE_BACKGROUND })
}

// A dock is narrow, so each label sits on its own row above its text.
export const registerPane: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PLUGIN }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(await read($, summaryAtom), await $.clock.now())
    if (lines.length === 0) return <Text dimColor>No summary yet.</Text>
    return (
      <Box flexDirection="column" rowGap={1}>
        {lines.map(line => (
          <Box flexDirection="column">
            {line.label !== '' && <Text bold dimColor={line.dim}>{line.label}</Text>}
            <Text bold={line.bold} dimColor={line.dim}>{line.text}</Text>
          </Box>
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
