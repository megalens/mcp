#!/usr/bin/env node

/**
 * @megalens/mcp — CLI setup helper
 *
 * Usage:
 *   megalens-mcp setup           Interactive setup: detect tool, write config
 *   megalens-mcp validate        Test your token connectivity
 *   megalens-mcp config          Show current config location + status
 */

import { readFile, writeFile, access, mkdir, chmod, rename, unlink, realpath, stat, chown } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'

const API_BASE = 'https://megalens.ai'
const MCP_URL = `${API_BASE}/api/mcp`

/**
 * Each tool gets a URL that says which tool it is.
 *
 * The server has a whole attribution chain for this -- an `x-megalens-caller`
 * header, then `?ide=`, then User-Agent sniffing -- and this client was handing
 * every tool the same bare URL. Measured on 94 real runs: **75 arrived as
 * `unknown`**, which breaks the feature this README leads with. MegaLens picks
 * engines by skipping the caller's own model ("Claude Code? MegaLens skips
 * Claude"), and it cannot skip a host it was never told about.
 *
 * `?ide=` rather than a header because it survives every config format here,
 * including Codex's TOML and VS Code's, where header support is not documented.
 */
const mcpUrlFor = (ide) => `${MCP_URL}?ide=${ide}`
const VALIDATE_URL = `${API_BASE}/api/mcp/validate`

// ── Helpers ──

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout })
}

