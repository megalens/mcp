import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  MEGALENS_REVIEW_LINE,
  DECISION_LINE,
  DECISION_LINE_V1,
  MEGALENS_INSTRUCTION_LINES,
  TOKEN_REGEX,
  MASKED_TOKEN,
  formatInvalidSetupArgError,
  getReadOnlyReason,
  makeTimestamp,
  isYes,
  readOptionalFile,
  verifyFileVersion,
  backupExistingFile,
  writeFileAtomicPreservingMode,
  createPrompter,
  resolveToken,
  validateEditorToken,
  mergeMcpServerEntry,
  stableJson,
  gitTrackable,
  realLocation,
  runAppendInstructionLines,
  runRemoveInstructionLine,
} from './setup-shared.mjs'

export {
  MEGALENS_REVIEW_LINE,
  DECISION_LINE,
  DECISION_LINE_V1,
  MEGALENS_INSTRUCTION_LINES,
  TOKEN_REGEX,
  MASKED_TOKEN,
}

export const CLAUDE_MCP_URL = 'https://megalens.ai/api/mcp?ide=claude-code'
export const ANTIGRAVITY_MCP_URL = 'https://megalens.ai/api/mcp?ide=antigravity'
export const CLAUDE_DOCS_URL = 'https://megalens.ai/integrations/claude-code'
export const ANTIGRAVITY_DOCS_URL = 'https://megalens.ai/integrations/antigravity'
export const CLAUDE_FINAL_MESSAGE =
  'Restart Claude Code, then ask it to get a second opinion from MegaLens on your next change.'
export const ANTIGRAVITY_FINAL_MESSAGE =
  'Restart Antigravity, then ask it to get a second opinion from MegaLens on your next change.'
export const GEMINI_CLI_SHARED_NOTE =
  'Gemini CLI also reads this file, so these lines affect Gemini CLI too.'
export const GEMINI_CLI_SHARED_NOTE_SINGLE =
  'Gemini CLI also reads this file, so this line affects Gemini CLI too.'

export function resolveClaudeConfigDir(env = process.env, home = homedir()) {
  const custom = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : ''
  return custom ? resolve(custom) : join(home, '.claude')
}

/**
 * Claude Code's user-scoped MCP config: `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR`
 * is set, otherwise `~/.claude.json`. Writing this file directly (0600, atomic) avoids passing the
 * bearer token in child-process arguments to `claude mcp add` (Astra FINAL #2).
 */
export function resolveClaudeMcpConfigPath(env = process.env, home = homedir()) {
  const custom = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : ''
  return custom ? join(resolve(custom), '.claude.json') : join(home, '.claude.json')
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val)
}

function mergeMegalensEntry(existing, entry, { defaultFields = {} } = {}) {
  return mergeMcpServerEntry(existing, 'mcpServers', entry, { defaultFields })
}

const HOST_SPECS = {
  'claude-code': {
    id: 'claude-code',
    usageCommand: 'setup claude-code',
    displayName: 'Claude Code',
    mcpUrl: CLAUDE_MCP_URL,
    docsUrl: CLAUDE_DOCS_URL,
    mcpConfigPath: (home, env) => resolveClaudeMcpConfigPath(env, home),
    instructionsPath: (home, env) => join(resolveClaudeConfigDir(env, home), 'CLAUDE.md'),
    instructionsNote: null,
    finalMessage: CLAUDE_FINAL_MESSAGE,
    buildEntry: (token) => ({
      type: 'http',
      url: CLAUDE_MCP_URL,
      headers: { Authorization: `Bearer ${token}` },
    }),
    defaultFields: {},
  },
  antigravity: {
    id: 'antigravity',
    usageCommand: 'setup antigravity',
    displayName: 'Antigravity',
    mcpUrl: ANTIGRAVITY_MCP_URL,
    docsUrl: ANTIGRAVITY_DOCS_URL,
    mcpConfigPath: (home) => join(home, '.gemini', 'config', 'mcp_config.json'),
    instructionsPath: (home) => join(home, '.gemini', 'GEMINI.md'),
    instructionsNote: GEMINI_CLI_SHARED_NOTE,
    instructionsNoteSingle: GEMINI_CLI_SHARED_NOTE_SINGLE,
    finalMessage: ANTIGRAVITY_FINAL_MESSAGE,
    buildEntry: (token) => ({
      serverUrl: ANTIGRAVITY_MCP_URL,
      headers: { Authorization: `Bearer ${token}` },
    }),
    defaultFields: { disabled: false },
  },
}

