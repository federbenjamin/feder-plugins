import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Summary } from '../types'
import { PANE_BACKGROUND, PANE_TITLE, PLUGIN, SHAPE } from './config.ts'
import { EMPTY_SUMMARY, paneView } from './summary.ts'

export const summaryAtom = atom({ plugin: 'session-summary', key: 'summary' } as const, EMPTY_SUMMARY, { shape: SHAPE })

export function openPane($: EngineInterface) {
  return $.ui.open({ id: PLUGIN, title: PANE_TITLE, backgroundColor: PANE_BACKGROUND })
}

export const registerPane: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PLUGIN }, async ($, e) => {
    const { Box, Link, Text } = $.ui.resolve(e)
    const view = paneView(await read($, summaryAtom), await $.clock.now(), await $.session.cwd())
    if (view === null) return <Text dimColor>No summary yet.</Text>
    const section = (label: string, text: string) => (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor bold>{label}</Text>
        <Text dimColor>{text}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column" rowGap={1}>
        {view.title !== '' && (
          <Box flexDirection="column">
            <Text bold>{view.title}</Text>
            <Text dimColor>{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
          </Box>
        )}
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color={view.isRunning ? 'success' : 'subtle'}>{view.isRunning ? '● NOW' : '○ NOW'}</Text>
            <Text dimColor>{view.age}</Text>
          </Box>
          <Text>{view.now}</Text>
        </Box>
        {section('SO FAR', view.soFar)}
        {view.asked !== '' && section('YOU ASKED', view.asked)}
        {view.files.length > 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            <Text dimColor bold>FILES</Text>
            {view.files.map(file => (
              <Text dimColor wrap="truncate-start"><Link href={file.href}>{file.label}</Link></Text>
            ))}
          </Box>
        )}
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
