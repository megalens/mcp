/**
 * Unified one-command installer and uninstaller for the MegaLens CLI.
 *
 * Reuses packages/mcp host setup, TOML helpers, atomic writers, backup helpers,
 * and browser device sign-in. Never prints or logs secrets, never auto-uploads
 * code, and never runs sudo.
 */

import { access, mkdir, realpath, unlink } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { deviceLogin, DeviceLoginError, API_BASE } from './device-login.mjs'
import { resolveCodexHome, inspectCodexConfig, buildHttpHeadersReplacement, readCodexMcpCredentials } from './codex-setup.mjs'
import { resolveClaudeConfigDir, resolveClaudeMcpConfigPath, CLAUDE_MCP_URL, ANTIGRAVITY_MCP_URL } from './host-setup.mjs'
import {
  TOKEN_REGEX,
  backupExistingFile,
  getReadOnlyReason,
  gitTrackable,
  makeTimestamp,
  maskTokenSecrets,
  mergeMcpServerEntry,
  parseUrlOrigin,
  readOptionalFile,
  realLocation,
  verifyFileVersion,
  writeFileAtomicPreservingMode,
} from './setup-shared.mjs'

export const MCP_ENDPOINT = `${API_BASE}/api/mcp`
export const INSTALLER_STATUS_URL = `${API_BASE}/api/installer/status`
export const INSTALLER_REVOKE_URL = `${API_BASE}/api/installer/revoke`
export const DEFAULT_GITHUB_CONNECT_URL = `${API_BASE}/api/github-app/install`
const DASHBOARD_URL = `${API_BASE}/app`
export const GITHUB_INSTALLATIONS_URL = 'https://github.com/settings/installations'
export const MCP_SETTINGS_URL = `${API_BASE}/app/settings/mcp`

const mcpUrlFor = (ide) => `${MCP_ENDPOINT}?ide=${ide}`

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

export function resolveInstallDir(env = process.env, home = homedir(), platform = process.platform) {
  const custom = typeof env.MEGALENS_INSTALL_DIR === 'string' ? env.MEGALENS_INSTALL_DIR.trim() : ''
  if (custom) return resolve(custom)
  if (platform === 'win32') {
    const base = (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()) || join(home, 'AppData', 'Local')
    return join(base, 'megalens')
  }
  return join(home, '.megalens')
}

export function resolveBinDir(env = process.env, home = homedir(), platform = process.platform) {
  const custom = typeof env.MEGALENS_BIN_DIR === 'string' ? env.MEGALENS_BIN_DIR.trim() : ''
  if (custom) return resolve(custom)
  if (platform === 'win32') return join(resolveInstallDir(env, home, platform), 'bin')
  return join(home, '.local', 'bin')
}

export function resolveInstallRecordPath(env = process.env, home = homedir(), platform = process.platform) {
  return join(resolveInstallDir(env, home, platform), 'install-record.json')
}

function vscodeUserDir(env, home, platform) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User')
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Code', 'User')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Code', 'User')
}

function codexPaths(env, home) {
  const custom = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  if (custom) return [join(resolveCodexHome(env, home), 'config.toml')]
  return [
    join(home, '.codex', 'config.toml'),
    join(home, '.config', 'codex', 'config.toml'),
  ]
}

