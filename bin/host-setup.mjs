import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { delimiter, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  MEGALENS_REVIEW_LINE,
  DECISION_LINE,
  MEGALENS_INSTRUCTION_LINES,
  TOKEN_REGEX,
  MASKED_TOKEN,
  maskTokenSecrets,
  formatInvalidSetupArgError,
  makeTimestamp,
  isYes,
  readOptionalFile,
  createPrompter,
  resolveToken,
  runAppendInstructionLines,
  runRemoveInstructionLine,
} from './setup-shared.mjs'

export {
  MEGALENS_REVIEW_LINE,
  DECISION_LINE,
  MEGALENS_INSTRUCTION_LINES,
  TOKEN_REGEX,
  MASKED_TOKEN,
}

export const HOST_CLI_GET_TIMEOUT_MS = 20_000
export const HOST_CLI_MUTATE_TIMEOUT_MS = 60_000

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

const HOST_SPECS = {
  'claude-code': {
    id: 'claude-code',
    usageCommand: 'setup claude-code',
    displayName: 'Claude Code',
    cliName: 'claude',
    mcpUrl: CLAUDE_MCP_URL,
    docsUrl: CLAUDE_DOCS_URL,
    instructionsPath: (home, env) => join(resolveClaudeConfigDir(env, home), 'CLAUDE.md'),
    instructionsNote: null,
    finalMessage: CLAUDE_FINAL_MESSAGE,
    checkCommand: 'claude mcp get megalens',
    getAddArgs: (token) => [
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'megalens',
      CLAUDE_MCP_URL,
      '--header',
      `Authorization: Bearer ${token}`,
    ],
    formatMaskedAddCommand: (placeholder = MASKED_TOKEN) =>
      `claude mcp add --scope user --transport http megalens "${CLAUDE_MCP_URL}" --header "Authorization: Bearer ${placeholder}"`,
    getRemoveArgs: () => ['mcp', 'remove', '--scope', 'user', 'megalens'],
    formatMaskedRemoveCommand: () => 'claude mcp remove --scope user megalens',
  },
  antigravity: {
    id: 'antigravity',
    usageCommand: 'setup antigravity',
    displayName: 'Antigravity',
    cliName: 'agy',
    mcpUrl: ANTIGRAVITY_MCP_URL,
    docsUrl: ANTIGRAVITY_DOCS_URL,
    mcpConfigPath: (home) => join(home, '.gemini', 'config', 'mcp_config.json'),
    instructionsPath: (home) => join(home, '.gemini', 'GEMINI.md'),
    instructionsNote: GEMINI_CLI_SHARED_NOTE,
    instructionsNoteSingle: GEMINI_CLI_SHARED_NOTE_SINGLE,
    finalMessage: ANTIGRAVITY_FINAL_MESSAGE,
    checkCommand: 'agy mcp list',
    getAddArgs: (token) => [
      'mcp',
      'add',
      '--header',
      `Authorization: Bearer ${token}`,
      'megalens',
      ANTIGRAVITY_MCP_URL,
    ],
    formatMaskedAddCommand: (placeholder = MASKED_TOKEN) =>
      `agy mcp add --header "Authorization: Bearer ${placeholder}" megalens "${ANTIGRAVITY_MCP_URL}"`,
    getRemoveArgs: () => ['mcp', 'remove', 'megalens'],
    formatMaskedRemoveCommand: () => 'agy mcp remove megalens',
  },
}

async function findExecutableOnPath(name, pathValue = '') {
  if (!pathValue) return null
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      const st = await stat(candidate)
      if (!st.isFile() || (st.mode & 0o111) === 0) continue
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep searching PATH
    }
  }
  return null
}

