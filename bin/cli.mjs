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

async function readJson(path) {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw)
  } catch { return null }
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
    configPaths: [
      join(homedir(), '.claude.json'),
    ],
    shape: (token) => ({
      mcpServers: {
        megalens: {
          url: MCP_URL,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }),
    merge: (existing, fragment) => ({
      ...existing,
      mcpServers: { ...(existing.mcpServers || {}), ...fragment.mcpServers },
    }),
  },
  {
    name: 'Codex',
    configPaths: [
      join(homedir(), '.codex', 'config.json'),
      join(homedir(), '.config', 'codex', 'config.json'),
    ],
    shape: (token) => ({
      mcp: {
        servers: {
          megalens: {
            url: MCP_URL,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
    }),
    merge: (existing, fragment) => ({
      ...existing,
      mcp: {
        ...(existing.mcp || {}),
        servers: { ...(existing.mcp?.servers || {}), ...fragment.mcp.servers },
      },
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
      console.log(`  Pro:  ${data.is_pro ? 'Yes' : 'No'}\n`)
      return true
    } else {
      console.error(`\n  Token invalid: ${data.error}\n`)
      return false
    }
  } catch (err) {
    console.error(`\n  Connection failed: ${err.message}\n`)
    return false
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

  // 2. Validate
  console.log('\n  Validating token...')
  const valid = await validateToken(token)
  if (!valid) {
    const cont = await ask('  Continue anyway? (y/N): ')
    if (cont.toLowerCase() !== 'y') process.exit(1)
  }

  // 3. Detect tools
  const tools = await detectTools()

  if (tools.length === 0) {
    console.log('  No supported tools detected (Claude Code, Codex).')
    console.log('  You can manually add the MCP config. See: https://megalens.ai/app/settings/mcp\n')

    // Offer to create .claude.json anyway
    const create = await ask('  Create ~/.claude.json for Claude Code? (Y/n): ')
    if (create.toLowerCase() !== 'n') {
      const tool = TOOLS[0]
      const path = tool.configPaths[0]
      const fragment = tool.shape(token)
      await writeJson(path, fragment)
      console.log(`\n  Created ${path}`)
      console.log('  Restart Claude Code to activate MegaLens.\n')
    }
    return
  }

  // 4. Write config for each detected tool
  for (const tool of tools) {
    console.log(`\n  Found: ${tool.name} (${tool.activePath})`)
    const proceed = await ask(`  Add MegaLens to ${tool.name}? (Y/n): `)
    if (proceed.toLowerCase() === 'n') continue

    const existing = (await readJson(tool.activePath)) || {}
    const fragment = tool.shape(token)
    const merged = tool.merge(existing, fragment)

    await writeJson(tool.activePath, merged)
    console.log(`  Updated ${tool.activePath}`)
  }

  console.log('\n  Setup complete. Restart your tool to activate MegaLens.\n')
}

async function cmdValidate() {
  // Try to find token from existing configs
  const tools = await detectTools()
  let token = null

  for (const tool of tools) {
    const config = await readJson(tool.activePath)
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

  await validateToken(token)
}

async function cmdConfig() {
  console.log('\n  MegaLens MCP Config Status\n')
  const tools = await detectTools()

  if (tools.length === 0) {
    console.log('  No configured tools found.\n')
    return
  }

  for (const tool of tools) {
    const config = await readJson(tool.activePath)
    const serverConfig = config?.mcpServers?.megalens || config?.mcp?.servers?.megalens
    const hasToken = !!serverConfig?.headers?.Authorization
    const status = hasToken ? 'configured' : 'no token'
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
