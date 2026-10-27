import type { EngineInterface } from 'claude-code'
import { commitData, complete, extractWindow, listNames, notify, readOr, readProfile, readPrompt, REPORT_MAX_TOKENS, REPORT_TIMEOUT_MS, summarizeSessions, type Config } from './io.ts'
import { alreadyWritten, localDate, nextState, notSummarized, parseState, plural, runRecordName, SUMMARY_NO_PROFILE, windowForRun, type RunArgs, type UsageByModel } from './pipeline.ts'
import {
  applyDrops,
  parsePatterns,
  parseStreams,
  patternsEntryText,
  patternsPrompt,
  previousStatusDay,
  renderStatus,
  statusBlocks,
  statusName,
  statusPrompt,
  upsertPatterns,
  watchFor,
} from './status.ts'

// The nightly run: extract the window, summarize each session, then write the day's status and
// patterns entry. Nothing is written, and the watermark stays, unless every answer came back whole.

export type RunResult = { outcome: 'written' | 'already' | 'backfill' | 'failed'; text: string }

export async function runMorning($: EngineInterface, cfg: Config, args: RunArgs): Promise<RunResult> {
  const { force, backfill } = args
  const startedAt = Date.now()
  const now = backfill ? Date.parse(backfill.until) : startedAt
  const offsetMinutes = new Date(now).getTimezoneOffset()
  const today = backfill?.date ?? localDate(now, offsetMinutes)
  const runsDir = `${cfg.dataDir}/runs`
  const statePath = `${cfg.dataDir}/state.json`
  let since = '(not read)'
  let note = ''
  try {
    const parsed = parseState(await readOr($, statePath, '{}'))
    if (!backfill && !force && alreadyWritten(parsed.state, today, await listNames($, runsDir))) {
      return { outcome: 'already', text: `${today} already written (${runsDir}/${runRecordName(today)}); /morning-run --force redoes it` }
    }
    if (parsed.corrupt) note = ' (state.json was unreadable; used the default window)'
    await $.process.run(['mkdir', '-p', runsDir])
    const window = backfill ?? windowForRun(parsed.state, now, today)
    since = window.since
    const { until } = window

    const profile = await readProfile($, cfg)
    const extracted = await extractWindow($, cfg, since, until)
    const { sessions } = extracted
    const usage: UsageByModel = {}
    const summarizer = await readPrompt($, 'summarizer.md', { PROFILE: profile ?? SUMMARY_NO_PROFILE })
    const { failed, text: summaries } = await summarizeSessions($, cfg, summarizer, sessions, usage)
    const summariesPath = `${runsDir}/${today}-summaries.md`

    if (backfill) {
      await $.fs.write(summariesPath, summaries.join('\n\n') + '\n')
      const saved = cfg.gitCommit ? `; ${await commitData($, cfg, `morning: ${today} (backfill)`)}` : ''
      return { outcome: 'backfill', text: `backfilled ${summariesPath}${notSummarized(failed)}${saved}` }
    }

    const previousDay = previousStatusDay(await listNames($, runsDir), today)
    const previous = previousDay === undefined ? [] : parseStreams(await readOr($, `${runsDir}/${statusName(previousDay)}`, '')).blocks
    const watch = watchFor(profile)
    const quiet = sessions.length === 0
    const call = async (name: 'status.md' | 'patterns.md', system: string, prompt: string) =>
      complete($, { model: cfg.reportModel, system, prompt, maxTokens: REPORT_MAX_TOKENS, timeoutMs: REPORT_TIMEOUT_MS }, usage).catch((err: unknown) => {
        throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      })
    const [statusAnswer, patternsAnswer] = await Promise.all([
      quiet ? undefined : call('status.md', await readPrompt($, 'status.md', {}), statusPrompt({ today, since, until, offsetMinutes, sessions, failed, previousDay, previous, summaries })),
      quiet || watch === undefined ? undefined : call('patterns.md', await readPrompt($, 'patterns.md', { WATCH_FOR: watch }), patternsPrompt({ today, since, until, failed, summaries })),
    ])

    const parsedStatus = statusAnswer === undefined ? { blocks: previous } : statusBlocks(statusAnswer, sessions.length)
    if ('error' in parsedStatus) throw new Error(parsedStatus.error)
    const entry = patternsAnswer === undefined ? undefined : parsePatterns(patternsAnswer)
    if (patternsAnswer !== undefined && entry === undefined) throw new Error('the patterns answer lacks its Going well or Not working list; nothing written')

    const { kept, dropped } = applyDrops(parsedStatus.blocks, today)
    const status = renderStatus({ today, since, until, kept, dropped })
    const patternsPath = `${cfg.dataDir}/patterns.md`
    const patterns = entry === undefined ? 'skipped' : 'written'
    const patternsWhy = quiet ? 'no sessions' : profile === undefined ? 'no profile.md' : watch === undefined ? 'no Watch for list in profile.md' : ''

    await $.fs.write(summariesPath, summaries.join('\n\n') + '\n')
    await $.fs.write(`${runsDir}/${statusName(today)}`, status)
    await $.fs.write(`${cfg.dataDir}/status.md`, status)
    if (entry !== undefined) await $.fs.write(patternsPath, upsertPatterns(await readOr($, patternsPath, ''), today, patternsEntryText(today, entry)))
    const record = {
      since,
      until,
      sessions: sessions.length,
      activeMinutes: extracted.active_minutes,
      projects: extracted.projects,
      failed,
      streams: kept.length,
      dropped: dropped.length,
      patterns: patternsWhy ? `${patterns}: ${patternsWhy}` : patterns,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      usage,
    }
    // The run record is the day's done marker, so it is written after every output.
    await $.fs.write(`${runsDir}/${runRecordName(today)}`, JSON.stringify(record, null, 2) + '\n')
    const saved = cfg.gitCommit ? `; ${await commitData($, cfg, `morning: ${today}`)}` : ''
    await $.fs.write(statePath, JSON.stringify(nextState(since, until, today)) + '\n')
    const streams = `${plural(kept.length, 'stream')}${dropped.length ? `, ${dropped.length} dropped` : ''}`
    await notify($, cfg, `Morning status ready (${plural(sessions.length, 'session')}, ${streams}): ${cfg.dataDir}/status.md`)
    const patternsText = entry === undefined ? `patterns skipped (${patternsWhy})` : `${patternsPath}`
    return { outcome: 'written', text: `wrote ${cfg.dataDir}/status.md (${streams}) and ${patternsText}${notSummarized(failed)}${saved}${note}` }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (!backfill) await notify($, cfg, `Morning status failed: ${reason}`)
    return { outcome: 'failed', text: `failed: ${reason} (window kept from ${since})${note}` }
  }
}