export function buildInstallerTools({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const vsDir = vscodeUserDir(env, home, platform)
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      format: 'json',
      mapKey: 'mcpServers',
      mcpUrl: CLAUDE_MCP_URL,
      configPaths: [resolveClaudeMcpConfigPath(env, home)],
      detectDirs: [resolveClaudeConfigDir(env, home)],
      detectBins: ['claude'],
      defaultFields: {},
      buildEntry: (token) => ({
        type: 'http',
        url: CLAUDE_MCP_URL,
        headers: { Authorization: `Bearer ${token}` },
      }),
    },
    {
      id: 'cursor',
      name: 'Cursor',
      format: 'json',
      mapKey: 'mcpServers',
      mcpUrl: mcpUrlFor('cursor'),
      configPaths: [join(home, '.cursor', 'mcp.json')],
      detectDirs: [join(home, '.cursor')],
      detectBins: ['cursor'],
      defaultFields: {},
      buildEntry: (token) => ({
        url: mcpUrlFor('cursor'),
        headers: { Authorization: `Bearer ${token}` },
      }),
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      format: 'toml',
      headerKey: 'http_headers',
      mcpUrl: mcpUrlFor('codex'),
      configPaths: codexPaths(env, home),
      detectDirs: [resolveCodexHome(env, home)],
      detectBins: ['codex'],
      toml: (token) =>
        `\n[mcp_servers.megalens]\nurl = "${mcpUrlFor('codex')}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }\n`,
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      format: 'json',
      mapKey: 'mcpServers',
      mcpUrl: mcpUrlFor('gemini-cli'),
      configPaths: [join(home, '.gemini', 'settings.json')],
      detectDirs: [],
      detectBins: ['gemini'],
      defaultFields: {},
      buildEntry: (token) => ({
        httpUrl: mcpUrlFor('gemini-cli'),
        headers: { Authorization: `Bearer ${token}` },
      }),
    },
    {
      id: 'antigravity',
      name: 'Google Antigravity',
      format: 'json',
      mapKey: 'mcpServers',
      mcpUrl: ANTIGRAVITY_MCP_URL,
      configPaths: [join(home, '.gemini', 'config', 'mcp_config.json')],
      detectDirs: [join(home, '.gemini', 'config')],
      detectBins: ['agy'],
      defaultFields: { disabled: false },
      buildEntry: (token) => ({
        serverUrl: ANTIGRAVITY_MCP_URL,
        headers: { Authorization: `Bearer ${token}` },
      }),
    },
    {
      id: 'vscode',
      name: 'VS Code (Copilot)',
      format: 'json',
      mapKey: 'servers',
      mcpUrl: mcpUrlFor('copilot'),
      configPaths: [join(vsDir, 'mcp.json')],
      detectDirs: [vsDir],
      detectBins: [],
      defaultFields: {},
      buildEntry: (token) => ({
        type: 'http',
        url: mcpUrlFor('copilot'),
        headers: { Authorization: `Bearer ${token}` },
      }),
    },
    {
      id: 'copilot-cli',
      name: 'GitHub Copilot CLI',
      format: 'json',
      mapKey: 'mcpServers',
      mcpUrl: mcpUrlFor('copilot'),
      configPaths: [join(home, '.copilot', 'mcp-config.json')],
      detectDirs: [join(home, '.copilot')],
      detectBins: [],
      defaultFields: {},
      buildEntry: (token) => ({
        type: 'http',
        url: mcpUrlFor('copilot'),
        headers: { Authorization: `Bearer ${token}` },
      }),
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      format: 'json',
      mapKey: 'mcpServers',
      mcpUrl: mcpUrlFor('windsurf'),
      configPaths: [join(home, '.codeium', 'windsurf', 'mcp_config.json')],
      detectDirs: [join(home, '.codeium', 'windsurf')],
      detectBins: [],
      defaultFields: {},
      buildEntry: (token) => ({
        serverUrl: mcpUrlFor('windsurf'),
        headers: { Authorization: `Bearer ${token}` },
      }),
    },
  ]
}

async function pathExists(p) {
  try {
    await access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Check whether any candidate binary exists on PATH without executing anything. */
export async function binaryOnPath(names, env = process.env, platform = process.platform) {
  if (!Array.isArray(names) || names.length === 0) return null
  const rawPath = env.PATH || env.Path || ''
  if (!rawPath) return null
  const sep = platform === 'win32' ? ';' : ':'
  const dirs = rawPath.split(sep).filter(Boolean)
  const exts = platform === 'win32'
    ? ((env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
    : ['']
  const mode = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK

  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, `${name}${ext}`)
        try {
          await access(candidate, mode)
          return candidate
        } catch {
          // continue
        }
      }
    }
  }
  return null
}

/**
 * Detect installed AI tools by checking existing config files, tool directories,
 * and binaries on PATH. Returns one entry per detected tool with `activePath` and `detectedBy`.
 */