function inspectMcpConfig(data) {
  if (!isPlainObject(data)) return { status: 'unknown', unknownKeys: [] }
  const serverMapKeys = ['mcpServers', 'servers']
  let hasRecognisedMap = false
  for (const key of serverMapKeys) {
    if (Object.prototype.hasOwnProperty.call(data, key) && isPlainObject(data[key])) {
      hasRecognisedMap = true
      if (Object.prototype.hasOwnProperty.call(data[key], 'megalens')) {
        return { status: 'found', unknownKeys: [] }
      }
    }
  }
  if (hasRecognisedMap) {
    return { status: 'absent', unknownKeys: [] }
  }
  const unknownKeys = Object.keys(data)
  if (unknownKeys.length > 0) {
    return { status: 'unknown', unknownKeys }
  }
  return { status: 'absent', unknownKeys: [] }
}

export function parseSetupHostArgs(args, subcommand = 'claude-code') {
  let dryRun = false
  let removeLine = false
  let help = false

  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--remove-line') removeLine = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--yes' || arg === '-y') {
      return { error: '--yes is not supported. Every write requires an explicit y at its own prompt.' }
    } else {
      return { error: formatInvalidSetupArgError(subcommand, arg) }
    }
  }

  return { dryRun, removeLine, help }
}

function formatMaskedConfigSnippet(spec, placeholder = MASKED_TOKEN) {
  const snippet = {
    mcpServers: {
      megalens: {
        ...spec.defaultFields,
        ...spec.buildEntry(placeholder),
      },
    },
  }
  return JSON.stringify(snippet, null, 2)
}

function printNonInteractiveGuide(spec, configPath, instructionsPath, log) {
  log(`\n  MegaLens ${spec.displayName} Setup (non-interactive mode: nothing was written)\n`)
  log('  Manual steps:')
  log('  1. Get your MegaLens Editor token at https://megalens.ai/app/settings/mcp')
  log(`  2. Add this entry to ${configPath} (mode 0600):\n`)
  for (const line of formatMaskedConfigSnippet(spec, 'ml_tok_your_token_here').split('\n')) {
    log(`     ${line}`)
  }
  log(`     Docs: ${spec.docsUrl}`)
  log(`\n  3. Add these lines to ${instructionsPath}:\n`)
  log(`     ${MEGALENS_REVIEW_LINE}`)
  log(`     ${DECISION_LINE}`)
  if (spec.instructionsNote) {
    log(`     Note: ${spec.instructionsNote}`)
  }
  log(`\n  4. ${spec.finalMessage}\n`)
}

