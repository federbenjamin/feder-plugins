import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Concise, Doc, Summary } from '../types'
import { conciseView, EMPTY_CONCISE, scrolledOffset, toggleEntry } from './concise.ts'
import type { ConciseView } from './concise.ts'
import { CONCISE_GAP_ROWS, CONCISE_SHAPE, DOCUMENTS_SHAPE, PANE_BACKGROUND, PANE_TITLE, PLUGIN, SETTINGS_KEY, SHAPE } from './config.ts'
import { filesScrollbar, clampOffset, fileRow, filesHeader, isOverFiles, isRecentFile, shownDocuments } from './documents.ts'
import { settingsFrom } from './settings.ts'
import { EMPTY_SUMMARY, estimatedRows, filesRows, paneHeight, paneView } from './summary.ts'

export const summaryAtom = atom({ plugin: 'session-summary', key: 'summary' } as const, EMPTY_SUMMARY, { shape: SHAPE })
const documentsAtom = atom({ plugin: 'session-summary', key: 'documents' } as const, [] as Doc[], { shape: DOCUMENTS_SHAPE })
const filesOffsetAtom = atom({ plugin: 'session-summary', key: 'filesOffset' } as const, 0)
export const conciseAtom = atom({ plugin: 'session-summary', key: 'concise' } as const, EMPTY_CONCISE, { shape: CONCISE_SHAPE })

export function openPane($: EngineInterface) {
  return $.ui.open({ id: PLUGIN, title: PANE_TITLE, backgroundColor: PANE_BACKGROUND })
}

export const registerPane: Register = on => {
  // What the last drawing laid out for /summarize's section, which a scroll needs and its input does not carry.
  let window: ConciseView['window'] = null

  on('ui.render', { component: 'Pane', requestId: PLUGIN }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const view = paneView(await read($, summaryAtom), now)
    const docs = await read($, documentsAtom)
    const offset = await read($, filesOffsetAtom)
    const { linksBase } = settingsFrom(await $.store.get(SETTINGS_KEY))
    const shown = shownDocuments(docs, offset)
    const estimated = estimatedRows(view, e.props.bodyColumns, docs.length)
    const copy = conciseView({ concise: await read($, conciseAtom), now, columns: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows, aboveRows: estimated, fileRows: filesRows(docs.length) })
    window = copy?.window ?? null
    if (view === null && docs.length === 0 && copy === null) return <Text dimColor>No summary yet.</Text>
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
    const height = paneHeight({ placement: e.props.placement, bodyRows: e.props.scroll.bodyRows, estimated: estimated + (copy === null ? 0 : CONCISE_GAP_ROWS + copy.rows.length) })
    return (
      <Box flexDirection="column" {...(height === undefined ? {} : { height })}>
        <Box flexDirection="column" flexShrink={1} overflow="hidden">
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
        {copy !== null && (
          <Box flexDirection="column" flexShrink={0} marginTop={1}>
            <Text dimColor>{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
            <Box flexDirection="column" flexShrink={0} paddingLeft={2}>
              {copy.rows.map((row, i) => (
                <Box flexDirection="row" columnGap={1}>
                  <Box flexGrow={1} flexShrink={1}>
                    {row.kind === 'head' ? (
                      <Box flexDirection="row" flexGrow={1} justifyContent="space-between">
                        <Box flexShrink={1}>
                          <Button key={`summary-${row.id}`} plain dimColor onPress={() => void update($, conciseAtom, c => toggleEntry(c, row.id))}>
                            <Text bold>{row.label}</Text>
                          </Button>
                        </Box>
                        <Box flexShrink={0} marginLeft={1}>
                          <Text dimColor>{row.age}</Text>
                        </Box>
                      </Box>
                    ) : (
                      <Text dimColor wrap="truncate-end">{row.text === '' ? ' ' : row.text}</Text>
                    )}
                  </Box>
                  {copy.bar[i] !== undefined && <Text dimColor={copy.bar[i] === '│'}>{copy.bar[i]}</Text>}
                </Box>
              ))}
            </Box>
          </Box>
        )}
        <Box flexGrow={1} />
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

  // A tick over the pinned list scrolls the list, which the hook draws itself. Any other scroll that
  // reaches here moves /summarize's section when it is windowed. The tree is held to the body's
  // height, so otherwise there is nothing to move, and it goes on to the engine.
  on('ui.scroll', { component: 'Pane', requestId: PLUGIN }, async ($, e, next) => {
    const total = (await read($, documentsAtom)).length
    if (isOverFiles({ row: e.pointer?.row, contentRows: e.contentRows, bodyRows: e.bodyRows, total })) {
      await update($, filesOffsetAtom, offset => clampOffset(offset + Math.sign(e.by), total))
      return {}
    }
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

export async function readDocuments($: EngineInterface): Promise<readonly Doc[]> {
  return read($, documentsAtom)
}

export async function writeDocuments($: EngineInterface, change: (docs: Doc[]) => Doc[]): Promise<readonly Doc[]> {
  return update($, documentsAtom, change)
}

export async function clearDocuments($: EngineInterface): Promise<void> {
  await update($, documentsAtom, () => [])
  await update($, filesOffsetAtom, () => 0)
}

export async function readConcise($: EngineInterface): Promise<Concise> {
  return read($, conciseAtom)
}

export async function writeConcise($: EngineInterface, change: (c: Concise) => Concise): Promise<Concise> {
  return update($, conciseAtom, change)
}
