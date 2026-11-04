import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Doc, Summary } from '../types'
import { DOCUMENTS_SHAPE, PANE_BACKGROUND, PANE_TITLE, PLUGIN, SETTINGS_KEY, SHAPE } from './config.ts'
import { filesScrollbar, clampOffset, fileRow, hasNewTop, filesHeader, isOverFiles, isRecentFile, shownDocuments } from './documents.ts'
import { settingsFrom } from './settings.ts'
import { EMPTY_SUMMARY, estimatedRows, paneHeight, paneView } from './summary.ts'

export const summaryAtom = atom({ plugin: 'session-summary', key: 'summary' } as const, EMPTY_SUMMARY, { shape: SHAPE })
const documentsAtom = atom({ plugin: 'session-summary', key: 'documents' } as const, [] as Doc[], { shape: DOCUMENTS_SHAPE })
const filesOffsetAtom = atom({ plugin: 'session-summary', key: 'filesOffset' } as const, 0)

export function openPane($: EngineInterface) {
  return $.ui.open({ id: PLUGIN, title: PANE_TITLE, backgroundColor: PANE_BACKGROUND })
}

export const registerPane: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PLUGIN }, async ($, e) => {
    const { Box, Link, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const view = paneView(await read($, summaryAtom), now)
    const docs = await read($, documentsAtom)
    const offset = await read($, filesOffsetAtom)
    const { linksBase } = settingsFrom(await $.store.get(SETTINGS_KEY))
    const shown = shownDocuments(docs, offset)
    if (view === null && docs.length === 0) return <Text dimColor>No summary yet.</Text>
    const cwd = await $.session.cwd()
    const present = linksBase === '' ? shown.map(() => true) : await Promise.all(shown.map(d => $.fs.exists(d.path)))
    const rows = shown.map((doc, i) => fileRow(doc, { cwd, linksBase, now, isPresent: present[i]! }))
    const bar = filesScrollbar(offset, docs.length)
    const section = (label: string, text: string) => (
      <Box flexDirection="column" paddingLeft={2} flexShrink={0}>
        <Text dimColor bold>{label}</Text>
        <Text dimColor>{text}</Text>
      </Box>
    )
    const height = paneHeight({ placement: e.props.placement, bodyRows: e.props.scroll.bodyRows, estimated: estimatedRows(view, e.props.bodyColumns, docs.length) })
    return (
      <Box flexDirection="column" {...(height === undefined ? {} : { height })}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {view === null ? (
            <Text dimColor>No summary yet.</Text>
          ) : (
            <Box flexDirection="column" rowGap={1} flexShrink={0}>
              {view.title !== '' && (
                <Box flexDirection="column" flexShrink={0}>
                  <Text bold>{view.title}</Text>
                  <Text dimColor>{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
                </Box>
              )}
              <Box flexDirection="column" flexShrink={0}>
                <Box flexDirection="row" justifyContent="space-between">
                  <Text bold color={view.isRunning ? 'success' : 'subtle'}>{view.isRunning ? '● NOW' : '○ NOW'}</Text>
                  <Text dimColor>{view.age}</Text>
                </Box>
                <Text>{view.now}</Text>
              </Box>
              {section('SO FAR', view.soFar)}
              {view.asked !== '' && section('YOU ASKED', view.asked)}
            </Box>
          )}
        </Box>
        {rows.length > 0 && (
          <Box flexDirection="column" flexShrink={0} marginTop={1} paddingLeft={2}>
            <Text dimColor bold>{filesHeader(offset, docs.length)}</Text>
            {rows.map((row, i) => (
              <Box flexDirection="row" columnGap={1}>
                <Box width={1} flexShrink={0}>
                  {isRecentFile(shown[i]!, now) && <Text color="success">•</Text>}
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  {row.href === undefined ? (
                    <Text dimColor strikethrough={row.isSuperseded} wrap="truncate-start">{row.label}</Text>
                  ) : (
                    <Text dimColor={row.isSuperseded} strikethrough={row.isSuperseded} wrap="truncate-start"><Link href={row.href}>{row.label}</Link></Text>
                  )}
                </Box>
                {bar[i] !== undefined && <Text dimColor={bar[i] === '│'}>{bar[i]}</Text>}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  // A tick over the pinned list scrolls the list, which the hook draws itself. The tree is held to
  // the body's height, so a tick anywhere else has nothing to move; it goes on to the engine.
  on('ui.scroll', { component: 'Pane', requestId: PLUGIN }, async ($, e, next) => {
    const total = (await read($, documentsAtom)).length
    if (!isOverFiles({ row: e.pointer?.row, contentRows: e.contentRows, bodyRows: e.bodyRows, total })) return next(e)
    await update($, filesOffsetAtom, offset => clampOffset(offset + Math.sign(e.by), total))
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

export async function readDocuments($: EngineInterface): Promise<readonly Doc[]> {
  return read($, documentsAtom)
}

// A file newly on top shows at once, even when the person had scrolled down.
export async function writeDocuments($: EngineInterface, change: (docs: Doc[]) => Doc[]): Promise<readonly Doc[]> {
  const before = (await read($, documentsAtom))[0]
  const after = await update($, documentsAtom, change)
  if (hasNewTop(before, after[0])) await update($, filesOffsetAtom, () => 0)
  return after
}

export async function clearDocuments($: EngineInterface): Promise<void> {
  await update($, documentsAtom, () => [])
  await update($, filesOffsetAtom, () => 0)
}