async function runSetupHost(spec, args = [], io = {}) {
  const {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    home = homedir(),
    platform = process.platform,
    isTTY = Boolean(stdin.isTTY),
    now = () => new Date(),
    promptOverride,
    validateToken = validateEditorToken,
  } = io

  const log = (msg = '') => stdout.write(`${msg}\n`)
  const errLog = (msg = '') => stderr.write(`${msg}\n`)

  const parsed = parseSetupHostArgs(args, spec.id)
  if (parsed.error) {
    errLog(`  ${parsed.error}`)
    return { exitCode: 1, written: [], connected: false, dryRun: false }
  }

  if (parsed.help) {
    log(`
  Usage: npx megalens-mcp ${spec.usageCommand} [options]

  Options:
    --remove-line   Remove the MegaLens review lines from ${spec.id === 'claude-code' ? '~/.claude/CLAUDE.md' : '~/.gemini/GEMINI.md'}
    --dry-run       Show what would be written without changing anything
    -h, --help      Show this help
`)
    return { exitCode: 0, written: [], connected: false, dryRun: false }
  }

  const configPath = spec.mcpConfigPath(home, env)
  const instructionsPath = spec.instructionsPath(home, env)
  const prompter = promptOverride ?? createPrompter(stdin, stdout)
  const timestamp = makeTimestamp(now())

  if (parsed.removeLine) {
    const res = await runRemoveInstructionLine({
      filePath: instructionsPath,
      hostName: spec.displayName,
      dryRun: parsed.dryRun,
      isTTY,
      prompter,
      timestamp,
      log,
      errLog,
    })
    return { ...res, connected: false }
  }

  if (!isTTY) {
    printNonInteractiveGuide(spec, configPath, instructionsPath, log)
    return { exitCode: 0, written: [], connected: false, dryRun: parsed.dryRun }
  }

  const written = []
  const dryRunNotes = []
  let connected = false

  log(`\n  MegaLens ${spec.displayName} Setup\n`)
  if (parsed.dryRun) {
    log('  [dry-run] No files or MCP configs will be modified.\n')
  }

  const envToken = typeof env.MEGALENS_TOKEN === 'string' ? env.MEGALENS_TOKEN.trim() : ''
  if (envToken && !TOKEN_REGEX.test(envToken)) {
    errLog('  Invalid token format. Expected ml_tok_ followed by 32 hex characters.')
    errLog('  Get your token at https://megalens.ai/app/settings/mcp\n')
    return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
  }

  // Resolve and verify the Editor token before reading or modifying host config files.
  // Accepts both the general `default` Editor token and the tool-specific onboarding token (`spec.id`).
  const tokenRes = await resolveToken({
    env,
    prompter,
    errLog,
    validateToken,
    allowedLabels: ['default', spec.id],
  })
  if (!tokenRes.token) {
    return { exitCode: tokenRes.exitCode, written, connected, dryRun: parsed.dryRun }
  }
  const token = tokenRes.token

  // ── 1 & 2. Read private host config and write directly (0600, atomic, no secret in argv) ──
  const mcpRead = await readOptionalFile(configPath)
  if (mcpRead.unreadable) {
    errLog(`  ! ${configPath} could not be read: ${mcpRead.unreadable}`)
    errLog(`    Not touching anything for ${spec.displayName}.`)
    return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
  }

  let parsedJson = {}
  let existingServer = false
  if (mcpRead.exists && mcpRead.content.trim() !== '') {
    try {
      const jsonText = mcpRead.content.startsWith('\uFEFF') ? mcpRead.content.slice(1) : mcpRead.content
      parsedJson = JSON.parse(jsonText)
    } catch (err) {
      errLog(`  ! ${configPath} is not valid JSON: ${err?.message ?? err}`)
      errLog(`    Not touching anything for ${spec.displayName}.`)
      return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
    }
    if (!isPlainObject(parsedJson)) {
      errLog(`  ! ${configPath} is not a valid JSON object.`)
      errLog(`    Not touching anything for ${spec.displayName}.`)
      return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
    }
    const mcpInspection = inspectMcpConfig(parsedJson)
    if (mcpInspection.status === 'found') {
      existingServer = true
    } else if (mcpInspection.status === 'unknown') {
      log(`  ! ${configPath} has unrecognised top-level key(s) (${mcpInspection.unknownKeys.join(', ')}); treating existing MegaLens entry as unknown.`)
    }
    if (Object.prototype.hasOwnProperty.call(parsedJson, 'mcpServers') && !isPlainObject(parsedJson.mcpServers)) {
      errLog(`  ! ${configPath} has a non-object "mcpServers" field.`)
      errLog(`    Not touching anything for ${spec.displayName}.`)
      return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
    }
  }

  const snapshotHasMegalens =
    isPlainObject(parsedJson.mcpServers) &&
    Object.prototype.hasOwnProperty.call(parsedJson.mcpServers, 'megalens')
  const snapshotMegalens = snapshotHasMegalens ? stableJson(parsedJson.mcpServers.megalens) : undefined

  const readOnlyReason = mcpRead.exists ? await getReadOnlyReason(configPath) : null
  if (readOnlyReason) {
    log(`  ! ${configPath} is read-only (${readOnlyReason}).`)
    log(`    Refusing to replace it; leaving ${configPath} unchanged.\n`)
  } else {
    if (existingServer) {
      log(`  MegaLens is already configured in ${spec.displayName} (${configPath}).`)
      log('  Will update mcpServers.megalens with your Editor token (token hidden):\n')
    } else {
      log(`\n  Will write to ${configPath} (mode 0600, token hidden):\n`)
    }
    for (const line of formatMaskedConfigSnippet(spec, MASKED_TOKEN).split('\n')) {
      log(`    ${line}`)
    }
    log('')

    let connectAnswer
    try {
      connectAnswer = await prompter.askPlain(
        existingServer
          ? `  Update MegaLens MCP server in ${spec.displayName}? (y/N): `
          : `  Add MegaLens to ${spec.displayName}? (y/N): `,
      )
    } catch (err) {
      if (err?.exitCode === 130) {
        return { exitCode: 130, written, connected, dryRun: parsed.dryRun }
      }
      throw err
    }

    if (!isYes(connectAnswer)) {
      log(`  Skipped ${spec.displayName} MCP connection.\n`)
    } else {
      let allowWrite = true
      const realCfg = await realLocation(configPath)
      const tracked = realCfg === null ? 'unknown' : gitTrackable(realCfg, env)
      if (tracked !== 'no') {
        if (tracked === 'yes') {
          log(`  ! ${realCfg} is inside a git repository and not ignored there.`)
        } else if (realCfg === null) {
          log(`  ! Could not work out where ${configPath} really is (a link that could not be followed).`)
        } else {
          log(`  ! Could not check with git whether ${realCfg} is inside a repository.`)
        }
        log('    A token written into it can be committed and pushed with that repository.')
        let trackAns
        try {
          trackAns = await prompter.askPlain('  Write the MegaLens token into it anyway? (y/N): ')
        } catch (err) {
          if (err?.exitCode === 130) {
            return { exitCode: 130, written, connected, dryRun: parsed.dryRun }
          }
          throw err
        }
        allowWrite = isYes(trackAns)
      }

      if (!allowWrite) {
        log(`  Skipped ${spec.displayName} MCP connection.\n`)
      } else if (parsed.dryRun) {
        dryRunNotes.push(`${configPath} (would ${mcpRead.exists ? 'update' : 'create'})`)
        log(`  [dry-run] Would write ${configPath}\n`)
      } else {
        try {
          // Re-read config right before writing AND recheck its file version after backup and
          // right before rename so edits made while the prompt or backup is running (e.g. saving
          // another MCP server) are merged rather than erased, and conflicting edits to megalens
          // are refused (Astra CONFIRM10 #11, CONFIRM11 #11).
          const MAX_WRITE_ATTEMPTS = 3
          let backedUp = false
          let saved = false
          for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
            const latestRead = await readOptionalFile(configPath)
            if (latestRead.unreadable) {
              errLog(`  ! ${configPath} could not be read before writing: ${latestRead.unreadable}`)
              errLog(`    Leaving ${configPath} untouched.`)
              return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
            }
            let latestJson = parsedJson
            let latestExists = mcpRead.exists
            if (attempt > 0 || latestRead.exists !== mcpRead.exists || latestRead.content !== mcpRead.content) {
              if (mcpRead.exists && !latestRead.exists) {
                errLog(`  ! ${configPath} was removed while waiting for confirmation.`)
                errLog(`    Leaving it untouched; run setup again.`)
                return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
              }
              const latestReadOnly = latestRead.exists ? await getReadOnlyReason(configPath) : null
              if (latestReadOnly) {
                errLog(`  ! ${configPath} became read-only (${latestReadOnly}) while waiting for confirmation.`)
                errLog(`    Leaving ${configPath} untouched.`)
                return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
              }
              if (latestRead.exists && latestRead.content.trim() !== '') {
                try {
                  const latestText = latestRead.content.startsWith('\uFEFF') ? latestRead.content.slice(1) : latestRead.content
                  latestJson = JSON.parse(latestText)
                } catch (parseErr) {
                  errLog(`  ! ${configPath} changed while waiting for confirmation and is not valid JSON: ${parseErr?.message ?? parseErr}`)
                  errLog(`    Leaving ${configPath} untouched.`)
                  return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
                }
                if (!isPlainObject(latestJson)) {
                  errLog(`  ! ${configPath} changed while waiting for confirmation and is not a valid JSON object.`)
                  errLog(`    Leaving ${configPath} untouched.`)
                  return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
                }
                if (Object.prototype.hasOwnProperty.call(latestJson, 'mcpServers') && !isPlainObject(latestJson.mcpServers)) {
                  errLog(`  ! ${configPath} changed while waiting for confirmation and has a non-object "mcpServers" field.`)
                  errLog(`    Leaving ${configPath} untouched.`)
                  return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
                }
              } else {
                latestJson = {}
              }
              const latestHasMegalens =
                isPlainObject(latestJson.mcpServers) &&
                Object.prototype.hasOwnProperty.call(latestJson.mcpServers, 'megalens')
              const latestMegalens = latestHasMegalens ? stableJson(latestJson.mcpServers.megalens) : undefined
              if (latestHasMegalens !== snapshotHasMegalens || latestMegalens !== snapshotMegalens) {
                errLog(`  ! ${configPath} changed while waiting for confirmation (conflicting edit to mcpServers.megalens).`)
                errLog(`    Leaving ${configPath} untouched; run setup again.`)
                return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
              }
              latestExists = latestRead.exists
            }

            const nextObj = mergeMegalensEntry(latestJson, spec.buildEntry(token), {
              defaultFields: spec.defaultFields,
            })
            const nextJson = JSON.stringify(nextObj, null, 2) + '\n'
            const target = await realpath(configPath).catch(() => configPath)
            if (latestExists && !backedUp) {
              await backupExistingFile(target, timestamp, { mode: 0o600, env, home, platform, log })
              backedUp = true
              if (!(await verifyFileVersion(configPath, latestRead.version))) {
                continue
              }
            }
            try {
              await writeFileAtomicPreservingMode(configPath, nextJson, {
                defaultMode: 0o600,
                preserveMode: false,
                log,
                expectedVersion: latestRead.version,
              })
              saved = true
              break
            } catch (writeErr) {
              if (writeErr?.code === 'ECONCURRENT') {
                continue
              }
              throw writeErr
            }
          }
          if (!saved) {
            errLog(`  ! ${configPath} kept changing while saving; leaving it untouched. Run setup again.`)
            return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
          }
          written.push(configPath)
          connected = true
          log(`  Connected MegaLens in ${spec.displayName} (${configPath}).\n`)
        } catch (err) {
          errLog(`  ! Failed to write ${configPath}: ${err?.message ?? err}`)
          return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
        }
      }
    }
  }

  // ── 3. Global instruction file ──
  const promptText = (plan) => {
    const onlyAdds = plan.replacements.length === 0 && plan.removals.length === 0
    const totalChanges = plan.addLines.length + plan.replacements.length + plan.removals.length
    const note = spec.instructionsNote
      ? (totalChanges > 1 ? spec.instructionsNote : (spec.instructionsNoteSingle ?? spec.instructionsNote))
      : ''
    const noteSuffix = note ? ` ${note}` : ''

    if (onlyAdds) {
      const noun = plan.addLines.length > 1 ? 'these lines' : 'this line'
      return `  Add ${noun} to ${instructionsPath} so ${spec.displayName} offers a MegaLens review at the right moments?${noteSuffix} (y/N): `
    }
    if (plan.addLines.length === 0 && plan.removals.length === 0 && plan.replacements.length === 1) {
      return `  Update this line in ${instructionsPath} so ${spec.displayName} offers a MegaLens review at the right moments?${noteSuffix} (y/N): `
    }
    if (plan.addLines.length === 0 && plan.replacements.length === 0) {
      const noun = plan.removals.length > 1 ? 'lines' : 'line'
      return `  Remove outdated MegaLens ${noun} from ${instructionsPath}?${noteSuffix} (y/N): `
    }
    return `  Apply these updates to ${instructionsPath} so ${spec.displayName} offers a MegaLens review at the right moments?${noteSuffix} (y/N): `
  }

  const instRes = await runAppendInstructionLines({
    filePath: instructionsPath,
    promptText,
    dryRun: parsed.dryRun,
    prompter,
    platform,
    timestamp,
    log,
    errLog,
    written,
    dryRunNotes,
  })
  if (instRes.exitCode) {
    return { exitCode: instRes.exitCode, written, connected, dryRun: parsed.dryRun }
  }

  // ── 4. Final message ──
  if (parsed.dryRun) {
    log(dryRunNotes.length > 0
      ? `  [dry-run] Would apply: ${dryRunNotes.join(', ')}`
      : '  [dry-run] Nothing would be written.')
  } else if (written.length > 0 || connected) {
    const parts = []
    if (connected) parts.push(`${spec.displayName} MCP server`)
    if (written.length > 0) parts.push(...written)
    log(`  Configured: ${parts.join(', ')}`)
  } else {
    log('  Nothing was changed.')
  }
  log(`  ${spec.finalMessage}\n`)

  return { exitCode: 0, written, connected, dryRun: parsed.dryRun }
}

export async function runSetupClaudeCode(args = [], io = {}) {
  return runSetupHost(HOST_SPECS['claude-code'], args, io)
}

export async function runSetupAntigravity(args = [], io = {}) {
  return runSetupHost(HOST_SPECS.antigravity, args, io)
}
