import type { Register } from 'claude-code'
import { record } from './shared/record.ts'
import { readProfile, resolveConfig } from './io.ts'
import { intOption, parseRunArgs, SCAN_TOOL, SETUP_ARGUMENT_HINT, SETUP_DAYS, type RunArgs } from './pipeline.ts'
import { runMorning } from './run.ts'
import { runSetup, runSetupScan } from './setup.ts'

// Registers /morning-run (the nightly job's entry point), /morning-setup and the scan tool the
// setup interview calls. run.ts writes the status and patterns; setup.ts runs the interview and
// the schedule. Every command and tool call logs one firing line.

const PLUGIN = 'morning-report'

export const register: Register = (on, options) => {
  // Each registration is tried on its own: a name the account already uses is refused, and that
  // refusal must not take the other commands down with it.
  on('session.start', async ($, e, next) => {
    const cfg = await resolveConfig($, options)
    const commands = [
      {
        name: 'morning-run',
        description: 'Write the nightly status and patterns entry for the sessions since the last run',
        argumentHint: '[--force] [--backfill YYYY-MM-DD --until ISO]',
      },
      {
        name: 'morning-setup',
        description: 'Set up morning-report: a short interview on what the patterns catalog watches for; schedule or remove the nightly job',
        argumentHint: SETUP_ARGUMENT_HINT,
      },
    ]
    for (const command of commands) {
      try {
        await $.command.register(command)
      } catch (err) {
        $.ui.toast(`/${command.name} not registered: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    try {
      await $.tool.register({
        name: SCAN_TOOL,
        description:
          "Reads the person's Claude Code sessions over the last `days` days, summarizes them, writes a setup scan of their habits, and returns its file path. Takes a few minutes. Call it only after the person agreed to it in the /morning-setup interview, with the number of days they chose.",
        inputSchema: {
          type: 'object',
          properties: { days: { type: 'integer', minimum: SETUP_DAYS.min, maximum: SETUP_DAYS.max } },
          required: ['days'],
          additionalProperties: false,
        },
      })
    } catch (err) {
      $.ui.toast(`${SCAN_TOOL} not registered: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      if ((await readProfile($, cfg)) === undefined) $.ui.toast('morning-report: run /morning-setup to start')
    } catch (err) {
      $.ui.toast(`morning-report: could not read ${cfg.dataDir}/profile.md: ${err instanceof Error ? err.message : String(err)}`)
    }
    return next(e)
  })

  // The scheduled job's entry point: hidden from the typeahead and /help, still runs when typed in full.
  on('command.describe', { command: 'morning-run' }, async ($, e, next) => ({ ...(await next(e)), isHidden: true }))

  on('command.run', { command: 'morning-run' }, async ($, e) => {
    const startedAt = Date.now()
    let args: RunArgs
    try {
      args = parseRunArgs(e.args)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      await record($, PLUGIN, 'run-usage', text)
      return { text }
    }
    const { outcome, text } = await runMorning($, await resolveConfig($, options), args)
    await record($, PLUGIN, `run-${outcome}`, text, Date.now() - startedAt)
    return { text }
  })

  on('command.run', { command: 'morning-setup' }, async ($, e) => {
    const startedAt = Date.now()
    try {
      const { kind, text } = await runSetup($, await resolveConfig($, options), e.args)
      await record($, PLUGIN, `setup-${kind}`, text, Date.now() - startedAt)
      return { text }
    } catch (err) {
      const text = `morning-setup failed: ${err instanceof Error ? err.message : String(err)}`
      await record($, PLUGIN, 'setup-failed', text, Date.now() - startedAt)
      return { text }
    }
  })

  on('tool.call', { tool: 'mcp__morning-report__morning_setup_scan' }, async ($, e) => {
    const startedAt = Date.now()
    try {
      const { text, ok } = await runSetupScan($, await resolveConfig($, options), intOption(e.days, SETUP_DAYS))
      await record($, PLUGIN, ok ? 'scan' : 'scan-failed', text, Date.now() - startedAt)
      return { result: text }
    } catch (err) {
      const text = `setup scan failed: ${err instanceof Error ? err.message : String(err)}`
      await record($, PLUGIN, 'scan-failed', text, Date.now() - startedAt)
      return { result: text }
    }
  })
}
