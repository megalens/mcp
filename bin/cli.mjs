#!/usr/bin/env node

/**
 * @megalens/mcp — CLI setup helper
 *
 * Usage:
 *   megalens-mcp setup                Sign in through the browser, write the token into your tools
 *   megalens-mcp setup --manual       Same, but paste a token from megalens.ai/app/settings/mcp
 *   megalens-mcp setup codex          Interactive Codex setup (config.toml + AGENTS.md)
 *   megalens-mcp setup claude-code    Interactive Claude Code setup (CLI + CLAUDE.md)
 *   megalens-mcp setup antigravity    Interactive Antigravity setup (CLI + GEMINI.md)
 *   megalens-mcp setup agy            Alias for setup antigravity
 *   megalens-mcp validate             Test your token connectivity
 *   megalens-mcp config               Show current config location + status
 */

import { readFile, writeFile, access, mkdir, chmod, rename, unlink, realpath, stat, chown } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'
import { runSetupCodex, resolveCodexHome, inspectCodexConfig, buildHttpHeadersReplacement } from './codex-setup.mjs'
import { runSetupClaudeCode, runSetupAntigravity, resolveClaudeConfigDir, resolveClaudeMcpConfigPath } from './host-setup.mjs'
import { maskTokenSecrets, MASKED_TOKEN, TOKEN_REGEX, answerIsYes, readHiddenLine, backupExistingFile, makeTimestamp, gitTrackable, realLocation, mergeMcpServerEntry, readOptionalFile, verifyFileVersion, writeFileAtomicPreservingMode } from './setup-shared.mjs'
import { deviceLogin, DeviceLoginError } from './device-login.mjs'

const API_BASE = 'https://megalens.ai'
const MCP_URL = `${API_BASE}/api/mcp`

/**
 * Each tool gets a URL that says which tool it is.
 *
 * The server has a whole attribution chain for this -- an `x-megalens-caller`
 * header, then `?ide=`, then User-Agent sniffing -- and this client was handing
 * every tool the same bare URL, so most runs arrived as `unknown`. The tag is
 * attribution only: it tells MegaLens which tool sent the review. It does not
 * change which models review the code.
 *
 * `?ide=` rather than a header because it survives every config format here,
 * including Codex's TOML and VS Code's, where header support is not documented.
 */
/**
 * Always the production endpoint (Astra FIX 15 and FIX 4, persistent destination): sign-in has no
 * issuer override, so only a production-issued bearer is ever written, and only next to this URL.
 */
const mcpUrlFor = (ide) => `${MCP_URL}?ide=${ide}`
const VALIDATE_URL = `${API_BASE}/api/mcp/validate`

// ── Helpers ──

/**
 * One line reader for every visible prompt. A new readline per question loses answers that arrive
 * together (piped input, a fast paste): the first interface buffers them all and closes, and the
 * next question waits forever. Found by the browser sign-in tests, which answer several prompts at once.
 */
let sharedLines = null
function nextLine() {
  if (!sharedLines) {
    const queue = []
    const waiters = []
    let closed = false
    const iface = createInterface({ input: process.stdin, terminal: false })
    iface.on('line', (line) => (waiters.length ? waiters.shift()(line) : queue.push(line)))
    // End of input resolves null, never '': an empty answer takes a prompt's default, and a closed
    // stdin must not answer "yes" to anything (Astra FIX 12 #8).
    iface.on('close', () => {
      closed = true
      while (waiters.length) waiters.shift()(null)
    })
    sharedLines = {
      iface,
      read: () => (queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(null) : new Promise((r) => waiters.push(r))),
    }
  }
  return sharedLines.read()
}

function closeInput() {
  sharedLines?.iface.close()
}

/** The input ended before a question was answered. Setup stops; nothing more is changed. */
class InputEnded extends Error {}

/** One answer, trimmed; null when the input has ended. */
function ask(prompt, { hidden = false } = {}) {
  if (!hidden || !process.stdin.isTTY) {
    // Not a terminal: nothing to hide from, and raw mode is unavailable. Read the line.
    process.stdout.write(prompt)
    return nextLine().then((a) => {
      if (hidden) process.stdout.write('\n')
      return a === null ? null : a.trim()
    })
  }
  // A hidden read on a terminal reads raw keys itself; the shared line reader must not also see them.
  if (sharedLines) {
    sharedLines.iface.close()
    sharedLines = null
  }
  return readHiddenLine({ prompt })
}

/** A yes/no question. Empty takes the default; end of input stops setup (never a default yes). */
async function askYes(prompt, defaultYes) {
  const a = await ask(prompt)
  if (a === null) throw new InputEnded()
  return answerIsYes(a, defaultYes)
}

/**
 * "Is this your account?" has no default (Astra FIX 12 #8): only y/yes or n/no count, anything
 * else asks again (three times). null when the input ends or no clear answer comes.
 */
async function askAccount(prompt) {
  for (let i = 0; i < 3; i++) {
    const a = await ask(prompt)
    if (a === null) return null
    const v = a.toLowerCase()
    if (v === 'y' || v === 'yes') return true
    if (v === 'n' || v === 'no') return false
    console.log('  Please type y or n.')
  }
  return null
}

async function fileExists(path) {
  try { await access(path); return true } catch { return false }
}

/**
 * Read a config file, distinguishing "not there" from "there and unreadable".
 *
 * These were the same value before, and the caller turned both into `{}` and wrote over the file.
 * A VS Code `mcp.json` with a `// comment` in it — which VS Code permits and people write — failed
 * `JSON.parse`, became an empty object, and the customer's existing MCP servers were deleted by our
 * installer while it printed success. Found in audit and reproduced against a disposable config.
 */
async function readJson(path) {
  let raw
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    // Only "there is no file" may be treated as a blank slate. Every other read
    // error — EACCES, EISDIR, EIO — means a file exists whose contents we cannot
    // see, and treating that as empty means writing a config holding nothing but
    // MegaLens over the top of it. The direct write used to fail with EACCES and
    // stop; replacing via rename only needs the *directory* to be writable, so
    // the old accident is no longer self-limiting. Reproduced on a mode-000
    // config: unrelated settings lost, and setup reported success.
    if (err?.code !== 'ENOENT') {
      return { missing: false, data: null, unreadable: String(err?.message ?? err) }
    }
    return { missing: true, data: null }
  }
  if (raw.trim() === '') return { missing: true, data: null }
  try {
    return { missing: false, data: JSON.parse(raw) }
  } catch (err) {
    return { missing: false, data: null, unreadable: String(err?.message ?? err) }
  }
}