export async function detectInstalledTools({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const tools = buildInstallerTools({ env, home, platform })
  const found = []

  for (const tool of tools) {
    let activePath = null
    let detectedBy = null

    for (const p of tool.configPaths) {
      if (await pathExists(p)) {
        activePath = p
        detectedBy = 'config'
        break
      }
    }

    if (!activePath) {
      for (const dir of tool.detectDirs) {
        if (await pathExists(dir)) {
          activePath = tool.configPaths[0]
          detectedBy = 'directory'
          break
        }
      }
    }

    if (!activePath) {
      const binPath = await binaryOnPath(tool.detectBins, env, platform)
      if (binPath) {
        activePath = tool.configPaths[0]
        detectedBy = `binary (${basename(binPath)})`
      }
    }

    if (activePath) {
      found.push({ ...tool, activePath, detectedBy })
    }
  }

  return found
}

async function preflightTarget(tool, filePath, { env, tomlHelpers }) {
  const read = await readOptionalFile(filePath)
  if (read.unreadable !== null) {
    return `unreadable (${read.unreadable})`
  }
  if (read.exists) {
    const readOnly = await getReadOnlyReason(filePath)
    if (readOnly) return `read-only (${readOnly})`
  }

  if (tool.format === 'toml') {
    if (read.exists && read.content.trim() !== '') {
      const info = inspectCodexConfig(read.content, tomlHelpers, { headerKey: tool.headerKey ?? 'http_headers' })
      if (info.unparseable) return 'could not be read as valid TOML'
      if (info.uneditable) return 'has a MegaLens entry in a form setup cannot edit safely'
    }
  } else if (read.exists && read.content.trim() !== '') {
    try {
      const text = read.content.startsWith('\uFEFF') ? read.content.slice(1) : read.content
      const parsed = JSON.parse(text)
      if (!isPlainObject(parsed)) return 'JSON root is not an object'
      if (Object.prototype.hasOwnProperty.call(parsed, tool.mapKey) && !isPlainObject(parsed[tool.mapKey])) {
        return `"${tool.mapKey}" field is not an object`
      }
    } catch {
      return 'not plain JSON (may contain comments or syntax errors)'
    }
  }

  const real = await realLocation(filePath)
  if (real === null) {
    return 'path could not be resolved safely (dangling symlink or permission error)'
  }
  const tracked = gitTrackable(real, env)
  if (tracked !== 'no') {
    return tracked === 'yes'
      ? 'inside a git repository and not ignored (refusing to store a token in git)'
      : 'could not confirm the path is outside a git repository'
  }

  // Check nearest existing ancestor directory is writable.
  let dir = dirname(real)
  for (;;) {
    try {
      await access(dir, fsConstants.W_OK)
      break
    } catch (err) {
      if (err?.code !== 'ENOENT') return `folder ${dir} is not writable`
      const up = dirname(dir)
      if (up === dir) return `no writable folder for ${real}`
      dir = up
    }
  }

  return null
}

async function registerToolConfig(tool, filePath, token, { env, home, platform, timestamp, tomlHelpers, log }) {
  const backupOpts = { mode: 0o600, env, home, platform, log }
  const MAX_WRITE_ATTEMPTS = 3
  let backedUp = false
  let backupPath = null
  let createdFile = false

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const read = await readOptionalFile(filePath)
    if (read.unreadable !== null) {
      return { status: 'skipped', reason: read.unreadable }
    }
    if (read.exists) {
      const readOnly = await getReadOnlyReason(filePath)
      if (readOnly) return { status: 'skipped', reason: `read-only (${readOnly})` }
    }
    if (attempt === 0) createdFile = !read.exists

    let nextContents
    if (tool.format === 'toml') {
      const existing = read.exists ? read.content : ''
      const headerKey = tool.headerKey ?? 'http_headers'
      const info = existing
        ? inspectCodexConfig(existing, tomlHelpers, { headerKey })
        : { unparseable: false, uneditable: false, hasEntry: false }
      if (info.unparseable || info.uneditable) {
        return { status: 'skipped', reason: info.unparseable ? 'unparseable TOML' : 'uneditable MegaLens TOML entry' }
      }
      const eol = existing.includes('\r\n') ? '\r\n' : '\n'
      if (info.hasEntry) {
        nextContents = buildHttpHeadersReplacement(info, token, eol, { headerKey, mcpUrl: tool.mcpUrl }).nextConfig
      } else {
        const base = existing.replace(/\s+$/, '')
        nextContents = (base ? `${base}\n` : '') + tool.toml(token)
      }
    } else {
      let data = {}
      if (read.exists && read.content.trim() !== '') {
        try {
          const text = read.content.startsWith('\uFEFF') ? read.content.slice(1) : read.content
          data = JSON.parse(text)
        } catch (err) {
          return { status: 'skipped', reason: `invalid JSON (${err?.message ?? 'parse error'})` }
        }
        if (!isPlainObject(data)) {
          return { status: 'skipped', reason: 'JSON root is not an object' }
        }
        if (Object.prototype.hasOwnProperty.call(data, tool.mapKey) && !isPlainObject(data[tool.mapKey])) {
          return { status: 'skipped', reason: `"${tool.mapKey}" is not an object` }
        }
      }
      const merged = mergeMcpServerEntry(data, tool.mapKey, tool.buildEntry(token), {
        defaultFields: tool.defaultFields ?? {},
      })
      nextContents = JSON.stringify(merged, null, 2) + '\n'
    }

    const target = await realpath(filePath).catch(() => filePath)
    if (read.exists && !backedUp) {
      backupPath = await backupExistingFile(target, timestamp, backupOpts)
      backedUp = true
      if (!(await verifyFileVersion(filePath, read.version))) continue
    }
    try {
      await writeFileAtomicPreservingMode(filePath, nextContents, {
        defaultMode: 0o600,
        preserveMode: false,
        log,
        expectedVersion: read.version,
      })
      return { status: 'written', backupPath, createdFile }
    } catch (err) {
      if (err?.code === 'ECONCURRENT') continue
      throw err
    }
  }
  throw new Error(`${filePath} kept changing while saving`)
}