function runHostCli(executable, args, { env, home, timeoutMs = HOST_CLI_MUTATE_TIMEOUT_MS }) {
  return new Promise((resolveRun) => {
    const childEnv = {}
    for (const [key, value] of Object.entries(env ?? {})) {
      if (key.toUpperCase().startsWith('MEGALENS_')) continue
      childEnv[key] = value
    }
    if (!childEnv.HOME) childEnv.HOME = home
    const child = spawn(executable, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let exitCode = null
    let sigkillTimer = null
    let drainTimer = null

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      if (drainTimer) clearTimeout(drainTimer)
    }

    const killGroup = (signal) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {}
      }
      try { child.kill(signal) } catch {}
    }

    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimers()
      try { child.stdout?.destroy() } catch {}
      try { child.stderr?.destroy() } catch {}
      try { child.unref?.() } catch {}
      resolveRun(result)
    }

    const timeoutTimer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          killGroup('SIGTERM')
          sigkillTimer = setTimeout(() => {
            killGroup('SIGKILL')
          }, 2000)
          sigkillTimer.unref?.()
        }, timeoutMs)
      : null

    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (err) => {
      settle({
        notFound: err?.code === 'ENOENT',
        exitCode: err?.code === 'ENOENT' ? null : 1,
        timedOut: false,
        stdout,
        stderr: stderr || String(err?.message ?? err),
      })
    })
    child.once('exit', (code) => {
      exitCode = code
      drainTimer = setTimeout(() => {
        if (timedOut) killGroup('SIGKILL')
        settle({
          notFound: false,
          exitCode: timedOut ? 1 : (exitCode ?? 1),
          timedOut,
          stdout,
          stderr,
        })
      }, 200)
      drainTimer.unref?.()
    })
    child.once('close', (code) => {
      settle({
        notFound: false,
        exitCode: timedOut ? 1 : (code ?? exitCode ?? 1),
        timedOut,
        stdout,
        stderr,
      })
    })
  })
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val)
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

function printNonInteractiveGuide(spec, instructionsPath, log) {
  log(`\n  MegaLens ${spec.displayName} Setup (non-interactive mode: nothing was written)\n`)
  log('  Manual steps:')
  log('  1. Get your MegaLens token at https://megalens.ai/app/settings/mcp')
  log(`  2. Run:\n`)
  log(`     ${spec.formatMaskedAddCommand('ml_tok_your_token_here')}`)
  log(`     Docs: ${spec.docsUrl}`)
  log(`\n  3. Add these lines to ${instructionsPath}:\n`)
  log(`     ${MEGALENS_REVIEW_LINE}`)
  log(`     ${DECISION_LINE}`)
  if (spec.instructionsNote) {
    log(`     Note: ${spec.instructionsNote}`)
  }
  log(`\n  4. ${spec.finalMessage}\n`)
}