/**
 * Replace a config file in one step.
 *
 * `writeFile` truncates the destination and then writes, so a process killed in
 * between leaves the user with an empty or half-written config — every MCP
 * server and setting in it, not only ours. Writing a sibling temp file and
 * renaming it makes the swap atomic: a reader sees either the whole old file or
 * the whole new one. The temp file sits beside the target because rename is
 * only atomic within a filesystem, and it carries the 0600 mode *before* the
 * rename so the token is never readable at the final path even briefly.
 *
 * Two things this has to get right, both found in review:
 *
 * `rename` does not follow a symlink at the destination — it replaces the link
 * with a regular file. This audience keeps dotfiles in a git repo and symlinks
 * `~/.codex/config.toml` into it, and severing that link loses the MegaLens
 * entry days later, when the next `stow`/`chezmoi apply` re-links over it, with
 * nothing pointing back here. Resolving the path first keeps the indirection
 * the old `writeFile` had, and keeps the temp file on the target's filesystem.
 * Note what that means: on such a setup the token is written into the dotfiles
 * repo, exactly as it was before — the user's own arrangement, but worth
 * knowing before it reaches a remote.
 *
 * The temp name must be unique per run. A fixed one let two concurrent setups
 * interleave — A finishes its temp, B reopens the same name with O_TRUNC, A
 * renames and publishes B's half-written file — reintroducing at the final path
 * the very corruption this exists to prevent. With unique names the race
 * collapses to last-rename-wins, and every rename publishes a whole file.
 *
 * The temp is created exclusively (`wx`). `writeFile`'s `mode` applies only when
 * it creates the file, so reusing an existing name would write the token into
 * whatever mode that file already had — 0644 is readable by another user before
 * the chmod lands — and if the name were a symlink, `writeFile` would follow it
 * and we would publish that symlink as the config. `wx` refuses both.
 *
 * Ownership is carried over, because `rename` installs the temp's inode: a run
 * under sudo would otherwise leave a root-owned 0600 config that its actual
 * owner can no longer read.
 *
 * A SIGKILL between the write and the rename does leave one temp file behind,
 * 0600 and unread by anything. Sweeping siblings on entry would risk deleting a
 * concurrent run's in-flight temp — the bug above wearing a different hat — so
 * it is left alone deliberately.
 */