/**
 * Query GitHub App connection status on the signed-in account.
 * Never prints or leaks the bearer token; only accepts megalens.ai connect URLs.
 */
export async function fetchGithubStatus(token, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(INSTALLER_STATUS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { known: false }
    const data = await res.json().catch(() => null)
    const gh = data?.github
    if (typeof gh?.connected !== 'boolean') return { known: false }
    if (gh.connected === true) {
      const count = typeof gh.repo_count === 'number' && Number.isInteger(gh.repo_count) && gh.repo_count >= 0
        ? gh.repo_count
        : 0
      return { known: true, connected: true, repoCount: count, manageUrl: GITHUB_INSTALLATIONS_URL }
    }
    const rawUrl = typeof gh.connect_url === 'string' ? gh.connect_url : ''
    const safeConnectUrl = rawUrl.startsWith(`${API_BASE}/`) ? rawUrl : DASHBOARD_URL
    return { known: true, connected: false, repoCount: 0, connectUrl: safeConnectUrl }
  } catch {
    return { known: false }
  }
}

export function formatGithubStatusLines(status) {
  if (!status?.known) {
    return [`  GitHub: could not check connection status. Check ${DASHBOARD_URL}`]
  }
  if (status?.connected) {
    const n = status.repoCount
    const noun = n === 1 ? 'repo' : 'repos'
    return [`  GitHub: connected (${n} ${noun})`]
  }
  const url = status?.connectUrl && status.connectUrl.startsWith(`${API_BASE}/`)
    ? status.connectUrl
    : DEFAULT_GITHUB_CONNECT_URL
  return [
    '  GitHub: not connected yet',
    `  Connect GitHub: ${url}`,
  ]
}

async function saveInstallRecord(recordPath, record, log) {
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 }).catch(() => {})
  const payload = JSON.stringify(record, null, 2) + '\n'
  await writeFileAtomicPreservingMode(recordPath, payload, {
    defaultMode: 0o600,
    preserveMode: false,
    log,
  })
}

async function readInstallRecord(recordPath) {
  const read = await readOptionalFile(recordPath)
  if (!read.exists || read.unreadable || !read.content.trim()) return null
  try {
    const parsed = JSON.parse(read.content)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function collectLaunchers(installDir, binDir, platform) {
  const list = []
  if (platform === 'win32') {
    list.push(join(binDir, 'megalens.cmd'), join(binDir, 'megalens.ps1'))
  } else {
    list.push(join(installDir, 'bin', 'megalens'))
    const userLauncher = join(binDir, 'megalens')
    if (userLauncher !== list[0]) list.push(userLauncher)
  }
  return list
}

function isSafeLauncherToRemove(candidate, installDir, binDir) {
  if (typeof candidate !== 'string' || !candidate) return false
  const resolved = resolve(candidate)
  const name = basename(resolved).toLowerCase()
  if (!name.startsWith('megalens')) return false
  const allowedDirs = [resolve(binDir), resolve(join(installDir, 'bin'))]
  return allowedDirs.includes(dirname(resolved))
}

function extractMegalensTokenFromJsonEntry(entry) {
  if (!isPlainObject(entry)) return null
  const urls = [entry.url, entry.httpUrl, entry.serverUrl, entry.sseUrl, entry.baseUrl].filter((u) => u !== undefined)
  if (urls.length === 0) return null
  const origins = urls.map((u) => parseUrlOrigin(u))
  if (origins.some((o) => o !== API_BASE)) return null
  const auth = entry.headers?.Authorization ?? entry.headers?.authorization
  if (typeof auth !== 'string') return null
  const t = auth.replace(/^Bearer\s+/i, '').trim()
  return TOKEN_REGEX.test(t) ? t : null
}

function isMegalensJsonEntry(entry) {
  if (!isPlainObject(entry)) return false
  const urls = [entry.url, entry.httpUrl, entry.serverUrl, entry.sseUrl, entry.baseUrl].filter((u) => typeof u === 'string')
  return urls.length > 0 && urls.every((u) => parseUrlOrigin(u) === API_BASE)
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function printUninstallCommand(binDir, env, platform, log) {
  if (platform !== 'win32' && !(env.PATH ?? '').split(':').includes(binDir)) {
    log(`  To uninstall later: ${shellQuote(join(binDir, 'megalens'))} uninstall`)
    log(`  To use megalens from your shell, add this to your shell profile:`)
    log(`    export PATH=${shellQuote(binDir)}:"$PATH"`)
    return
  }
  log('  To uninstall later: megalens uninstall')
}

async function revokeTokenOnServer(token, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(INSTALLER_REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => null)
    if (res.ok && data?.revoked === true) {
      return { revoked: true, label: typeof data.label === 'string' ? data.label : null }
    }
    return { revoked: false, status: res.status }
  } catch {
    return { revoked: false, status: 0 }
  }
}

export function parseInstallArgs(args = []) {
  let dryRun = false
  let help = false
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--help' || arg === '-h') help = true
    else return { error: `Unknown option for install: ${maskTokenSecrets(arg)}` }
  }
  return { dryRun, help }
}

export function parseUninstallArgs(args = []) {
  let dryRun = false
  let help = false
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--help' || arg === '-h') help = true
    else return { error: `Unknown option for uninstall: ${maskTokenSecrets(arg)}` }
  }
  return { dryRun, help }
}