function ask(prompt, { hidden = false } = {}) {
  const r = rl()
  if (hidden) process.stdout.write(prompt)
  return new Promise((resolve) => {
    if (hidden) {
      const original = process.stdin.setRawMode
      if (process.stdin.isTTY) process.stdin.setRawMode(true)
      let buf = ''
      const onData = (ch) => {
        const c = ch.toString()
        if (c === '\n' || c === '\r') {
          if (process.stdin.isTTY) process.stdin.setRawMode(false)
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          r.close()
          resolve(buf.trim())
        } else if (c === '') {
          process.exit(1)
        } else if (c === '' || c === '\b') {
          buf = buf.slice(0, -1)
        } else {
          buf += c
        }
      }
      process.stdin.on('data', onData)
    } else {
      r.question(prompt, (answer) => {
        r.close()
        resolve(answer.trim())
      })
    }
  })
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

const TOOLS = [
  {
    name: 'Claude Code',
    format: 'json',
    configPaths: [
      join(homedir(), '.claude.json'),
    ],
    shape: (token) => ({
      mcpServers: {
        megalens: { type: 'http', url: mcpUrlFor('claude-code'), headers: { Authorization: `Bearer ${token}` } },
      },
    }),
    merge: (existing, fragment) => ({
      ...existing,
      mcpServers: { ...(existing.mcpServers || {}), ...fragment.mcpServers },
    }),
  },
  {
    name: 'Codex CLI',
    format: 'toml',
    configPaths: [
      join(homedir(), '.codex', 'config.toml'),
      join(homedir(), '.config', 'codex', 'config.toml'),
    ],
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
    format: 'toml',
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
    merge: (existing, fragment) => ({
      ...existing,
      mcpServers: { ...(existing.mcpServers || {}), ...fragment.mcpServers },
    }),
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
    merge: (existing, fragment) => ({
      ...existing,
      mcpServers: { ...(existing.mcpServers || {}), ...fragment.mcpServers },
    }),
  },
  {
    name: 'VS Code (Copilot)',
    format: 'json',
    configPaths: [
      join(process.cwd(), '.vscode', 'mcp.json'),
    ],
    shape: (token) => ({
      servers: {
        megalens: { type: 'http', url: mcpUrlFor('copilot'), headers: { Authorization: `Bearer ${token}` } },
      },
    }),
    merge: (existing, fragment) => ({
      ...existing,
      servers: { ...(existing.servers || {}), ...fragment.servers },
    }),
  },
  {
    name: 'Windsurf',
    format: 'json',
    configPaths: [
      join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    ],
    shape: (token) => ({
      mcpServers: {
        megalens: { serverUrl: mcpUrlFor('windsurf'), headers: { Authorization: `Bearer ${token}` } },
      },
    }),
    merge: (existing, fragment) => ({
      ...existing,
      mcpServers: { ...(existing.mcpServers || {}), ...fragment.mcpServers },
    }),
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
    const res = await fetch(VALIDATE_URL, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    if (data.valid) {
      console.log('\n  Token is valid.')
      console.log(`  Plan: ${data.plan_code}`)
      if (data.is_payg) console.log('  Billing: Pay-as-you-go (managed keys)\n')
      else if (data.is_pro) console.log('  Billing: Pro\n')
      else console.log('  Billing: Free\n')
      return { valid: true, isPro: !!data.is_pro, isPayg: !!data.is_payg }
    } else {
      console.error(`\n  Token invalid: ${data.error}\n`)
      return { valid: false, isPro: false, isPayg: false }
    }
  } catch (err) {
    console.error(`\n  Connection failed: ${err.message}\n`)
    return { valid: false, isPro: false, isPayg: false }
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
 * `[mcp_servers.megalens]`, `[ mcp_servers.megalens ]`,
 * `[mcp_servers."megalens"]` and `[mcp_servers.megalens] # note` are all the
 * same table, and an exact string comparison recognises only the first. That
 * mattered: a trailing comment made the old check miss the existing table, so
 * setup appended a second one and produced TOML that Codex refuses to load
 * ("cannot declare ... twice") while reporting success. Returns null when the
 * line is not a header.
 */
function tomlHeaderPath(line) {
  const t = line.trim()
  if (!t.startsWith('[')) return null
  const isArray = t.startsWith('[[')
  const open = isArray ? 2 : 1
  const close = isArray ? ']]' : ']'
  const end = t.indexOf(close, open)
  if (end === -1) return null
  const after = t.slice(end + close.length).trim()
  if (after && !after.startsWith('#')) return null
  const parts = []
  let cur = ''
  let quote = null
  for (const ch of t.slice(open, end)) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '.') {
      parts.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  parts.push(cur.trim())
  return parts.some((p) => p === '') ? null : parts.join('.')
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
  if (tool.format === 'toml') {
    // Same rule as readJson: only ENOENT is a blank slate. Swallowing EACCES
    // here would hand stripTomlTable an empty string and replace a config we
    // were never able to see with one holding nothing but MegaLens.
    let existing = ''
    let unreadable = null
    try {
      existing = await readFile(path, 'utf-8')
    } catch (err) {
      if (err?.code !== 'ENOENT') unreadable = String(err?.message ?? err)
    }
    const without = unreadable === null ? stripTomlTable(existing, 'mcp_servers.megalens') : null
    if (without === null) {
      console.log(`\n  ! ${path} could not be read${unreadable ? `: ${unreadable}` : ' as TOML — a string or bracket is left open.'}`)
      console.log('    Not touching it — your existing config is intact.')
      console.log('    Add this block yourself, or fix the file and run setup again:\n')
      console.log(`${tool.toml(token).trim()}\n`)
      return 'skipped'
    }
    await writeFileAtomic(path, without.replace(/\s+$/, '') + '\n' + tool.toml(token))
    return 'written'
  } else {
    const read = await readJson(path)
    if (read.unreadable) {
      /**
       * Never overwrite a file we could not read. It has the customer's other servers in it.
       */
      console.log(`\n  ! ${path} exists but could not be parsed as JSON:`)
      console.log(`    ${read.unreadable}`)
      console.log('    Not touching it — your existing config is intact.')
      console.log('    Add this block yourself, or fix the file and run setup again:\n')
      console.log(`${JSON.stringify(tool.shape(token), null, 2)}\n`)
      return 'skipped'
    }
    const fragment = tool.shape(token)
    const merged = tool.merge(read.data ?? {}, fragment)
    await writeJson(path, merged)
    return 'written'
  }
}

async function cmdSetup() {
  console.log('\n  MegaLens MCP Setup\n')

  // 1. Get token
  const token = await ask('  Enter your MegaLens token (ml_tok_...): ', { hidden: true })
  if (!token.startsWith('ml_tok_')) {
    console.error('  Invalid token format. Get your token at https://megalens.ai/app/settings/mcp\n')
    process.exit(1)
  }

  // 2. Validate and detect plan
  console.log('\n  Validating token...')
  const result = await validateToken(token)
  if (!result.valid) {
    const cont = await ask('  Continue anyway? (y/N): ')
    if (cont.toLowerCase() !== 'y') process.exit(1)
  }

  // 3. Detect tools
  const tools = await detectTools()

  if (tools.length === 0) {
    console.log('  No supported tools detected.')
    console.log('  Supported: Claude Code, Codex CLI, Grok Build, Cursor, Gemini CLI, VS Code, Windsurf')
    console.log('  Manual setup: https://megalens.ai/integrations\n')

    const choices = TOOLS.map((t, i) => `    ${i + 1}. ${t.name}`).join('\n')
    console.log('  Which tool do you want to configure?\n' + choices)
    const pick = await ask('\n  Enter number (or press Enter to skip): ')
    const idx = parseInt(pick, 10) - 1
    if (idx >= 0 && idx < TOOLS.length) {
      const tool = TOOLS[idx]
      const path = tool.configPaths[0]
      const dir = path.substring(0, path.lastIndexOf('/'))
      await mkdir(dir, { recursive: true }).catch(() => {})
      await writeToolConfig(tool, path, token)
      console.log(`\n  Created ${path}`)
      console.log(`  Restart ${tool.name} to activate MegaLens.\n`)
    }
    return
  }

  // 4. Write config for each detected tool
  const configured = []
  let accepted = 0
  for (const tool of tools) {
    console.log(`\n  Found: ${tool.name} (${tool.activePath})`)
    const proceed = await ask(`  Add MegaLens to ${tool.name}? (Y/n): `)
    if (proceed.toLowerCase() === 'n') continue
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

async function cmdValidate() {
  // Try to find token from existing configs
  const tools = await detectTools()
  let token = null

  for (const tool of tools) {
    const config = (await readJson(tool.activePath)).data
    const serverConfig = config?.mcpServers?.megalens || config?.mcp?.servers?.megalens
    if (serverConfig?.headers?.Authorization) {
      token = serverConfig.headers.Authorization.replace('Bearer ', '')
      break
    }
  }

  if (!token) {
    token = await ask('  Enter your MegaLens token: ', { hidden: true })
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

const cmd = process.argv[2] || 'setup'

switch (cmd) {
  case 'setup':
    await cmdSetup()
    break
  case 'validate':
    await cmdValidate()
    break
  case 'config':
    await cmdConfig()
    break
  case 'help':
  case '--help':
  case '-h':
    console.log(`
  Usage: megalens-mcp <command>

  Commands:
    setup      Interactive setup — detect tools, write config
    validate   Test your token connectivity
    config     Show current config locations + status
    help       Show this help
`)
    break
  default:
    console.error(`  Unknown command: ${cmd}. Run 'megalens-mcp help' for usage.`)
    process.exit(1)
}