async function writeFileAtomic(path, contents) {
  const target = await realpath(path).catch(() => path)
  const tmp = `${target}.megalens-tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`
  const existing = await stat(target).catch(() => null)

  if (existing && existing.nlink > 1) {
    // rename swaps this directory entry only; the file's other names keep the
    // old inode and silently stop tracking it.
    console.log(`\n  ! ${target} has other hard links. They will keep the previous contents.`)
  }

  try {
    await writeFile(tmp, contents, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    await chmod(tmp, 0o600)
    if (existing && typeof process.getuid === 'function') {
      if (existing.uid !== process.getuid() || existing.gid !== process.getgid()) {
        try {
          await chown(tmp, existing.uid, existing.gid)
        } catch {
          console.log(`\n  ! Could not preserve ownership of ${target}; it will belong to the current user.`)
        }
      }
    }
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

async function writeJson(path, data) {
  // Token is sensitive, so the file is 0600 from the moment it exists.
  await writeFileAtomic(path, JSON.stringify(data, null, 2) + '\n')
}

// ── Tool detection ──

function vscodeUserMcpPath(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Code', 'User', 'mcp.json')
}

/**
 * Active Codex config path(s) (Astra FINAL #7): when CODEX_HOME is set, Codex reads ONLY
 * `$CODEX_HOME/config.toml`, so selection, creation and writing must target it instead of the
 * inactive default `~/.codex/config.toml`.
 */
function codexConfigPaths(env = process.env, home = homedir()) {
  const custom = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  if (custom) return [join(resolveCodexHome(env, home), 'config.toml')]
  return [
    join(home, '.codex', 'config.toml'),
    join(home, '.config', 'codex', 'config.toml'),
  ]
}

function claudeConfigPaths(env = process.env, home = homedir()) {
  return [resolveClaudeMcpConfigPath(env, home)]
}

/**
 * Merge only the endpoint and Authorization credential fields into `existing[mapKey].megalens`,
 * preserving user-configured flags and (ONLY when the origin is unchanged, Astra CONFIRM10 #12)
 * extra custom headers on the entry.
 */
function mergeServerEntry(existing, mapKey, entry) {
  return mergeMcpServerEntry(existing, mapKey, entry)
}

const TOOLS = [
  {
    name: 'Claude Code',
    format: 'json',
    configPaths: claudeConfigPaths(),
    shape: (token) => ({
      mcpServers: {
        megalens: { type: 'http', url: mcpUrlFor('claude-code'), headers: { Authorization: `Bearer ${token}` } },
      },
    }),
    merge: (existing, fragment) => mergeServerEntry(existing, 'mcpServers', fragment.mcpServers.megalens),
  },
  {
    name: 'Codex CLI',
    format: 'toml',
    headerKey: 'http_headers',
    mcpUrl: mcpUrlFor('codex'),
    configPaths: codexConfigPaths(),
    toml: (token) =>
      `\n[mcp_servers.megalens]\nurl = "${mcpUrlFor('codex')}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }\n`,
  },
  {
    /**
     * Grok Build — xAI's terminal coding agent. TOML like Codex, but the header
     * table is `headers`, not Codex's `http_headers`. Verified against
     * https://docs.x.ai/build/features/mcp-servers (remote HTTP server block).
     * Equivalent one-liner, if the user prefers it:
     *   grok mcp add --transport http megalens <url> --header "Authorization: Bearer <token>"
     */
    name: 'Grok Build',
    label: 'Grok Build (not supported or tested)',
    format: 'toml',
    headerKey: 'headers',
    mcpUrl: mcpUrlFor('grok'),
    configPaths: [
      join(homedir(), '.grok', 'config.toml'),
    ],
    toml: (token) =>
      `\n[mcp_servers.megalens]\nurl = "${mcpUrlFor('grok')}"\nheaders = { "Authorization" = "Bearer ${token}" }\n`,
  },
  {
    name: 'Cursor',
    format: 'json',
    configPaths: [
      join(homedir(), '.cursor', 'mcp.json'),
    ],
    shape: (token) => ({
      mcpServers: {
        megalens: { url: mcpUrlFor('cursor'), headers: { Authorization: `Bearer ${token}` } },
      },
    }),
    merge: (existing, fragment) => mergeServerEntry(existing, 'mcpServers', fragment.mcpServers.megalens),
  },
  {
    name: 'Gemini CLI',
    format: 'json',
    configPaths: [
      join(homedir(), '.gemini', 'settings.json'),
    ],
    shape: (token) => ({
      mcpServers: {
        megalens: { httpUrl: mcpUrlFor('gemini-cli'), headers: { Authorization: `Bearer ${token}` } },
      },
    }),
    merge: (existing, fragment) => mergeServerEntry(existing, 'mcpServers', fragment.mcpServers.megalens),
  },
  {
    name: 'VS Code (Copilot)',
    label: 'GitHub Copilot in VS Code (coming soon, not supported yet)',
    format: 'json',
    /**
     * The USER profile's mcp.json, never the workspace's `.vscode/mcp.json`: a workspace file is
     * usually committed, and the token would go with it (Astra FIX 17 #1). User-level servers are
     * available in every workspace, so nothing needs to reference it from the project.
     */
    configPaths: [vscodeUserMcpPath()],
    shape: (token) => ({
      servers: {
        megalens: { type: 'http', url: mcpUrlFor('copilot'), headers: { Authorization: `Bearer ${token}` } },
      },
    }),
    merge: (existing, fragment) => mergeServerEntry(existing, 'servers', fragment.servers.megalens),
  },
  {
    name: 'Windsurf',
    label: 'Windsurf (not supported or tested)',
    format: 'json',
    configPaths: [
      join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    ],
    shape: (token) => ({
      mcpServers: {
        megalens: { serverUrl: mcpUrlFor('windsurf'), headers: { Authorization: `Bearer ${token}` } },
      },
    }),
    merge: (existing, fragment) => mergeServerEntry(existing, 'mcpServers', fragment.mcpServers.megalens),
  },
]

async function detectTools() {
  const found = []
  for (const tool of TOOLS) {
    for (const p of tool.configPaths) {
      if (await fileExists(p)) {
        found.push({ ...tool, activePath: p })
        break
      }
    }
  }
  return found
}

// ── Commands ──

async function validateToken(token) {
  try {
    const res = await fetch(`${VALIDATE_URL}?include_label=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => null)
    if (res.ok && data?.valid === true) {
      const label = typeof data.label === 'string' ? data.label : null
      console.log('\n  Token is valid.')
      console.log(`  Plan: ${data.plan_code}`)
      if (data.is_payg) console.log('  Billing: Pay-as-you-go (managed keys)\n')
      else if (data.is_pro) console.log('  Billing: Pro\n')
      else console.log('  Billing: Free\n')
      return { valid: true, isPro: !!data.is_pro, isPayg: !!data.is_payg, label }
    } else {
      console.error(`\n  Token invalid: ${data?.error ?? `HTTP ${res.status}`}\n`)
      return { valid: false, isPro: false, isPayg: false, label: null }
    }
  } catch (err) {
    console.error(`\n  Connection failed: ${err.message}\n`)
    return { valid: false, isPro: false, isPayg: false, label: null }
  }
}

/**
 * Advance a minimal TOML scanner across one line.
 *
 * We only need enough of the grammar to know when a line is *not* code: inside
 * a multi-line string, or inside a value that spans lines. Returns the state
 * the next line starts in.
 */
function scanTomlLine(line, delim, depth) {
  let i = 0
  while (i < line.length) {
    if (delim) {
      if (delim === '"""' && line[i] === '\\') { i += 2; continue }
      if (line.startsWith(delim, i)) { delim = null; i += 3 } else i++
      continue
    }
    const three = line.slice(i, i + 3)
    if (three === '"""' || three === "'''") { delim = three; i += 3; continue }
    const c = line[i]
    if (c === '#') break // comment runs to end of line
    if (c === '"' || c === "'") {
      i++
      while (i < line.length) {
        if (c === '"' && line[i] === '\\') { i += 2; continue }
        if (line[i] === c) { i++; break }
        i++
      }
      continue
    }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1)
    i++
  }
  return { delim, depth }
}

/**
 * Parse a line as a TOML table header, returning its normalised dotted key.
 *
 * TOML-aware quoted-key scanner (Astra FINAL #6): closing `]` and `]]` are matched ONLY outside
 * single- and double-quoted key segments (with `\"`/`\\` escapes in basic strings), so valid table
 * headers like `[projects."/home/user/app[v2]"]` or `[projects.'C:\work\app[1]']` are recognised as
 * genuine table boundaries rather than silently swallowed into the preceding table. Literal dots
 * inside a quoted segment are escaped as `\.` so `["mcp_servers.megalens"]` never collides with
 * `[mcp_servers.megalens]`. Returns null when the line is not a header.
 */
function tomlHeaderPath(line) {
  let t = line.startsWith('\uFEFF') ? line.slice(1) : line
  t = t.trim()
  if (!t.startsWith('[')) return null
  const isArray = t.startsWith('[[')
  let i = isArray ? 2 : 1
  const len = t.length
  const parts = []
  const skipWs = () => {
    while (i < len && (t[i] === ' ' || t[i] === '\t')) i++
  }
  for (;;) {
    skipWs()
    if (i >= len) return null
    let seg = ''
    const ch = t[i]
    if (ch === '"') {
      i++
      let closed = false
      while (i < len) {
        const c = t[i++]
        if (c === '\\') {
          if (i >= len) return null
          const esc = t[i++]
          if (esc === '"') seg += '"'
          else if (esc === '\\') seg += '\\'
          else if (esc === 'n') seg += '\n'
          else if (esc === 'r') seg += '\r'
          else if (esc === 't') seg += '\t'
          else if (esc === 'b') seg += '\b'
          else if (esc === 'f') seg += '\f'
          else if (esc === 'u' && i + 4 <= len) {
            const hex = t.slice(i, i + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
            seg += String.fromCodePoint(parseInt(hex, 16))
            i += 4
          } else if (esc === 'U' && i + 8 <= len) {
            const hex = t.slice(i, i + 8)
            if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null
            const cp = parseInt(hex, 16)
            if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null
            seg += String.fromCodePoint(cp)
            i += 8
          } else {
            return null
          }
        } else if (c === '"') {
          closed = true
          break
        } else {
          seg += c
        }
      }
      if (!closed) return null
      parts.push(seg.replace(/\\/g, '\\\\').replace(/\./g, '\\.'))
    } else if (ch === "'") {
      i++
      const end = t.indexOf("'", i)
      if (end === -1) return null
      seg = t.slice(i, end)
      i = end + 1
      parts.push(seg.replace(/\\/g, '\\\\').replace(/\./g, '\\.'))
    } else {
      const start = i
      while (i < len && /[A-Za-z0-9_-]/.test(t[i])) i++
      if (i === start) return null
      parts.push(t.slice(start, i))
    }
    skipWs()
    if (i < len && t[i] === '.') {
      i++
      continue
    }
    break
  }
  if (isArray) {
    if (t[i] !== ']' || t[i + 1] !== ']') return null
    i += 2
  } else {
    if (t[i] !== ']') return null
    i += 1
  }
  skipWs()
  if (i < len && t[i] !== '#') return null
  return parts.length > 0 ? parts.join('.') : null
}

/**
 * Remove one TOML table, and any sub-tables under it, leaving the rest of the
 * file untouched. Returns null when the file cannot be scanned confidently, so
 * the caller can leave it alone rather than guess.
 *
 * The first version of this tested `line.trim().startsWith('[')` and two
 * reviewers independently broke it with valid TOML: a bracketed line inside a
 * multi-line array value, and a line reading `[mcp_servers.megalens]` inside a
 * multi-line `"""` string. Each made the installer delete or orphan part of the
 * user's file — every MCP server and setting in it, not just ours — and then
 * print "Updated". Only genuine headers, found outside strings and values, may
 * start or end a table.
 */
function stripTomlTable(text, table) {
  const out = []
  let dropping = false
  let delim = null
  let depth = 0

  for (const line of text.split('\n')) {
    if (!delim && depth === 0) {
      const path = tomlHeaderPath(line)
      if (path !== null) dropping = path === table || path.startsWith(`${table}.`)
    }
    if (!dropping) out.push(line)
    ;({ delim, depth } = scanTomlLine(line, delim, depth))
  }

  // An unterminated string or bracket means our reading of the file diverged
  // from the file itself. Anything we write from here is a guess.
  if (delim || depth !== 0) return null
  return out.join('\n')
}

/**
 * Returns 'written' when the config now holds `token`, 'skipped' when we
 * deliberately left the file alone.
 *
 * The TOML branch used to bail out whenever a megalens block already existed,
 * while the caller printed "Updated <path>" regardless. So re-running setup
 * with a *new* token left Codex CLI and Grok Build on the old one and reported
 * success. Since generating a token revokes the previous one, the usual way to
 * hit this — rotate the token, run setup again — left those two tools holding a
 * revoked token, with nothing on screen to suggest the file had not changed.
 * Replace the block instead; JSON tools already overwrote via `merge`.
 */
async function writeToolConfig(tool, path, token) {
  // The token never reaches the screen, in either flow: the fallback block is printed with it
  // masked, and the user fixes the file and runs setup again (Astra FIX 17 #6).
  const shown = MASKED_TOKEN
  const backupOpts = { mode: 0o600, env: process.env, home: homedir(), platform: process.platform }
  const MAX_WRITE_ATTEMPTS = 3
  let backedUp = false

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    if (tool.format === 'toml') {
      const read = await readOptionalFile(path)
      if (read.unreadable !== null) {
        console.log(`\n  ! ${path} could not be read: ${read.unreadable}`)
        console.log('    Not touching it — your existing config is intact.')
        console.log('    Fix the file and run setup again. The block it needs (token hidden):\n')
        console.log(`${tool.toml(shown).trim()}\n`)
        return 'skipped'
      }
      const existing = read.exists ? read.content : ''
      const headerKey = tool.headerKey ?? 'http_headers'
      const mcpUrl = tool.mcpUrl ?? mcpUrlFor('codex')
      const info = existing
        ? inspectCodexConfig(existing, { scanTomlLine, tomlHeaderPath }, { headerKey })
        : { unparseable: false, uneditable: false, hasEntry: false }
      if (info.unparseable) {
        console.log(`\n  ! ${path} could not be read as TOML — a string or bracket is left open.`)
        console.log('    Not touching it — your existing config is intact.')
        console.log('    Fix the file and run setup again. The block it needs (token hidden):\n')
        console.log(`${tool.toml(shown).trim()}\n`)
        return 'skipped'
      }
      if (info.uneditable) {
        console.log(`\n  ! ${path} has a MegaLens entry in a form setup cannot edit safely.`)
        console.log('    Not touching it — your existing config is intact.')
        console.log('    Update it by hand so it uses (token hidden):\n')
        console.log(`${tool.toml(shown).trim()}\n`)
        return 'skipped'
      }
      const eol = existing.includes('\r\n') ? '\r\n' : '\n'
      let nextContents
      if (info.hasEntry) {
        // Update ONLY endpoint + credential fields in-place (Astra FINAL #5): preserves
        // `enabled = false`, `enabled_tools`, `disabled_tools`, comments, and every other table.
        nextContents = buildHttpHeadersReplacement(info, token, eol, { headerKey, mcpUrl }).nextConfig
      } else {
        const base = existing.replace(/\s+$/, '')
        nextContents = (base ? `${base}\n` : '') + tool.toml(token)
      }
      const target = await realpath(path).catch(() => path)
      if (read.exists && !backedUp) {
        await backupExistingFile(target, makeTimestamp(), backupOpts)
        backedUp = true
        if (!(await verifyFileVersion(path, read.version))) continue
      }
      try {
        await writeFileAtomicPreservingMode(path, nextContents, {
          defaultMode: 0o600,
          preserveMode: false,
          log: (m) => console.log(m),
          expectedVersion: read.version,
        })
        return 'written'
      } catch (err) {
        if (err?.code === 'ECONCURRENT') continue
        throw err
      }
    } else {
      const read = await readOptionalFile(path)
      if (read.unreadable !== null) {
        console.log(`\n  ! ${path} exists but could not be parsed as JSON:`)
        console.log(`    ${read.unreadable}`)
        console.log('    Not touching it — your existing config is intact.')
        console.log('    Fix the file and run setup again. The block it needs (token hidden):\n')
        console.log(`${JSON.stringify(tool.shape(shown), null, 2)}\n`)
        return 'skipped'
      }
      let data = {}
      if (read.exists && read.content.trim() !== '') {
        try {
          const text = read.content.startsWith('\uFEFF') ? read.content.slice(1) : read.content
          data = JSON.parse(text)
        } catch (err) {
          console.log(`\n  ! ${path} exists but could not be parsed as JSON:`)
          console.log(`    ${err?.message ?? err}`)
          console.log('    Not touching it — your existing config is intact.')
          console.log('    Fix the file and run setup again. The block it needs (token hidden):\n')
          console.log(`${JSON.stringify(tool.shape(shown), null, 2)}\n`)
          return 'skipped'
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          console.log(`\n  ! ${path} exists but could not be parsed as JSON:`)
          console.log('    JSON root is not an object')
          console.log('    Not touching it — your existing config is intact.')
          console.log('    Fix the file and run setup again. The block it needs (token hidden):\n')
          console.log(`${JSON.stringify(tool.shape(shown), null, 2)}\n`)
          return 'skipped'
        }
      }
      const target = await realpath(path).catch(() => path)
      if (read.exists && !backedUp) {
        await backupExistingFile(target, makeTimestamp(), backupOpts)
        backedUp = true
        if (!(await verifyFileVersion(path, read.version))) continue
      }
      const fragment = tool.shape(token)
      const merged = tool.merge(data, fragment)
      const nextContents = JSON.stringify(merged, null, 2) + '\n'
      try {
        await writeFileAtomicPreservingMode(path, nextContents, {
          defaultMode: 0o600,
          preserveMode: false,
          log: (m) => console.log(m),
          expectedVersion: read.version,
        })
        return 'written'
      } catch (err) {
        if (err?.code === 'ECONCURRENT') continue
        throw err
      }
    }
  }
  throw new Error(`${path} kept changing while saving`)
}

/**
 * Can we write this file without losing anything? Checked BEFORE signing in, so a broken config
 * never costs the user a token they cannot see. Returns null when fine, or the reason it is not.
 */
async function preflightConfig(tool, path) {
  if (tool.format === 'toml') {
    try {
      const raw = await readFile(path, 'utf-8')
      const info = inspectCodexConfig(raw, { scanTomlLine, tomlHeaderPath }, { headerKey: tool.headerKey ?? 'http_headers' })
      if (info.unparseable) return 'it could not be read as TOML'
      if (info.uneditable) return 'it has a MegaLens entry in a form setup cannot edit safely'
    } catch (err) {
      if (err?.code !== 'ENOENT') return 'it could not be read'
    }
  } else {
    const read = await readJson(path)
    if (read.unreadable) return 'it could not be read'
  }
  const target = await realpath(path).catch(() => path)
  // The directory the temp file goes in; for a file not yet made, its nearest existing ancestor.
  let dir = dirname(target)
  for (;;) {
    try {
      await access(dir, fsConstants.W_OK)
      break
    } catch (err) {
      if (err?.code !== 'ENOENT') return `its folder ${dir} is not writable`
      const up = dirname(dir)
      if (up === dir) return `no writable folder for ${target}`
      dir = up
    }
  }
  try {
    await access(target, fsConstants.F_OK)
    await access(target, fsConstants.R_OK)
  } catch (err) {
    if (err?.code !== 'ENOENT') return 'it could not be read'
  }
  return null
}

/**
 * Parse JSON with comments (`//`, `/* *\/`) and trailing commas, the way VS Code reads `mcp.json`.
 * Read-only scans only (Astra CONFIRM7): a file setup writes still has to be plain JSON. String
 * contents are never touched, so a `//` inside a URL stays. Returns undefined when it still does
 * not parse.
 */
function parseJsonc(raw) {
  let out = ''
  let i = 0
  const n = raw.length
  if (raw.charCodeAt(0) === 0xfeff) i = 1
  while (i < n) {
    const c = raw[i]
    if (c === '"') {
      let j = i + 1
      while (j < n && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1
      out += raw.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && raw[i + 1] === '/') {
      while (i < n && raw[i] !== '\n' && raw[i] !== '\r') i++
    } else if (c === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2)
      if (end < 0) return undefined
      out += ' '
      i = end + 2
    } else if (c === ',') {
      let j = i + 1
      while (j < n && /\s/.test(raw[j])) j++
      // A comment may sit between the comma and the closer: look past it too.
      for (;;) {
        if (raw[j] === '/' && raw[j + 1] === '/') {
          while (j < n && raw[j] !== '\n' && raw[j] !== '\r') j++
        } else if (raw[j] === '/' && raw[j + 1] === '*') {
          const end = raw.indexOf('*/', j + 2)
          if (end < 0) return undefined
          j = end + 2
        } else if (j < n && /\s/.test(raw[j])) j++
        else break
      }
      if (raw[j] === '}' || raw[j] === ']') i++ // trailing comma: drop it
      else {
        out += c
        i++
      }
    } else {
      out += c
      i++
    }
  }
  try {
    return JSON.parse(out)
  } catch {
    return undefined
  }
}

/** Text that points at MegaLens or holds a MegaLens token. */
const MEGALENS_TRACE = /megalens|ml_tok_/i

/**
 * Does this tool's config already have a MegaLens entry? Returns { state, why }:
 *   'yes'     exactly one entry, in the one form setup rewrites (the `[mcp_servers.megalens]` table
 *             for TOML, the top-level `mcpServers.megalens` / `servers.megalens` key for JSON);
 *   'no'      no trace of MegaLens at all;
 *   'unknown' the file could not be read, or MegaLens appears anywhere setup would NOT rewrite.
 *
 * Unknown is never guessed at (Astra FIX 4 #15). Codex also accepts inline and dotted forms
 * (`mcp_servers = { megalens = {...} }`, `[mcp_servers]` + `megalens = {...}`,
 * `mcp_servers.megalens.url = ...`), and Claude Code keeps per-project `mcpServers`. Setup does not
 * rewrite those, so an editor reading one would keep the OLD bearer. So for TOML, any `megalens` or
 * `ml_tok_` left once the one table is cut out counts (a comment too: conservative on purpose); for
 * JSON, any other server entry, at any depth, whose name or contents mention MegaLens. The caller
 * never updates an unknown file and never lets the sign-in replace (revoke) the editor token.
 *
 * Structure only: the token is never read out, checked or sent anywhere (Astra FIX 15).
 */
async function megalensEntry(tool, path, { scanOnly = false } = {}) {
  if (tool.format === 'toml') {
    let raw
    try {
      raw = await readFile(path, 'utf-8')
    } catch (err) {
      return err?.code === 'ENOENT' ? { state: 'no' } : { state: 'unknown', why: 'it could not be read' }
    }
    const without = stripTomlTable(raw, 'mcp_servers.megalens')
    if (without === null) return { state: 'unknown', why: 'it could not be read as TOML' }
    if (MEGALENS_TRACE.test(without)) return { state: 'unknown', why: 'it mentions MegaLens in a form setup does not update (an inline or dotted entry, another server, or a comment)' }
    return { state: without === raw ? 'no' : 'yes' }
  }
  let read = await readJson(path)
  let parsedAsJsonc = false
  if (read.unreadable) {
    // Read-only JSONC inspection (Astra CONFIRM6, CONFIRM7, FINAL #8): VS Code user and project
    // `mcp.json` files allow comments and trailing commas. Always parse as JSONC when checking
    // whether a file holds MegaLens (even for user profiles that will be skipped for writing), so
    // an empty commented VS Code user config never falsely classifies as unreadable/holding a token.
    const raw = await readFile(path, 'utf-8').catch(() => null)
    if (typeof raw === 'string') {
      const data = parseJsonc(raw)
      if (data !== undefined) {
        read = { missing: false, data }
        parsedAsJsonc = true
      } else if (!MEGALENS_TRACE.test(raw)) {
        return { state: 'no' }
      } else {
        return { state: 'unknown', why: 'it is not valid JSON (even allowing comments) and it mentions MegaLens, so setup cannot tell what it holds' }
      }
    }
  }
  if (read.unreadable) return { state: 'unknown', why: 'it could not be read' }
  const d = read.data
  if (!d || typeof d !== 'object') return { state: 'no' }
  const mapKey = Object.keys(tool.shape('x'))[0] // 'mcpServers' or 'servers': the one setup rewrites
  let ours = false
  let other = false
  const walk = (node, depth, top) => {
    if (other || depth > 64 || !node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'mcpServers' || k === 'servers') && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [name, entry] of Object.entries(v)) {
          if (top && k === mapKey && name === 'megalens') {
            ours = true
            continue
          }
          if (MEGALENS_TRACE.test(name) || MEGALENS_TRACE.test(JSON.stringify(entry) ?? '')) other = true
        }
      }
      walk(v, depth + 1, false)
    }
  }
  walk(d, 0, true)
  if (other) return { state: 'unknown', why: 'it has another MegaLens entry setup does not update (for example a per-project one)' }
  if (parsedAsJsonc && !scanOnly && ours) {
    return { state: 'unknown', why: 'it is not plain JSON (it may have comments) and has a MegaLens entry' }
  }
  return { state: ours ? 'yes' : 'no' }
}