export async function runInstall(args = [], io = {}) {
  const {
    env = process.env,
    home = homedir(),
    platform = process.platform,
    log = (s = '') => console.log(s),
    errLog = (s = '') => console.error(s),
    askAccount,
    askYes,
    login = deviceLogin,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    tomlHelpers,
  } = io

  const parsed = parseInstallArgs(args)
  if (parsed.error) {
    errLog(`  ${parsed.error}`)
    return { exitCode: 1 }
  }
  if (parsed.help) {
    log(`
  Usage: megalens install [options]

  Signs in through your browser, detects installed AI coding tools,
  backs up existing configs, registers MegaLens, and checks GitHub status.

  Options:
    --dry-run   Detect tools and show proposed changes without writing anything
    -h, --help  Show this help
`)
    return { exitCode: 0 }
  }

  log('\n  MegaLens Setup\n')
  if (parsed.dryRun) {
    log('  [dry-run] No files will be modified and no sign-in will start.\n')
  }

  // 1. Detect installed AI tools and preflight each target config BEFORE signing in.
  const detected = await detectInstalledTools({ env, home, platform })
  const eligible = []
  const skipped = []

  for (const tool of detected) {
    const reason = await preflightTarget(tool, tool.activePath, { env, tomlHelpers })
    if (reason) {
      skipped.push({ tool, reason })
    } else {
      eligible.push(tool)
    }
  }

  if (eligible.length > 0) {
    log('  Detected AI tools:')
    for (const t of eligible) {
      log(`    - ${t.name} (${t.activePath})`)
    }
  } else {
    log('  No local AI tools detected on this machine.')
  }

  if (skipped.length > 0) {
    log('')
    log('  Skipped (left untouched):')
    for (const s of skipped) {
      log(`    ! ${s.tool.name} (${s.tool.activePath}): ${s.reason}`)
    }
  }

  if (parsed.dryRun) {
    log('')
    log(eligible.length > 0
      ? `  [dry-run] Would sign in via browser and register MegaLens in ${eligible.length} tool(s).`
      : '  [dry-run] No eligible tool configs to update.')
    log('')
    return { exitCode: 0, eligible: eligible.map((t) => t.id), skipped: skipped.map((s) => s.tool.id) }
  }

  // 2. Browser sign-in (device flow, account confirmation in terminal).
  log('\n  Step 1 of 2: sign in to MegaLens in your browser.')
  let loginResult
  try {
    loginResult = await login({
      client: 'megalens-mcp',
      env,
      platform,
      fetchImpl,
      allowReplace: true,
      log: (line) => log(maskTokenSecrets(line)),
      confirmAccount: async (account, { replaces } = {}) => {
        log(`\n  Approved in the browser by: ${account}`)
        if (replaces) {
          log('  Note: this replaces a previous editor token on this account.')
        }
        return askAccount('  Is that your MegaLens account? (y/n): ')
      },
    })
  } catch (err) {
    const msg = err instanceof DeviceLoginError ? err.message : 'The sign-in failed.'
    errLog(`\n  ${maskTokenSecrets(msg)}`)
    if (!(err instanceof DeviceLoginError) || !['wrong_account', 'wrong_label', 'unconfirmed', 'no_answer'].includes(err.code)) {
      errLog('  You can also paste a token instead: megalens setup --manual')
    }
    errLog('')
    return { exitCode: 1 }
  }

  log(`\n  Signed in as ${loginResult.account}.`)

  // 3. Check GitHub connection status on the account (never uploads any local files).
  const ghStatus = await fetchGithubStatus(loginResult.token, { fetchImpl })
  for (const line of formatGithubStatusLines(ghStatus)) {
    log(line)
  }

  // 4. Register MegaLens in detected eligible tools after one confirmation.
  const configured = []
  const failed = []
  const recordedEntries = []
  const timestamp = makeTimestamp(now())

  if (eligible.length > 0) {
    log('\n  Step 2 of 2: register MegaLens in your detected tools (backups created first).')
    const proceed = await askYes(
      `  Apply MegaLens config to ${eligible.length === 1 ? eligible[0].name : `these ${eligible.length} tools`}? (Y/n): `,
      true,
    )
    if (!proceed) {
      log('\n  Skipped updating tool configs.\n')
    } else {
      for (const tool of eligible) {
        try {
          const res = await registerToolConfig(tool, tool.activePath, loginResult.token, {
            env,
            home,
            platform,
            timestamp,
            tomlHelpers,
            log,
          })
          if (res.status === 'written') {
            log(`  Configured ${tool.name} (${tool.activePath})`)
            configured.push(tool.name)
            recordedEntries.push({
              toolId: tool.id,
              toolName: tool.name,
              path: tool.activePath,
              format: tool.format,
              ...(tool.mapKey ? { mapKey: tool.mapKey } : {}),
              backupPath: res.backupPath ?? null,
              createdFile: res.createdFile,
            })
          } else {
            log(`  ! Skipped ${tool.name} (${tool.activePath}): ${maskTokenSecrets(res.reason)}`)
            failed.push(tool.name)
          }
        } catch (err) {
          log(`  ! Could not update ${tool.name} (${tool.activePath}): ${maskTokenSecrets(err?.code ?? err?.message ?? 'error')}`)
          failed.push(tool.name)
        }
      }
    }
  } else {
    log('\n  No local editor configs were updated.')
    log('  For ChatGPT, Claude.ai, or Lovable, see: https://megalens.ai/integrations')
  }

  // Save install record (metadata only, never stores the plaintext token).
  const installDir = resolveInstallDir(env, home, platform)
  const binDir = resolveBinDir(env, home, platform)
  const recordPath = resolveInstallRecordPath(env, home, platform)
  const existingRecord = await readInstallRecord(recordPath)
  if (configured.length === 0) {
    const result = await revokeTokenOnServer(loginResult.token, { fetchImpl })
    if (!result.revoked) {
      log(`  Pending revocation: revoke the unused editor token at ${MCP_SETTINGS_URL}`)
    }
  }
  const priorEntries = Array.isArray(existingRecord?.entries) ? existingRecord.entries : []
  const byPath = new Map()
  for (const e of priorEntries) {
    if (isPlainObject(e) && typeof e.path === 'string') byPath.set(e.path, e)
  }
  for (const e of recordedEntries) byPath.set(e.path, e)

  await saveInstallRecord(
    recordPath,
    {
      version: 1,
      installedAt: now().toISOString(),
      tokenLabel: (configured.length > 0 ? loginResult.label : existingRecord?.tokenLabel) ?? null,
      installDir,
      binDir,
      launchers: collectLaunchers(installDir, binDir, platform),
      entries: Array.from(byPath.values()),
    },
    log,
  ).catch(() => {})

  // 5. Final summary.
  log('')
  if (configured.length > 0) {
    log(`  Done! MegaLens was registered in: ${configured.join(', ')}`)
    log('  No token was shown or copied.')
    log(`  Reload ${configured.length > 1 ? 'those tools' : configured[0]}, then ask: "review this with MegaLens"`)
  }
  if (failed.length > 0) {
    log(`  Not updated: ${failed.join(', ')} (see warnings above).`)
  }
  printUninstallCommand(binDir, env, platform, log)
  log('')

  return {
    exitCode: failed.length > 0 && configured.length === 0 ? 1 : 0,
    configured,
    failed,
    github: ghStatus,
  }
}

