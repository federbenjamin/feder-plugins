import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Concise, Summary } from '../types'
import { EMPTY_CONCISE, paneLayout, scrolledOffset } from './concise.ts'
import type { PaneLayout } from './concise.ts'
import { CONCISE_SHAPE, PANE_BACKGROUND, PANE_TITLE, PLUGIN, SHAPE } from './config.ts'
import { EMPTY_SUMMARY } from './summary.ts'

export const summaryAtom = atom({ plugin: 'session-summary', key: 'summary' } as const, EMPTY_SUMMARY, { shape: SHAPE })
export const conciseAtom = atom({ plugin: 'session-summary', key: 'concise' } as const, EMPTY_CONCISE, { shape: CONCISE_SHAPE })

export function openPane($: EngineInterface) {
  return $.ui.open({ id: PLUGIN, title: PANE_TITLE, backgroundColor: PANE_BACKGROUND })
}

// The pane draws its own rows, so the top stays in place while the bottom section scrolls. `window`
// is what the last drawing laid out, which a scroll needs and its input does not carry.
export const registerPane: Register = on => {
  let window: PaneLayout['window'] = null

  on('ui.render', { component: 'Pane', requestId: PLUGIN }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const layout = paneLayout({
      summary: await read($, summaryAtom),
      concise: await read($, conciseAtom),
      now: await $.clock.now(),
      columns: e.props.bodyColumns,
      bodyRows: e.props.scroll.bodyRows,
    })
    window = layout.window
    return (
      <Box flexDirection="column">
        {layout.rows.map(row => (
          <Text bold={row.bold ?? false} dimColor={row.dim ?? false} wrap="truncate-end">{row.text === '' ? ' ' : row.text}</Text>
        ))}
      </Box>
    )
  })

  // With no window the engine scrolls the whole tree.
  on('ui.scroll', { component: 'Pane', requestId: PLUGIN }, async ($, e, next) => {
    const current = window
    if (current === null) return next(e)
    await update($, conciseAtom, c => ({ ...c, offset: scrolledOffset({ offset: c.offset, by: e.by, bodyRows: e.bodyRows, window: current }) }))
    return {}
  })
}

// Every read and write of the atoms goes through this file: `claude plugin validate` refuses a
// read or update whose atom was made in another file.
export async function readSummary($: EngineInterface): Promise<Summary> {
  return read($, summaryAtom)
}

export async function writeSummary($: EngineInterface, change: (s: Summary) => Summary): Promise<Summary> {
  return update($, summaryAtom, change)
}

export async function readConcise($: EngineInterface): Promise<Concise> {
  return read($, conciseAtom)
}

export async function writeConcise($: EngineInterface, change: (c: Concise) => Concise): Promise<Concise> {
  return update($, conciseAtom, change)
}