/**
 * Project-level editor configs: `.cursor/mcp.json` (Cursor), `.mcp.json` (Claude Code),
 * `.gemini/settings.json` (Gemini CLI), `.codex/config.toml` (Codex CLI) and `.vscode/mcp.json`
 * (VS Code), in `cwd` and every folder above it. Setup never writes these (a project file is often
 * committed); it only looks, so a MegaLens entry in one blocks replacing the editor token.
 */
const PROJECT_CONFIGS = [
  { tool: 'Cursor', rel: ['.cursor', 'mcp.json'] },
  { tool: 'Claude Code', rel: ['.mcp.json'] },
  { tool: 'Gemini CLI', rel: ['.gemini', 'settings.json'] },
  { tool: 'Codex CLI', rel: ['.codex', 'config.toml'] },
  { tool: 'VS Code (Copilot)', rel: ['.vscode', 'mcp.json'] },
]
function projectConfigPaths(cwd) {
  const out = []
  for (let d = cwd; ; ) {
    for (const c of PROJECT_CONFIGS) out.push({ tool: c.tool, path: join(d, ...c.rel) })
    const up = dirname(d)
    if (up === d) return out
    d = up
  }
}

const ANTIGRAVITY_SCAN_TOOL = {
  name: 'Antigravity',
  format: 'json',
  shape: () => ({ mcpServers: {} }),
}