function planConfigRemoval(target, content, tomlHelpers) {
  const otherHost = 'megalens entry points to another host (kept)'
  if (target.format === 'toml') {
    const info = inspectCodexConfig(content, tomlHelpers)
    if (info.unparseable) return { reason: 'could not parse TOML safely' }
    if (!info.hasEntry) return null
    if (info.uneditable) return { reason: 'could not remove MegaLens block safely' }
    const credentials = readCodexMcpCredentials(info)
    if (parseUrlOrigin(credentials?.url) !== API_BASE) return { reason: otherHost }
    const tablePath = tomlHelpers.tomlHeaderPath(info.lines[info.megalensStartIdx])
    const next = tomlHelpers.stripTomlTable(content, tablePath)
    if (next === null || next === content) return { reason: 'could not remove MegaLens block safely' }
    const token = /^Bearer\s+(ml_tok_[0-9a-f]{32})$/i.exec(credentials.authorization?.trim() ?? '')?.[1]
    return { next, token }
  }

  if (!content.trim()) return null
  let data
  try {
    data = JSON.parse(content.startsWith('\uFEFF') ? content.slice(1) : content)
  } catch {
    return { reason: 'could not parse JSON safely' }
  }
  if (!isPlainObject(data)) return null
  const map = data[target.mapKey]
  if (!isPlainObject(map) || !Object.hasOwn(map, 'megalens')) return null
  if (!isMegalensJsonEntry(map.megalens)) return { reason: otherHost }

  const { megalens, ...remaining } = map
  const next = JSON.stringify({ ...data, [target.mapKey]: remaining }, null, 2) + '\n'
  return { next, token: extractMegalensTokenFromJsonEntry(megalens) }
}