function isNotUserScopedRemoveFailure(rem) {
  const combined = `${rem.stderr ?? ''}\n${rem.stdout ?? ''}`
  return /(?:user[\s-]+scope|user[\s-]+settings|user[\s-]+config)/i.test(combined) &&
    /(?:no\s+mcp\s+server|not\s+(?:found|in|user[- ]?scoped)|doesn't\s+exist|does\s+not\s+exist|no\s+.*server)/i.test(combined)
}

function logCliFailure(spec, action, res, token, errLog) {
  if (res.timedOut) {
    errLog(`  ! Timed out trying to ${action} MegaLens in ${spec.displayName}.`)
  } else {
    errLog(`  ! Failed to ${action} MegaLens in ${spec.displayName} (exit ${res.exitCode}).`)
  }
  const maskedStderr = maskTokenSecrets(res.stderr, token).trim()
  if (maskedStderr) {
    for (const line of maskedStderr.split(/\r?\n/)) {
      errLog(`    ${line}`)
    }
  }
  if (res.timedOut) {
    errLog('    This may or may not have finished.')
    errLog(`    To check, run: ${spec.checkCommand}`)
    errLog('    To add it again, run:')
    errLog(`      ${spec.formatMaskedAddCommand()}`)
  }
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
    cliTimeouts,
  } = io
  const getTimeoutMs = cliTimeouts?.get ?? HOST_CLI_GET_TIMEOUT_MS
  const mutateTimeoutMs = cliTimeouts?.mutate ?? HOST_CLI_MUTATE_TIMEOUT_MS

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
    --dry-run       Show what would run or be written without changing anything
    -h, --help      Show this help
`)
    return { exitCode: 0, written: [], connected: false, dryRun: false }
  }

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
    printNonInteractiveGuide(spec, instructionsPath, log)
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

  const cliPath = await findExecutableOnPath(spec.cliName, env.PATH)
  let cliMissing = !cliPath
  let token = envToken || null

  if (!cliMissing) {
    // Resolve/prompt for the token before running `claude mcp get` or reading agy's config,
    // so nothing runs in the background while the user might be pasting.
    const tokenRes = await resolveToken({ env, prompter, errLog })
    if (!tokenRes.token) {
      return { exitCode: tokenRes.exitCode, written, connected, dryRun: parsed.dryRun }
    }
    token = tokenRes.token
  }

  // ── 1 & 2. Check host config / CLI and connect MCP ──
  let existingServer = false
  if (!cliMissing && spec.mcpConfigPath) {
    const mcpConfigPath = spec.mcpConfigPath(home)
    const mcpRead = await readOptionalFile(mcpConfigPath)
    if (mcpRead.unreadable) {
      errLog(`  ! ${mcpConfigPath} could not be read: ${mcpRead.unreadable}`)
      errLog(`    Not touching anything for ${spec.displayName}.`)
      return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
    }
    if (mcpRead.exists) {
      let parsedJson
      try {
        const jsonText = mcpRead.content.startsWith('\uFEFF') ? mcpRead.content.slice(1) : mcpRead.content
        parsedJson = JSON.parse(jsonText)
      } catch (err) {
        errLog(`  ! ${mcpConfigPath} is not valid JSON: ${err?.message ?? err}`)
        errLog(`    Not touching anything for ${spec.displayName}.`)
        return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
      }
      if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
        errLog(`  ! ${mcpConfigPath} is not a valid JSON object.`)
        errLog(`    Not touching anything for ${spec.displayName}.`)
        return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
      }
      const mcpInspection = inspectMcpConfig(parsedJson)
      if (mcpInspection.status === 'found') {
        existingServer = true
      } else if (mcpInspection.status === 'unknown') {
        log(`  ! ${mcpConfigPath} has unrecognised top-level key(s) (${mcpInspection.unknownKeys.join(', ')}); treating existing MegaLens entry as unknown.`)
      }
    }
  }

  if (!cliMissing && spec.id === 'claude-code') {
    if (parsed.dryRun) {
      log('  [dry-run] Note: a live run would check for an existing server first (claude mcp get megalens).\n')
    } else {
      log('  Checking whether Claude Code already has MegaLens...')
      const check = await runHostCli(cliPath, ['mcp', 'get', 'megalens'], { env, home, timeoutMs: getTimeoutMs })
      if (check.notFound) {
        cliMissing = true
      } else if (check.timedOut) {
        log('  ! Timed out checking whether Claude Code already has MegaLens. Treating existing entry as unknown.\n')
      } else if (check.exitCode === 0) {
        existingServer = true
      }
    }
  }

  if (cliMissing) {
    log(`  ! \`${spec.cliName}\` CLI was not found on PATH. Nothing was written or run.`)
    log(`  Run this command manually once ${spec.displayName} is installed:\n`)
    log(`    ${spec.formatMaskedAddCommand()}`)
    log(`  Docs: ${spec.docsUrl}\n`)
  } else if (existingServer) {
    log(`  MegaLens is already configured in ${spec.displayName}.`)
    log('  Will run if you choose to replace it:\n')
    log(`    ${spec.formatMaskedRemoveCommand()}`)
    log(`    ${spec.formatMaskedAddCommand()}\n`)

    let replaceAnswer
    try {
      replaceAnswer = await prompter.askPlain(
        `  Replace existing MegaLens MCP server in ${spec.displayName}? (y/N): `,
      )
    } catch (err) {
      if (err?.exitCode === 130) {
        return { exitCode: 130, written, connected, dryRun: parsed.dryRun }
      }
      throw err
    }

    if (!isYes(replaceAnswer)) {
      log(`  Skipped ${spec.displayName} MCP connection.\n`)
    } else if (parsed.dryRun) {
      dryRunNotes.push(spec.formatMaskedRemoveCommand(), spec.formatMaskedAddCommand())
      log(`  [dry-run] Would run: ${spec.formatMaskedRemoveCommand()}`)
      log(`  [dry-run] Would run: ${spec.formatMaskedAddCommand()}\n`)
    } else {
      const rem = await runHostCli(cliPath, spec.getRemoveArgs(), { env, home, timeoutMs: mutateTimeoutMs })
      if (rem.exitCode !== 0) {
        if (spec.id === 'claude-code' && !rem.timedOut && isNotUserScopedRemoveFailure(rem)) {
          log("  ! The existing MegaLens entry is in this folder's project settings, not your user settings.")
          log('    Nothing was changed there. To add MegaLens for all projects, run this command from another folder.\n')
        } else {
          logCliFailure(spec, 'remove', rem, token, errLog)
          if (spec.id === 'claude-code' && !rem.timedOut) {
            errLog("    The existing MegaLens entry is not in your user settings (it may be in a project's .mcp.json). Nothing was changed.")
          }
          return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
        }
      } else {
        const add = await runHostCli(cliPath, spec.getAddArgs(token), { env, home, timeoutMs: mutateTimeoutMs })
        if (add.exitCode !== 0) {
          logCliFailure(spec, 'add', add, token, errLog)
          if (!add.timedOut) {
            errLog('  The previous MegaLens entry was removed. To add it again, run:')
            errLog(`    ${spec.formatMaskedAddCommand()}`)
          }
          return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
        }
        connected = true
        log(`  Connected MegaLens in ${spec.displayName}.\n`)
      }
    }
  } else {
    log('\n  Will run:\n')
    log(`    ${spec.formatMaskedAddCommand()}\n`)

    let connectAnswer
    try {
      connectAnswer = await prompter.askPlain(
        `  Add MegaLens to ${spec.displayName}? (y/N): `,
      )
    } catch (err) {
      if (err?.exitCode === 130) {
        return { exitCode: 130, written, connected, dryRun: parsed.dryRun }
      }
      throw err
    }

    if (!isYes(connectAnswer)) {
      log(`  Skipped ${spec.displayName} MCP connection.\n`)
    } else if (parsed.dryRun) {
      dryRunNotes.push(spec.formatMaskedAddCommand())
      log(`  [dry-run] Would run: ${spec.formatMaskedAddCommand()}\n`)
    } else {
      const add = await runHostCli(cliPath, spec.getAddArgs(token), { env, home, timeoutMs: mutateTimeoutMs })
      if (add.exitCode !== 0) {
        logCliFailure(spec, 'add', add, token, errLog)
        return { exitCode: 1, written, connected, dryRun: parsed.dryRun }
      }
      connected = true
      log(`  Connected MegaLens in ${spec.displayName}.\n`)
    }
  }

  // ── 3. Global instruction file ──
  const promptText = (missing) => {
    const noun = missing.length > 1 ? 'these lines' : 'this line'
    if (spec.instructionsNote) {
      const note = missing.length > 1
        ? spec.instructionsNote
        : spec.instructionsNoteSingle ?? spec.instructionsNote
      return `  Add ${noun} to ${instructionsPath} so ${spec.displayName} offers a MegaLens review at the right moments? ${note} (y/N): `
    }
    return `  Add ${noun} to ${instructionsPath} so ${spec.displayName} offers a MegaLens review at the right moments? (y/N): `
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
      : '  [dry-run] Nothing would be written or run.')
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