/**
 * MegaLens entries in editor configs this run does NOT pick as the tool's file: the second Codex
 * path, `$CODEX_HOME/config.toml` (Astra FIX 4 #15), `$CLAUDE_CONFIG_DIR/.claude.json`,
 * Antigravity's `~/.gemini/config/mcp_config.json` (Fable FIX 3 #1), and project configs in this
 * folder and above (Astra CONFIRM5 #15). An editor reading one of those would keep the old bearer,
 * so each one found (or unreadable) blocks replacing the editor token. Project folders elsewhere on
 * the machine cannot be found this way, so a replace is also asked about in the terminal, default no.
 */
async function otherMegalensConfigs(handledPaths, env = process.env, cwd = process.cwd()) {
  const out = []
  const seen = new Set()
  const key = async (p) => (await realpath(p).catch(() => p))
  for (const p of handledPaths) seen.add(await key(p))
  const byName = (name) => TOOLS.find((t) => t.name === name)
  const candidates = []
  for (const tool of TOOLS) {
    for (const p of tool.configPaths) candidates.push([tool, p])
    if (tool.name === 'Claude Code') {
      candidates.push([tool, join(homedir(), '.claude.json')])
      candidates.push([tool, join(resolveClaudeConfigDir(env), '.claude.json')])
    }
    if (tool.name === 'Codex CLI') {
      candidates.push([tool, join(homedir(), '.codex', 'config.toml')])
      candidates.push([tool, join(homedir(), '.config', 'codex', 'config.toml')])
      candidates.push([tool, join(resolveCodexHome(env), 'config.toml')])
    }
  }
  candidates.push([ANTIGRAVITY_SCAN_TOOL, join(homedir(), '.gemini', 'config', 'mcp_config.json')])
  // Project configs (Astra CONFIRM5 #15): an editor opened in this folder or any folder above it
  // reads these too, and a project entry wins over the user-level one.
  for (const p of projectConfigPaths(cwd)) candidates.push([byName(p.tool), p.path, true])
  for (const [tool, p, project = false] of candidates) {
    const k = await key(p)
    if (seen.has(k)) continue
    seen.add(k)
    try {
      await access(p, fsConstants.F_OK)
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue
    }
    const { state, why } = await megalensEntry(tool, p, { scanOnly: true })
    if (state === 'no') continue
    // Only claim a MegaLens entry when one was found; otherwise say why the file blocks (Astra CONFIRM6 #1).
    const projectWhy = state === 'yes' ? 'it is a project config with a MegaLens entry, and setup never writes project configs' : `it is a project config setup never writes, and ${why}`
    out.push({
      name: `${tool.name} (${p})`,
      why: project ? projectWhy : (why ?? 'it has a MegaLens entry this run does not update'),
      project,
      unmanaged: true,
    })
  }
  return out
}