async function removeToolConfig(target, { dryRun, timestamp, env, home, platform, log, tomlHelpers }) {
  const maxAttempts = 3
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let token
    try {
      const read = await readOptionalFile(target.path)
      if (read.unreadable !== null) return { reason: `unreadable (${read.unreadable})` }
      if (!read.exists) return null

      const removal = planConfigRemoval(target, read.content, tomlHelpers)
      if (!removal || removal.reason) return removal
      token = removal.token
      const readOnly = await getReadOnlyReason(target.path)
      if (readOnly) return { token, reason: `locked/read-only (${readOnly})` }
      if (!dryRun) {
        await backupExistingFile(read.version.target, timestamp, { mode: 0o600, env, home, platform, log })
        await writeFileAtomicPreservingMode(target.path, removal.next, {
          defaultMode: 0o600,
          preserveMode: true,
          log,
          expectedVersion: read.version,
        })
      }
      return { token, removed: true }
    } catch (err) {
      if (err?.code === 'ECONCURRENT' && attempt < maxAttempts - 1) continue
      return {
        token: err?.code === 'ECONCURRENT' ? null : token,
        reason: maskTokenSecrets(err?.code === 'ECONCURRENT'
          ? 'file kept changing while saving'
          : err?.code ?? err?.message ?? 'could not update config'),
      }
    }
  }
}

/**
 * Remove MegaLens entries from recorded and detected tool configs (preserving all other
 * servers and later user edits), revoke this installation's editor token if reachable,
 * remove user-level launchers, and report GitHub App management link.
 */
