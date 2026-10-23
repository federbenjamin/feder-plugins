import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Summary } from '../types'
import { SHAPE } from './config.ts'
import { bandLines, EMPTY_SUMMARY } from './summary.ts'

export const summaryAtom = atom({ plugin: 'session-summary', key: 'summary' } as const, EMPTY_SUMMARY, { shape: SHAPE })

// The band above the prompt: drawn at the bottom of the screen in every layout, where a pane
// would be docked beside a fullscreen transcript. Empty until the first summary.
export const registerBand: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const lines = bandLines(await read($, summaryAtom), await $.clock.now())
    // Other plugins draw in the band too: the summary stacks above what they drew, never in place of it.
    const below = await next(e)
    if (e.props.hasSurvey || lines.length === 0) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Box flexDirection="row" columnGap={1}>
            {line.label !== '' && <Text dimColor>{line.label}</Text>}
            <Text dimColor={line.dim}>{line.text}</Text>
          </Box>
        ))}
        {below}
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