/** A workspace `.vscode/mcp.json` here holding a MegaLens token (written by an older version). */
async function warnWorkspaceToken() {
  const ws = join(process.cwd(), '.vscode', 'mcp.json')
  const data = (await readJson(ws)).data
  const auth = data?.servers?.megalens?.headers?.Authorization
  if (typeof auth === 'string' && /ml_tok_/.test(auth)) {
    console.log(`  ! ${ws} holds a MegaLens token. That file is often committed with the project.`)
    console.log('    Remove the "megalens" entry from it. MegaLens now goes in your VS Code user settings.\n')
  }
}

/**
 * Ask before writing a token into a file git could commit (Astra FIX 17 #1). Default no.
 * Returns true when the file is fine to write.
 */
async function okToWriteTracked(tool, path) {
  const real = await realLocation(path)
  const t = real === null ? 'unknown' : gitTrackable(real)
  if (t === 'no') return true
  if (t === 'yes') {
    console.log(`  ! ${real} is inside a git repository and not ignored there.`)
  } else if (real === null) {
    console.log(`  ! Could not work out where ${path} really is (a link that could not be followed).`)
  } else {
    console.log(`  ! Could not check with git whether ${real} is inside a repository.`)
  }
  console.log('    A token written into it can be committed and pushed with that repository.')
  return askYes(`  Write the MegaLens token into it anyway? (y/N): `, false)
}

/**
 * Write one token into each tool, one at a time: a failure in one never stops the others.
 */
async function writeAll(tools, token) {
  const configured = []
  const failed = []
  for (const tool of tools) {
    try {
      if (tool.create) await mkdir(dirname(tool.activePath), { recursive: true })
      if (await writeToolConfig(tool, tool.activePath, token) !== 'written') {
        failed.push(tool.name)
        continue
      }
      console.log(`  Updated ${tool.activePath}`)
      configured.push(tool.name)
    } catch (err) {
      console.log(`  ! Could not write ${tool.activePath}: ${maskTokenSecrets(err?.code ?? err?.message ?? 'error')}. It was not changed.`)
      failed.push(tool.name)
    }
  }
  return { configured, failed }
}

function reportWrites({ configured, failed }, { replaced }) {
  if (configured.length === 0) {
    console.log('\n  Nothing was written. See the warning above.')
    if (replaced) console.log('  Your previous editor token was revoked by this sign-in. Fix the problem above and run setup again.')
    console.log('')
    process.exitCode = 1
    return
  }
  console.log(`\n  Setup complete. MegaLens was added to: ${configured.join(', ')}`)
  console.log('  No token was shown or copied: it went straight into the config files above.')
  if (failed.length > 0) {
    console.log(`  Not saved in: ${failed.join(', ')} (see above). Fix that and run setup again for it.`)
    if (replaced) console.log(`  Your previous editor token was revoked, so ${failed.join(', ')} will not reach MegaLens until then.`)
    process.exitCode = 1
  }
  console.log('\n  It will NOT appear in a session that is already open.')
  console.log(`  Close ${configured.length > 1 ? 'those tools' : configured[0]} and start a new session.\n`)
}

/**
 * `megalens-mcp setup`: pick the tools, sign in through the browser, write the new editor token
 * into each tool the user chose. The token is never shown, never in argv, never in shell history.
 *
 * No token discovery (Astra FIX 15): an existing token is never read, checked, sent anywhere or
 * copied into another editor. Every run issues the editor label's own token through the browser
 * approval, and every chosen tool gets it, pointing at https://megalens.ai/api/mcp.
 *
 * One editor token per account, so a sign-in can replace (revoke) the current one. A tool that
 * keeps a MegaLens entry (the user said no, or it cannot be written) may be using that token, so
 * then the sign-in may NOT replace: if the browser approval would replace it, the terminal cancels
 * before anything is created or revoked (Astra FIX 15 #15). A declined tool is never left on a
 * revoked token.
 */