export async function runUninstall(args = [], io = {}) {
  const {
    env = process.env,
    home = homedir(),
    platform = process.platform,
    log = (s = '') => console.log(s),
    errLog = (s = '') => console.error(s),
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    tomlHelpers,
  } = io

  const parsed = parseUninstallArgs(args)
  if (parsed.error) {
    errLog(`  ${parsed.error}`)
    return { exitCode: 1 }
  }
  if (parsed.help) {
    log(`
  Usage: megalens uninstall [options]

  Removes MegaLens entries from your AI tool configs (preserving your other
  settings), revokes this installation's credential, and removes launchers.

  Options:
    --dry-run   Show what would be removed without changing anything
    -h, --help  Show this help
`)
    return { exitCode: 0 }
  }

  log('\n  MegaLens Uninstall\n')
  if (parsed.dryRun) {
    log('  [dry-run] No files or credentials will be modified.\n')
  }

  const installDir = resolveInstallDir(env, home, platform)
  const binDir = resolveBinDir(env, home, platform)
  const recordPath = resolveInstallRecordPath(env, home, platform)
  const record = await readInstallRecord(recordPath)
  const timestamp = makeTimestamp(now())

  // Gather candidate targets from both the install record and known user-level configs.
  const tools = buildInstallerTools({ env, home, platform })
  const toolById = new Map(tools.map((t) => [t.id, t]))
  const targetsByPath = new Map()

  if (Array.isArray(record?.entries)) {
    for (const entry of record.entries) {
      if (!isPlainObject(entry) || typeof entry.path !== 'string') continue
      const tool = toolById.get(entry.toolId)
      targetsByPath.set(entry.path, {
        name: typeof entry.toolName === 'string' ? entry.toolName : (tool?.name ?? entry.path),
        path: entry.path,
        format: entry.format === 'toml' ? 'toml' : 'json',
        mapKey: typeof entry.mapKey === 'string' ? entry.mapKey : (tool?.mapKey ?? 'mcpServers'),
      })
    }
  }
  for (const tool of tools) {
    for (const p of tool.configPaths) {
      if (!targetsByPath.has(p)) {
        targetsByPath.set(p, {
          name: tool.name,
          path: p,
          format: tool.format,
          mapKey: tool.mapKey ?? 'mcpServers',
        })
      }
    }
  }

  const removedConfigs = []
  const lockedOrSkipped = []
  const discoveredTokens = new Set()

  for (const target of targetsByPath.values()) {
    const result = await removeToolConfig(target, {
      dryRun: parsed.dryRun, timestamp, env, home, platform, log, tomlHelpers,
    })
    if (!result) continue
    if (result.token) discoveredTokens.add(result.token)
    if (result.reason) {
      lockedOrSkipped.push({ name: target.name, path: target.path, reason: maskTokenSecrets(result.reason) })
    }
    if (result.removed) {
      log(parsed.dryRun
        ? `  [dry-run] Would remove MegaLens from ${target.name} (${target.path})`
        : `  Removed MegaLens from ${target.name} (${target.path})`)
      removedConfigs.push(target.path)
    }
  }

  // Revoke discovered per-installation token(s) on MegaLens.
  let revokedCount = 0
  let pendingRevocation = false
  if (discoveredTokens.size > 0) {
    for (const tok of discoveredTokens) {
      if (parsed.dryRun) {
        log('  [dry-run] Would revoke this installation credential on MegaLens.')
        continue
      }
      const r = await revokeTokenOnServer(tok, { fetchImpl })
      if (r.revoked) {
        revokedCount++
        log(`  Revoked installation credential${r.label ? ` (${r.label})` : ''}.`)
      } else {
        pendingRevocation = true
      }
    }
  } else if (record?.tokenLabel) {
    pendingRevocation = true
  }

  if (pendingRevocation && !parsed.dryRun) {
    log(`  Pending revocation: revoke any remaining editor token at ${MCP_SETTINGS_URL}`)
  }

  // Remove user-level launchers and install record.
  const launchers = Array.isArray(record?.launchers) && record.launchers.length > 0
    ? record.launchers
    : collectLaunchers(installDir, binDir, platform)
  const removedLaunchers = []
  for (const launcherPath of launchers) {
    if (!isSafeLauncherToRemove(launcherPath, installDir, binDir)) continue
    if (!(await pathExists(launcherPath))) continue
    if (parsed.dryRun) {
      log(`  [dry-run] Would remove launcher ${launcherPath}`)
      removedLaunchers.push(launcherPath)
      continue
    }
    try {
      await unlink(launcherPath)
      log(`  Removed launcher ${launcherPath}`)
      removedLaunchers.push(launcherPath)
    } catch (err) {
      lockedOrSkipped.push({ name: 'Launcher', path: launcherPath, reason: maskTokenSecrets(err?.code ?? err?.message ?? 'could not remove') })
    }
  }

  if (!parsed.dryRun && (await pathExists(recordPath))) {
    await unlink(recordPath).catch(() => {})
  }

  if (lockedOrSkipped.length > 0) {
    log('')
    log('  Needs attention (locked or skipped):')
    for (const item of lockedOrSkipped) {
      log(`    ! ${item.name} (${item.path}): ${item.reason}`)
    }
  }

  log('')
  if (removedConfigs.length === 0 && removedLaunchers.length === 0 && revokedCount === 0 && !parsed.dryRun) {
    log('  No MegaLens installation entries were found to remove.')
  } else if (!parsed.dryRun) {
    log('  MegaLens has been uninstalled from your local tools.')
  }
  log(`  GitHub App (if connected) continues independently on GitHub. Manage or remove it at: ${GITHUB_INSTALLATIONS_URL}`)
  log('')

  return {
    exitCode: 0,
    removedConfigs,
    removedLaunchers,
    lockedOrSkipped,
    revokedCount,
    pendingRevocation,
  }
}
