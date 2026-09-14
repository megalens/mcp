#!/usr/bin/env node

/**
 * @megalens/mcp — CLI setup helper
 *
 * Usage:
 *   megalens-mcp setup           Interactive setup: detect tool, write config
 *   megalens-mcp validate        Test your token connectivity
 *   megalens-mcp config          Show current config location + status
 */

import { readFile, writeFile, access, mkdir, chmod } from 'fs/promises'
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
  } catch {
    return { missing: true, data: null }
  }
  if (raw.trim() === '') return { missing: true, data: null }
  try {
    return { missing: false, data: JSON.parse(raw) }
  } catch (err) {
    return { missing: false, data: null, unreadable: String(err?.message ?? err) }
  }
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  // Restrict permissions: token is sensitive (Gemini security fix)
  await chmod(path, 0o600)
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

async function writeToolConfig(tool, path, token) {
  if (tool.format === 'toml') {
    const existing = await readFile(path, 'utf-8').catch(() => '')
    if (existing.includes('[mcp_servers.megalens]')) {
      console.log('  MegaLens already in config — skipping.')
      return
    }
    await writeFile(path, existing + tool.toml(token), 'utf-8')
    await chmod(path, 0o600)
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
      return
    }
    const fragment = tool.shape(token)
    const merged = tool.merge(read.data ?? {}, fragment)
    await writeJson(path, merged)
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
  for (const tool of tools) {
    console.log(`\n  Found: ${tool.name} (${tool.activePath})`)
    const proceed = await ask(`  Add MegaLens to ${tool.name}? (Y/n): `)
    if (proceed.toLowerCase() === 'n') continue

    await writeToolConfig(tool, tool.activePath, token)
    console.log(`  Updated ${tool.activePath}`)
  }

  console.log('\n  Setup complete. Restart your tool to activate MegaLens.\n')
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