async function cmdSetup({ login = deviceLogin } = {}) {
  console.log('\n  MegaLens MCP Setup\n')
  await warnWorkspaceToken()

  // 1. Which tools? Decided before signing in, so no token is made for nothing.
  const detected = await detectTools()
  const chosen = []
  const kept = [] // tools that keep a MegaLens entry this run does not update
  if (detected.length === 0) {
    console.log('  No supported tools detected.')
    console.log('  ChatGPT, Claude.ai and other OAuth connectors need no wizard and no token: add')
    console.log('  https://megalens.ai/api/mcp as a connector, then sign in and approve.')
    console.log('  Lovable steps: https://megalens.ai/integrations/lovable\n')
    const choices = TOOLS.map((t, i) => `    ${i + 1}. ${t.label ?? t.name}`).join('\n')
    console.log('  Which tool do you want to configure?\n' + choices)
    const pick = await ask('\n  Enter number (or press Enter to skip): ')
    if (pick === null) throw new InputEnded()
    const idx = parseInt(pick, 10) - 1
    if (!(idx >= 0 && idx < TOOLS.length)) {
      console.log('\n  Nothing was configured.\n')
      return
    }
    const tool = { ...TOOLS[idx], activePath: TOOLS[idx].configPaths[0], create: true }
    const why = await preflightConfig(tool, tool.activePath)
    if (why) {
      console.log(`  ! ${tool.activePath} cannot be written (${why}), so nothing was done.\n`)
      process.exitCode = 1
      return
    }
    if (!(await okToWriteTracked(tool, tool.activePath))) {
      console.log('\n  Nothing was configured.\n')
      return
    }
    chosen.push(tool)
  } else {
    for (const tool of detected) {
      console.log(`  Found: ${tool.label ?? tool.name} (${tool.activePath})`)
      const { state: entry, why: unsure } = await megalensEntry(tool, tool.activePath)
      const keep = () => {
        if (entry !== 'no') kept.push(tool)
      }
      if (entry === 'unknown') {
        // Never updated, never asked about: it may hold a bearer setup cannot see (Astra FIX 4 #15).
        console.log(`  ! ${tool.name} will not be changed: ${unsure}.`)
        console.log('    It may use your current editor token, so this sign-in will not replace that token.')
        keep()
        continue
      }
      const q = entry === 'yes'
        ? `  ${tool.name} already has MegaLens. Update it with the new token? (Y/n): `
        : `  Add MegaLens to ${tool.name}? (Y/n): `
      if (!(await askYes(q, true))) {
        keep()
        continue
      }
      const why = await preflightConfig(tool, tool.activePath)
      if (why) {
        console.log(`  ! ${tool.activePath} cannot be written (${why}), so it will not be changed. Fix it and run setup again.`)
        keep()
        continue
      }
      if (!(await okToWriteTracked(tool, tool.activePath))) {
        keep()
        continue
      }
      chosen.push(tool)
    }
    if (chosen.length === 0) {
      console.log('\n  Nothing was configured.\n')
      return
    }
  }

  for (const extra of await otherMegalensConfigs([...detected, ...chosen].map((t) => t.activePath))) {
    console.log(`  ! ${extra.name} will not be changed: ${extra.why}.`)
    console.log('    It may use your current editor token, so this sign-in will not replace that token.')
    kept.push(extra)
  }

  const keptNames = kept.map((t) => t.name).join(', ')
  if (kept.length > 0) {
    console.log(`\n  ${keptNames} keep${kept.length > 1 ? '' : 's'} ${kept.length > 1 ? 'their' : 'its'} current MegaLens setup.`)
    console.log('  So this sign-in must not replace your editor token. If you approve a replace in the browser,')
    console.log('  setup stops before anything is created or revoked.')
  }

  // 2. Sign in through the browser. After approval the terminal names the account and asks.
  console.log('\n  Step 1 of 2: sign in to MegaLens in your browser.')
  let result
  let keptToken = false // the user said no to replacing the current editor token
  try {
    result = await login({
      client: 'megalens-mcp',
      allowReplace: kept.length === 0,
      log: (line) => console.log(maskTokenSecrets(line)),
      confirmAccount: async (account, { replaces } = {}) => {
        console.log(`\n  Approved in the browser by: ${account}`)
        if (replaces) console.log('  This replaces your current editor token. Every tool you chose gets the new one.')
        const mine = await askAccount('  Is that the MegaLens account you want in your editor? (y/n): ')
        if (mine !== true || !replaces) return mine
        /**
         * Setup sees only the user-level configs and project configs in this folder and above. An
         * editor opened in another project may use the current token from that project's own file
         * (Astra CONFIRM5 #15), so the revoke is asked about here, default no.
         */
        console.log('\n  Replacing REVOKES your current editor token. Any editor still using it stops working')
        console.log('  until you run setup for it, including project settings in other folders')
        console.log("  (for example another project's .cursor/mcp.json or .mcp.json).")
        let yes
        try {
          yes = await askYes('  Replace your current editor token? (y/N): ', false)
        } catch {
          return null
        }
        if (!yes) keptToken = true
        return yes
      },
    })
  } catch (err) {
    if (keptToken) {
      console.error('\n  Nothing was created or revoked: you kept your current editor token.')
      console.error('  To use the new sign-in, first remove MegaLens from editors you no longer use, then run setup again.')
      console.error('')
      process.exitCode = 1
      return
    }
    const msg = err instanceof DeviceLoginError ? err.message : 'The sign-in failed.'
    console.error(`\n  ${maskTokenSecrets(msg)}`)
    if (err instanceof DeviceLoginError && err.code === 'would_replace') {
      if (kept.some((t) => t.project)) {
        // Setup never writes a project config, so "update it" is not something a re-run can do.
        console.error(`  ${keptNames} may still use that token. Remove the MegaLens entry from each project`)
        console.error('  config named above (or set it up there by hand), then run setup again.')
      } else if (kept.some((t) => t.unmanaged)) {
        // Generic setup never writes these paths (Antigravity, $CLAUDE_CONFIG_DIR, $CODEX_HOME, etc.),
        // so "run setup again and update it too" cannot be followed (Fable confirm B).
        console.error(`  ${keptNames} may still use that token. Remove the MegaLens entry from each`)
        console.error('  config named above (or set it up there by hand), then run setup again.')
      } else {
        console.error(`  ${keptNames} may still use that token. Run setup again and update ${kept.length > 1 ? 'them' : 'it'} too,`)
        console.error('  or remove MegaLens from it first.')
      }
    } else if (!(err instanceof DeviceLoginError) || !['wrong_account', 'wrong_label', 'unconfirmed', 'no_answer'].includes(err.code)) {
      console.error('  You can also paste a token instead: npx megalens-mcp setup --manual')
    }
    console.error('')
    process.exitCode = 1
    return
  }
  console.log(result.replaced
    ? '\n  Signed in. Your editor token was replaced; the tools below get the new one.'
    : '\n  Signed in. A new editor token was created.')

  // 3. Write it into each chosen tool.
  console.log('  Step 2 of 2: saving it in your tools.')
  reportWrites(await writeAll(chosen, result.token), { replaced: result.replaced })
}

async function cmdSetupManual() {
  console.log('\n  MegaLens MCP Setup (manual token)\n')

  // 1. Get token
  const token = await ask('  Enter your MegaLens token (ml_tok_...): ', { hidden: true })
  if (typeof token !== 'string' || !token.startsWith('ml_tok_')) {
    console.error('  Invalid token format. Get your token at https://megalens.ai/app/settings/mcp\n')
    process.exit(1)
  }

  // 2. Validate and require a verified `default`-label Editor token (Astra FINAL #9).
  console.log('\n  Validating token...')
  const result = await validateToken(token)
  if (!result.valid) {
    console.error('  Setup stopped because the token could not be verified. Nothing was written.\n')
    process.exit(1)
  }
  if (result.label !== 'default') {
    if (result.label === 'github-action') {
      console.error('  This is a GitHub Action token, not an Editor token. It cannot be installed in an editor.')
    } else {
      console.error('  This token is not a verified Editor token (label "default"). It cannot be installed in an editor.')
    }
    console.error('  Get your Editor token at https://megalens.ai/app/settings/mcp or run: npx megalens-mcp setup\n')
    process.exit(1)
  }

  // 3. Detect tools
  const tools = await detectTools()

  if (tools.length === 0) {
    console.log('  No supported tools detected.')
    console.log('  Supported: Claude Code, Codex CLI, Cursor, Gemini CLI and Lovable. GitHub Copilot is coming soon.')
    console.log('  Lovable needs no config file: paste the server URL and your token into its MCP connector form.')
    console.log('  Lovable steps: https://megalens.ai/integrations/lovable')
    console.log('  ChatGPT, Claude.ai and other OAuth connectors need no wizard and no token: add')
    console.log('  https://megalens.ai/api/mcp as a connector, then sign in and approve.')
    console.log('  Steps: https://megalens.ai/integrations/oauth-connectors')
    console.log('  Manual setup: https://megalens.ai/integrations\n')

    const choices = TOOLS.map((t, i) => `    ${i + 1}. ${t.label ?? t.name}`).join('\n')
    console.log('  Which tool do you want to configure?\n' + choices)
    const pick = await ask('\n  Enter number (or press Enter to skip): ')
    const idx = parseInt(pick, 10) - 1
    if (idx >= 0 && idx < TOOLS.length) {
      const tool = TOOLS[idx]
      const path = tool.configPaths[0]
      const dir = path.substring(0, path.lastIndexOf('/'))
      await mkdir(dir, { recursive: true }).catch(() => {})
      if (!(await okToWriteTracked(tool, path))) return
      if (await writeToolConfig(tool, path, token) !== 'written') return
      console.log(`\n  Created ${path}`)
      console.log(`  Restart ${tool.name} to activate MegaLens.\n`)
    }
    return
  }

  // 4. Write config for each detected tool
  const configured = []
  let accepted = 0
  for (const tool of tools) {
    console.log(`\n  Found: ${tool.label ?? tool.name} (${tool.activePath})`)
    if (!(await askYes(`  Add MegaLens to ${tool.name}? (Y/n): `, true))) continue
    if (!(await okToWriteTracked(tool, tool.activePath))) continue
    accepted++

    // Only claim it, and only count it as configured, when the file really changed.
    if (await writeToolConfig(tool, tool.activePath, token) !== 'written') continue
    console.log(`  Updated ${tool.activePath}`)
    configured.push(tool.name)
  }

  if (configured.length === 0) {
    // "You declined every tool" is false when a file was accepted but refused
    // above; say which of the two actually happened.
    console.log(accepted === 0
      ? '\n  Nothing was configured — you declined every tool.\n'
      : '\n  Nothing was written — see the warning above.\n')
    return
  }

  /**
   * Name the tools the user actually said yes to, and be explicit that an
   * already-running session will not see MegaLens. These configs are read once
   * at startup, so the session this ran in is exactly the one where it will
   * appear to have done nothing.
   */
  console.log(`\n  Setup complete. MegaLens was added to: ${configured.join(', ')}`)
  console.log('\n  It will NOT appear in a session that is already open.')
  console.log(`  Close ${configured.length > 1 ? 'those tools' : configured[0]} and start a new session.\n`)
}

/**
 * The saved editor token to test, or null. `validate` only ever asks production, so an entry is
 * used only when EVERY address it holds (url, httpUrl, serverUrl) is MegaLens production (Astra FIX 4,
 * cross-issuer). Editors disagree on which field wins (Gemini CLI prefers httpUrl, others url), so
 * an entry whose fields point at different servers is rejected with a plain message, never used:
 * its bearer may belong to the other server. TOML configs are not read: asking for the token is
 * safer than guessing which of a file's lines are active.
 */
async function savedProductionToken(tools) {
  for (const tool of tools) {
    if (tool.format !== 'json') continue
    const config = (await readJson(tool.activePath)).data
    const entry = config?.mcpServers?.megalens ?? config?.servers?.megalens
    if (!entry || typeof entry !== 'object') continue
    const urls = [entry.url, entry.httpUrl, entry.serverUrl].filter((u) => u !== undefined)
    const origins = urls.map((u) => {
      try {
        return typeof u === 'string' ? new URL(u).origin : null
      } catch {
        return null
      }
    })
    if (origins.length === 0) continue
    if (new Set(origins).size > 1) {
      console.log(`\n  ! The MegaLens entry in ${tool.activePath} points at more than one server, so its token was not used.`)
      console.log('    Keep one address in it (https://megalens.ai/api/mcp), or run: npx megalens-mcp setup')
      continue
    }
    const auth = entry.headers?.Authorization
    if (origins[0] !== API_BASE || typeof auth !== 'string') continue
    const t = auth.replace(/^Bearer\s+/, '').trim()
    if (TOKEN_REGEX.test(t)) return t
  }
  return null
}

async function cmdValidate() {
  let token = await savedProductionToken(await detectTools())
  if (!token) {
    token = await ask('  Enter your MegaLens token: ', { hidden: true })
    if (!token) throw new InputEnded()
  } else {
    console.log(`\n  Found token in config: ml_tok_****`)
  }

  const { valid } = await validateToken(token)
  if (!valid) process.exitCode = 1
}

async function cmdConfig() {
  console.log('\n  MegaLens MCP Config Status\n')
  const tools = await detectTools()

  if (tools.length === 0) {
    console.log('  No configured tools found.')
    console.log('  Run `megalens-mcp setup` to get started.\n')
    return
  }

  for (const tool of tools) {
    let status = 'no token'
    if (tool.format === 'toml') {
      const raw = await readFile(tool.activePath, 'utf-8').catch(() => '')
      status = raw.includes('[mcp_servers.megalens]') ? 'configured' : 'no token'
    } else {
      const config = (await readJson(tool.activePath)).data
      const serverConfig = config?.mcpServers?.megalens || config?.servers?.megalens
      const hasToken = !!serverConfig?.headers?.Authorization
      status = hasToken ? 'configured' : 'no token'
    }
    console.log(`  ${tool.name}: ${tool.activePath} [${status}]`)
  }
  console.log()
}

// ── Main ──

const HELP_TEXT = `
  Usage: megalens-mcp <command>

  Commands:
    setup                Sign in through the browser; the token goes straight into your tools
    setup --manual       Same, but paste a token from megalens.ai/app/settings/mcp
    setup codex          Interactive Codex setup (config.toml + AGENTS.md)
    setup claude-code    Interactive Claude Code setup (CLI + CLAUDE.md)
    setup antigravity    Interactive Antigravity setup (CLI + GEMINI.md)
    setup agy            Alias for setup antigravity
    validate             Test your token connectivity
    config               Show current config locations + status
    help                 Show this help
`

const VALID_SETUP_TARGETS = ['codex', 'claude-code', 'antigravity', 'agy']

const cmd = process.argv[2] || 'setup'

try {
switch (cmd) {
  case 'setup': {
    const target = process.argv[3]
    if (target === 'codex') {
      const result = await runSetupCodex(process.argv.slice(4), {
        tomlHelpers: { scanTomlLine, tomlHeaderPath, stripTomlTable },
      })
      if (result.exitCode) process.exitCode = result.exitCode
    } else if (target === 'claude-code') {
      const result = await runSetupClaudeCode(process.argv.slice(4))
      if (result.exitCode) process.exitCode = result.exitCode
    } else if (target === 'antigravity' || target === 'agy') {
      const result = await runSetupAntigravity(process.argv.slice(4))
      if (result.exitCode) process.exitCode = result.exitCode
    } else if (target === '--help' || target === '-h') {
      console.log(HELP_TEXT)
    } else if (target === '--dry-run') {
      console.error('  The generic `setup` wizard does not support --dry-run (nothing was written).')
      console.error(`  Valid targets that support --dry-run: ${VALID_SETUP_TARGETS.join(', ')}`)
      console.error('  Example: megalens-mcp setup codex --dry-run')
      process.exit(1)
    } else if (target === '--manual') {
      await cmdSetupManual()
    } else if (target === '--force') {
      // Kept for old instructions: every run now signs in, so --force is plain setup.
      await cmdSetup()
    } else if (!target) {
      await cmdSetup()
    } else {
      console.error(`  Unknown setup target: ${maskTokenSecrets(target)}.`)
      console.error(`  Valid targets: ${VALID_SETUP_TARGETS.join(', ')}`)
      console.error("  Run 'megalens-mcp help' for usage.")
      process.exit(1)
    }
    break
  }
  case 'validate':
    await cmdValidate()
    break
  case 'config':
    await cmdConfig()
    break
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP_TEXT)
    break
  default:
    console.error(`  Unknown command: ${maskTokenSecrets(cmd)}. Run 'megalens-mcp help' for usage.`)
    process.exit(1)
}
} catch (err) {
  if (!(err instanceof InputEnded)) throw err
  // A closed stdin never answers a question (Astra FIX 12 #8): stop, change nothing more.
  console.error('\n  The input ended before an answer, so setup stopped. Nothing more was changed.\n')
  process.exitCode = 1
}

// Let the process exit: an open line reader on a terminal would keep it alive.
closeInput()
