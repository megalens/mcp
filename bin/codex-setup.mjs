import { readFile, writeFile, copyFile, mkdir, chmod, rename, unlink, realpath, stat, chown, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

export const CODEX_AGENTS_LINE =
  'After you change code that handles money, sign-in, user data or database migrations, and before the user commits it, offer a MegaLens review and wait for a yes before running it.'

export const CODEX_MCP_URL = 'https://megalens.ai/api/mcp?ide=codex'
export const TOKEN_REGEX = /^ml_tok_[0-9a-f]{32}$/i
export const MASKED_TOKEN = 'ml_tok_****'
export const FINAL_MESSAGE =
  'Restart Codex, then ask it to get a second opinion from MegaLens on your next change.'

export function resolveCodexHome(env = process.env, home = homedir()) {
  const custom = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  return custom ? resolve(custom) : join(home, '.codex')
}

export function formatCodexTomlBlock(token, eol = '\n') {
  return [
    '[mcp_servers.megalens]',
    `url = "${CODEX_MCP_URL}"`,
    `http_headers = { "Authorization" = "Bearer ${token}" }`,
  ].join(eol) + eol
}

export function hasTomlTable(text, table, { scanTomlLine, tomlHeaderPath }) {
  let delim = null
  let depth = 0
  for (const line of text.split('\n')) {
    if (!delim && depth === 0) {
      const path = tomlHeaderPath(line)
      if (path !== null && (path === table || path.startsWith(`${table}.`))) return true
    }
    ;({ delim, depth } = scanTomlLine(line, delim, depth))
  }
  return false
}

export function hasMegaLensAgentsLine(text) {
  return text
    .split(/\r?\n/)
    .some((line) => line.trim() === CODEX_AGENTS_LINE || /offer a MegaLens review/i.test(line))
}

function maskSecretsInToml(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '#') {
      out += text.slice(i)
        .replace(/ml_tok_[0-9a-f]+/gi, MASKED_TOKEN)
        .replace(/(Bearer\s+)(?!ml_tok_\*{4})([^\s"']+)/gi, '$1****')
      break
    }
    const three = text.slice(i, i + 3)
    if (three === '"""' || three === "'''") {
      const end = text.indexOf(three, i + 3)
      if (end === -1) {
        out += `${three}****`
        break
      }
      out += `${three}****${three}`
      i = end + 3
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      while (j < text.length) {
        if (quote === '"' && text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === quote) break
        j++
      }
      const closed = j < text.length
      const inner = text.slice(i + 1, j)
      let k = closed ? j + 1 : j
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++
      const isKey = text[k] === '=' || text[k] === '.'
      if (isKey) {
        const maskedKey = inner
          .replace(/ml_tok_[0-9a-f]+/gi, MASKED_TOKEN)
          .replace(/(Bearer\s+)(?!ml_tok_\*{4})([^\s"']+)/gi, '$1****')
        out += `${quote}${maskedKey}${closed ? quote : ''}`
      } else {
        let maskedVal = '****'
        if (/^Bearer\s+ml_tok_[0-9a-f]+$/i.test(inner)) {
          maskedVal = `Bearer ${MASKED_TOKEN}`
        } else if (/^Bearer\s+/i.test(inner)) {
          maskedVal = 'Bearer ****'
        }
        out += `${quote}${maskedVal}${closed ? quote : ''}`
      }
      i = closed ? j + 1 : j
      continue
    }
    out += ch
    i++
  }
  return out
    .replace(/ml_tok_[0-9a-f]+/gi, MASKED_TOKEN)
    .replace(/(Bearer\s+)(?!ml_tok_\*{4})([^\s"']+)/gi, '$1****')
}

function isMegalensName(name) {
  return typeof name === 'string' && name.toLowerCase() === 'megalens'
}

function findTopLevelEquals(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (quote === '"' && ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return -1
    } else if (ch === '=') {
      return i
    }
  }
  return -1
}

function splitTomlDottedKey(raw) {
  const parts = []
  let cur = ''
  let quoted = false
  let quote = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (quote === '"' && ch === '\\' && i + 1 < raw.length) {
        cur += raw[++i]
      } else if (ch === quote) {
        quote = null
      } else {
        cur += ch
      }
    } else if (ch === '"' || ch === "'") {
      quoted = true
      quote = ch
    } else if (ch === '.') {
      const name = cur.trim()
      if (!name && !quoted) return null
      parts.push({ name, quoted })
      cur = ''
      quoted = false
    } else {
      cur += ch
    }
  }
  if (quote !== null) return null
  const name = cur.trim()
  if (!name && !quoted) return null
  parts.push({ name, quoted })
  return parts
}

function stripTomlCommentsFromLines(lines) {
  let delim = null
  const out = []
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    let i = 0
    let cutAt = line.length
    while (i < line.length) {
      if (delim) {
        if (line.startsWith(delim, i)) {
          delim = null
          i += 3
        } else {
          i++
        }
        continue
      }
      const three = line.slice(i, i + 3)
      if (three === '"""' || three === "'''") {
        delim = three
        i += 3
        continue
      }
      const ch = line[i]
      if (ch === '#') {
        cutAt = i
        break
      }
      if (ch === '"' || ch === "'") {
        i++
        while (i < line.length) {
          if (ch === '"' && line[i] === '\\') {
            i += 2
            continue
          }
          if (line[i] === ch) {
            i++
            break
          }
          i++
        }
        continue
      }
      i++
    }
    out.push(line.slice(0, cutAt))
  }
  return out
}

function inspectHttpHeadersInlineTable(headerLines) {
  if (!headerLines.length) return { valid: false, keys: [] }
  const firstNoCr = headerLines[0].endsWith('\r') ? headerLines[0].slice(0, -1) : headerLines[0]
  const eqIdx = findTopLevelEquals(firstNoCr)
  if (eqIdx === -1) return { valid: false, keys: [] }

  const rhsLines = [firstNoCr.slice(eqIdx + 1), ...headerLines.slice(1)]
  const rhs = stripTomlCommentsFromLines(rhsLines).join('\n').trim()
  if (!rhs.startsWith('{') || !rhs.endsWith('}')) {
    return { valid: false, keys: [] }
  }

  // Verify the opening brace matches the very last character.
  let braceDepth = 0
  let delim = null
  for (let i = 0; i < rhs.length; i++) {
    if (delim) {
      if (rhs.startsWith(delim, i)) {
        delim = null
        i += 2
      }
      continue
    }
    const three = rhs.slice(i, i + 3)
    if (three === '"""' || three === "'''") {
      delim = three
      i += 2
      continue
    }
    const ch = rhs[i]
    if (ch === '"' || ch === "'") {
      i++
      while (i < rhs.length) {
        if (ch === '"' && rhs[i] === '\\') {
          i += 2
          continue
        }
        if (rhs[i] === ch) break
        i++
      }
      continue
    }
    if (ch === '{' || ch === '[') braceDepth++
    else if (ch === '}' || ch === ']') {
      braceDepth--
      if (braceDepth === 0 && i !== rhs.length - 1) {
        return { valid: false, keys: [] }
      }
    }
  }
  if (braceDepth !== 0 || delim !== null) {
    return { valid: false, keys: [] }
  }

  const inner = rhs.slice(1, -1)
  const entries = []
  let start = 0
  let depth = 0
  delim = null
  for (let i = 0; i < inner.length; i++) {
    if (delim) {
      if (inner.startsWith(delim, i)) {
        delim = null
        i += 2
      }
      continue
    }
    const three = inner.slice(i, i + 3)
    if (three === '"""' || three === "'''") {
      delim = three
      i += 2
      continue
    }
    const ch = inner[i]
    if (ch === '"' || ch === "'") {
      i++
      while (i < inner.length) {
        if (ch === '"' && inner[i] === '\\') {
          i += 2
          continue
        }
        if (inner[i] === ch) break
        i++
      }
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      entries.push(inner.slice(start, i))
      start = i + 1
    }
  }
  entries.push(inner.slice(start))

  const keys = []
  for (const rawEntry of entries) {
    const entry = rawEntry.trim()
    if (!entry) continue
    const entryEq = findTopLevelEquals(entry)
    if (entryEq === -1) return { valid: false, keys: [] }
    const keyParts = splitTomlDottedKey(entry.slice(0, entryEq))
    if (!keyParts || keyParts.length !== 1) return { valid: false, keys: [] }
    keys.push(keyParts[0].name)
  }

  return { valid: true, keys }
}

function inspectCodexConfig(text, { scanTomlLine, tomlHeaderPath }) {
  const lines = text.split('\n')
  let delim = null
  let depth = 0
  let currentTable = null
  let megalensHeaderCount = 0
  let megalensStartIdx = -1
  let megalensEndIdx = -1
  let httpHeadersIdx = -1
  let httpHeadersEndIdx = -1
  let hasHttpHeadersSubtable = false
  let hasMegalensSubtable = false
  let hasCommandOrArgs = false
  let hasUrl = false
  let uneditable = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (i === 0 && line.startsWith('\uFEFF')) {
      line = line.slice(1)
    }

    if (!delim && depth === 0) {
      const path = tomlHeaderPath(line)
      if (path !== null) {
        currentTable = path
        const headerParts = path.split('.')
        const isArrayHeader = line.trim().startsWith('[[')
        if (headerParts.length === 2 && headerParts[0] === 'mcp_servers' && isMegalensName(headerParts[1])) {
          if (isArrayHeader) {
            uneditable = true
          } else {
            megalensHeaderCount++
            if (megalensHeaderCount === 1) {
              megalensStartIdx = i
              megalensEndIdx = i
            }
          }
        } else if (headerParts.length >= 3 && headerParts[0] === 'mcp_servers' && isMegalensName(headerParts[1])) {
          hasMegalensSubtable = true
          if (headerParts.length === 3 && headerParts[2] === 'http_headers') {
            hasHttpHeadersSubtable = true
          }
        }
      } else {
        const trimmed = line.trim()
        if (trimmed && !trimmed.startsWith('#')) {
          const tableParts = currentTable ? currentTable.split('.') : []
          const inMegalensTable =
            tableParts.length === 2 && tableParts[0] === 'mcp_servers' && isMegalensName(tableParts[1])
          const eqIdx = findTopLevelEquals(line)
          const keyParts = eqIdx !== -1 ? splitTomlDottedKey(line.slice(0, eqIdx)) : null

          if (keyParts) {
            const fullParts = [...tableParts, ...keyParts.map((k) => k.name)]
            if (tableParts.length < 2) {
              if (
                (fullParts.length >= 2 && fullParts[0] === 'mcp_servers' && isMegalensName(fullParts[1])) ||
                (fullParts.length === 1 && fullParts[0] === 'mcp_servers')
              ) {
                uneditable = true
              }
            } else if (inMegalensTable && megalensHeaderCount === 1) {
              const first = keyParts[0]
              if (first.name === 'http_headers') {
                if (keyParts.length > 1 || first.quoted) {
                  uneditable = true
                } else if (httpHeadersIdx === -1) {
                  httpHeadersIdx = i
                } else {
                  uneditable = true
                }
              }
              if (first.name === 'command' || first.name === 'args') {
                hasCommandOrArgs = true
              }
              if (keyParts.length === 1 && first.name === 'url') {
                hasUrl = true
              }
            }
          }
        }
      }
    }

    const currentParts = currentTable ? currentTable.split('.') : []
    if (
      currentParts.length === 2 &&
      currentParts[0] === 'mcp_servers' &&
      isMegalensName(currentParts[1]) &&
      megalensHeaderCount === 1
    ) {
      megalensEndIdx = i
    }

    const next = scanTomlLine(line, delim, depth)
    if (httpHeadersIdx !== -1 && httpHeadersEndIdx === -1) {
      if (!next.delim && next.depth === 0) {
        httpHeadersEndIdx = i
      }
    }
    delim = next.delim
    depth = next.depth
  }

  if (delim || depth !== 0) {
    return { unparseable: true }
  }

  const hasEntry = megalensHeaderCount > 0 || hasMegalensSubtable
  if (hasHttpHeadersSubtable || megalensHeaderCount > 1 || (hasMegalensSubtable && megalensHeaderCount === 0)) {
    uneditable = true
  }
  if (megalensHeaderCount === 1 && (hasCommandOrArgs || !hasUrl)) {
    uneditable = true
  }
  if (!uneditable && httpHeadersIdx !== -1) {
    const parsedHeaders = inspectHttpHeadersInlineTable(lines.slice(httpHeadersIdx, httpHeadersEndIdx + 1))
    if (!parsedHeaders.valid || parsedHeaders.keys.some((k) => k !== 'Authorization')) {
      uneditable = true
    }
  }

  return {
    unparseable: false,
    uneditable,
    hasEntry,
    lines,
    megalensStartIdx,
    megalensEndIdx,
    httpHeadersIdx,
    httpHeadersEndIdx,
  }
}

function buildHttpHeadersReplacement(info, token, configEol) {
  const cr = configEol === '\r\n' ? '\r' : ''
  const nextLines = [...info.lines]

  if (info.httpHeadersIdx !== -1) {
    const rawFirst = nextLines[info.httpHeadersIdx]
    const firstNoCr = rawFirst.endsWith('\r') ? rawFirst.slice(0, -1) : rawFirst
    const indent = (firstNoCr.match(/^\s*/) || [''])[0]
    const newLine = `${indent}http_headers = { "Authorization" = "Bearer ${token}" }`
    const maskedNewLine = `${indent}http_headers = { "Authorization" = "Bearer ${MASKED_TOKEN}" }`
    const beforeLines = nextLines
      .slice(info.httpHeadersIdx, info.httpHeadersEndIdx + 1)
      .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    const lineCr = rawFirst.endsWith('\r') ? '\r' : cr
    nextLines.splice(info.httpHeadersIdx, info.httpHeadersEndIdx - info.httpHeadersIdx + 1, `${newLine}${lineCr}`)
    return {
      nextConfig: nextLines.join('\n'),
      beforeLines,
      maskedNewLine,
    }
  }

  let insertAfterIdx = info.megalensStartIdx
  for (let i = info.megalensEndIdx; i > info.megalensStartIdx; i--) {
    const lineNoCr = nextLines[i].endsWith('\r') ? nextLines[i].slice(0, -1) : nextLines[i]
    if (lineNoCr.trim() !== '') {
      insertAfterIdx = i
      break
    }
  }
  let indent = ''
  if (insertAfterIdx > info.megalensStartIdx) {
    const refLine = nextLines[insertAfterIdx]
    indent = (refLine.match(/^\s*/) || [''])[0]
  }
  const newLine = `${indent}http_headers = { "Authorization" = "Bearer ${token}" }`
  const maskedNewLine = `${indent}http_headers = { "Authorization" = "Bearer ${MASKED_TOKEN}" }`
  nextLines.splice(insertAfterIdx + 1, 0, `${newLine}${cr}`)
  return {
    nextConfig: nextLines.join('\n'),
    beforeLines: null,
    maskedNewLine,
  }
}

async function getReadOnlyReason(filePath) {
  const target = await realpath(filePath).catch(() => filePath)
  const st = await stat(target).catch(() => null)
  if (!st) return null
  const mode = st.mode & 0o777
  if ((mode & 0o222) === 0) {
    return `mode 0${mode.toString(8)}`
  }
  try {
    await access(target, constants.W_OK)
    return null
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EROFS' || err?.code === 'EPERM') {
      return err.code
    }
    return null
  }
}

function makeTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-')
}

function isYes(answer) {
  const normalized = String(answer ?? '').trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

async function readOptionalFile(filePath) {
  try {
    const buf = await readFile(filePath)
    const content = utf8FatalDecoder.decode(buf)
    return { exists: true, content, unreadable: null }
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false, content: '', unreadable: null }
    return { exists: true, content: '', unreadable: String(err?.message ?? err) }
  }
}

async function backupExistingFile(targetPath, timestamp) {
  const backupPath = `${targetPath}.bak-${timestamp}`
  const existingStat = await stat(targetPath)
  await copyFile(targetPath, backupPath)
  await chmod(backupPath, existingStat.mode & 0o777).catch(() => {})
  return backupPath
}

async function writeFileAtomicPreservingMode(filePath, contents, { defaultMode, preserveMode = true, log }) {
  const target = await realpath(filePath).catch(() => filePath)
  await mkdir(dirname(target), { recursive: true })
  const existing = await stat(target).catch(() => null)
  const existingMode = existing ? (existing.mode & 0o777) : defaultMode
  const targetMode = preserveMode ? existingMode : defaultMode
  const tmp = `${target}.megalens-tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`

  if (existing && existing.nlink > 1) {
    log(`\n  ! ${target} has other hard links. They will keep the previous contents.`)
  }

  try {
    // Always create temp file with restrictive 0600 first so secrets are never briefly world-readable.
    await writeFile(tmp, contents, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    try {
      await chmod(tmp, targetMode)
    } catch (err) {
      if (!preserveMode && targetMode === 0o600) {
        log(`  ! Warning: could not enforce 0600 permissions on ${filePath}: ${err?.message ?? err}`)
      } else {
        throw err
      }
    }
    if (existing && typeof process.getuid === 'function') {
      if (existing.uid !== process.getuid() || existing.gid !== process.getgid()) {
        try {
          await chown(tmp, existing.uid, existing.gid)
        } catch {
          log(`\n  ! Could not preserve ownership of ${target}; it will belong to the current user.`)
        }
      }
    }
    await rename(tmp, target)
    if (!preserveMode && existing && (existingMode & 0o077) !== 0) {
      log(`  Note: tightened ${filePath} permissions from 0${existingMode.toString(8)} to 0600.`)
    }
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

class UserAbortError extends Error {
  constructor() {
    super('Aborted by user')
    this.name = 'UserAbortError'
    this.exitCode = 130
  }
}

async function discardPendingStdin(stdin) {
  if (stdin.readableEnded || stdin.destroyed) return
  while (stdin.read() !== null) {}
  const hasRaw = typeof stdin.setRawMode === 'function' && stdin.isTTY
  if (hasRaw) {
    try { stdin.setRawMode(true) } catch {}
  }
  const onData = () => {}
  stdin.on('data', onData)
  stdin.resume()
  await new Promise((r) => setTimeout(r, 25))
  stdin.removeListener('data', onData)
  stdin.pause()
  while (stdin.read() !== null) {}
  if (hasRaw) {
    try { stdin.setRawMode(false) } catch {}
  }
}

function createPrompter(stdin, stdout) {
  async function askPlain(prompt) {
    if (stdin.readableEnded || stdin.destroyed) {
      return ''
    }
    await discardPendingStdin(stdin)
    if (stdin.readableEnded || stdin.destroyed) {
      return ''
    }
    const rl = createInterface({ input: stdin, output: stdout })
    return new Promise((resolvePrompt, rejectPrompt) => {
      let settled = false
      const cleanup = () => {
        stdin.removeListener('end', onEnd)
        stdin.removeListener('data', onRawCheck)
        rl.removeListener('SIGINT', onSigint)
        process.removeListener('SIGINT', onSigint)
      }
      const finish = (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolvePrompt(value)
      }
      const onSigint = () => {
        if (settled) return
        settled = true
        cleanup()
        stdout.write('\n')
        try { rl.close() } catch {}
        if (typeof stdin.pause === 'function') stdin.pause()
        rejectPrompt(new UserAbortError())
      }
      const onRawCheck = (chunk) => {
        if (String(chunk).includes('\x03')) {
          onSigint()
        }
      }
      const onEnd = () => {
        finish('')
        rl.close()
      }
      rl.once('SIGINT', onSigint)
      process.once('SIGINT', onSigint)
      rl.once('close', () => finish(''))
      stdin.once('end', onEnd)
      stdin.on('data', onRawCheck)
      rl.question(prompt, (answer) => {
        finish(answer.trim())
        rl.close()
      })
    })
  }

  function askHidden(prompt) {
    stdout.write(prompt)
    if (stdin.readableEnded || stdin.destroyed) {
      stdout.write('\n')
      return Promise.reject(new Error('Aborted by user'))
    }
    return new Promise((resolvePrompt, rejectPrompt) => {
      const hasRaw = typeof stdin.setRawMode === 'function' && stdin.isTTY
      if (hasRaw) stdin.setRawMode(true)
      stdin.resume()
      let buf = ''
      let settled = false

      const cleanup = () => {
        stdin.removeListener('data', onData)
        stdin.removeListener('end', onEnd)
        process.removeListener('SIGINT', onSigint)
        if (hasRaw) {
          try { stdin.setRawMode(false) } catch {}
        }
        stdin.pause()
      }

      const onSigint = () => {
        if (settled) return
        settled = true
        cleanup()
        stdout.write('\n')
        rejectPrompt(new UserAbortError())
      }

      const onEnd = () => {
        if (settled) return
        settled = true
        cleanup()
        stdout.write('\n')
        rejectPrompt(new Error('Aborted by user'))
      }

      const onData = (chunk) => {
        const str = chunk.toString('utf-8')
        for (const ch of str) {
          if (ch === '\x03') {
            onSigint()
            return
          }
          if (ch === '\x04') {
            onEnd()
            return
          }
          if (ch === '\r' || ch === '\n') {
            if (settled) return
            settled = true
            cleanup()
            stdout.write('\n')
            resolvePrompt(buf.trim())
            return
          }
          if (ch === '\x7f' || ch === '\b') {
            buf = buf.slice(0, -1)
            continue
          }
          if (ch >= ' ') {
            buf += ch
          }
        }
      }

      process.once('SIGINT', onSigint)
      stdin.once('end', onEnd)
      stdin.on('data', onData)
    })
  }

  return { askPlain, askHidden }
}

function printNonInteractiveGuide({ configPath, agentsPath, log }) {
  log('\n  MegaLens Codex Setup (non-interactive mode: nothing was written)\n')
  log('  Manual steps:')
  log('  1. Get your MegaLens token at https://megalens.ai/app/settings/mcp')
  log(`  2. Add this block to ${configPath}:\n`)
  for (const line of formatCodexTomlBlock('ml_tok_your_token_here', '\n').trimEnd().split('\n')) {
    log(`     ${line}`)
  }
  log(`\n  3. Add this line to ${agentsPath}:\n`)
  log(`     ${CODEX_AGENTS_LINE}`)
  log(`\n  4. ${FINAL_MESSAGE}\n`)
}

export function parseSetupCodexArgs(args) {
  let dryRun = false
  let replaceToken = false
  let help = false

  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--replace-token') replaceToken = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--yes' || arg === '-y') {
      return { error: '--yes is not supported. Every write requires an explicit y at its own prompt.' }
    } else if (arg.startsWith('-')) {
      return { error: `Unknown option for setup codex: ${arg}` }
    } else {
      return { error: `Unexpected argument for setup codex: ${arg}` }
    }
  }

  return { dryRun, replaceToken, help }
}

export async function runSetupCodex(args = [], io = {}) {
  const {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    home = homedir(),
    platform = process.platform,
    isTTY = Boolean(stdin.isTTY),
    now = () => new Date(),
    tomlHelpers,
    promptOverride,
  } = io

  const log = (msg = '') => stdout.write(`${msg}\n`)
  const errLog = (msg = '') => stderr.write(`${msg}\n`)

  const parsed = parseSetupCodexArgs(args)
  if (parsed.error) {
    errLog(`  ${parsed.error}`)
    return { exitCode: 1, written: [], dryRun: false }
  }

  if (parsed.help) {
    log(`
  Usage: npx megalens-mcp setup codex [options]

  Options:
    --replace-token   Update the existing [mcp_servers.megalens] token in config.toml
    --dry-run         Show what would be written without changing any files
    -h, --help        Show this help
`)
    return { exitCode: 0, written: [], dryRun: false }
  }

  const codexHome = resolveCodexHome(env, home)
  const configPath = join(codexHome, 'config.toml')
  const agentsPath = join(codexHome, 'AGENTS.md')

  if (!isTTY) {
    printNonInteractiveGuide({ configPath, agentsPath, log })
    return { exitCode: 0, written: [], dryRun: parsed.dryRun }
  }

  const prompter = promptOverride ?? createPrompter(stdin, stdout)
  const written = []
  const dryRunNotes = []
  const timestamp = makeTimestamp(now())

  log('\n  MegaLens Codex Setup\n')
  if (parsed.dryRun) {
    log('  [dry-run] No files will be modified.\n')
  }

  // ── 1 & 2. Resolve config.toml and connect MCP ──
  const configRead = await readOptionalFile(configPath)
  if (configRead.unreadable) {
    errLog(`  ! ${configPath} could not be read: ${configRead.unreadable}`)
    errLog('    Leaving config.toml untouched.')
  } else {
    const existingConfig = configRead.content
    const info = existingConfig
      ? inspectCodexConfig(existingConfig, tomlHelpers)
      : { unparseable: false, uneditable: false, hasEntry: false }

    if (info.unparseable) {
      log(`  ! ${configPath} could not be parsed safely as TOML (unterminated string or bracket).`)
      log('    Leaving config.toml untouched.')
    } else if (info.uneditable) {
      log(`  ! MegaLens is already configured in ${configPath} in a form this tool cannot edit safely.`)
      log('    Leaving config.toml unchanged.')
      log('    Edit that entry by hand in config.toml so it uses:\n')
      for (const line of formatCodexTomlBlock('ml_tok_your_token_here', '\n').trimEnd().split('\n')) {
        log(`      ${line}`)
      }
      log('')
    } else {
      const { hasEntry } = info

      if (hasEntry && !parsed.replaceToken) {
        log(`  [mcp_servers.megalens] already exists in ${configPath}. Leaving it unchanged.`)
        log('  (Run with --replace-token to update the token.)\n')
      } else {
        const readOnlyReason = configRead.exists ? await getReadOnlyReason(configPath) : null
        if (readOnlyReason) {
          log(`  ! ${configPath} is read-only (${readOnlyReason}).`)
          log('    Refusing to replace it; leaving config.toml unchanged.\n')
        } else {
          const envToken = typeof env.MEGALENS_TOKEN === 'string' ? env.MEGALENS_TOKEN.trim() : ''
          let token = envToken
          if (!token) {
            try {
              token = await prompter.askHidden('  Enter your MegaLens token (ml_tok_...): ')
            } catch (err) {
              return { exitCode: err?.exitCode === 130 ? 130 : 1, written, dryRun: parsed.dryRun }
            }
          }

          if (!TOKEN_REGEX.test(token)) {
            errLog('  Invalid token format. Expected ml_tok_ followed by 32 hex characters.')
            errLog('  Get your token at https://megalens.ai/app/settings/mcp\n')
            return { exitCode: 1, written, dryRun: parsed.dryRun }
          }

          const defaultEol = platform === 'win32' ? '\r\n' : '\n'
          const configEol = configRead.exists && existingConfig.length > 0
            ? (existingConfig.includes('\r\n') ? '\r\n' : '\n')
            : defaultEol

          let replacement = null
          if (hasEntry) {
            replacement = buildHttpHeadersReplacement(info, token, configEol)
            log(`\n  Will ${replacement.beforeLines ? 'update http_headers in' : 'add http_headers to'} [mcp_servers.megalens] in ${configPath}:\n`)
            if (replacement.beforeLines) {
              for (const line of replacement.beforeLines) {
                log(`    - ${maskSecretsInToml(line)}`)
              }
            } else {
              log('    - (none)')
            }
            log(`    + ${replacement.maskedNewLine}`)
            log('')
          } else {
            const maskedBlock = formatCodexTomlBlock(MASKED_TOKEN, '\n').trimEnd()
            log(`\n  Will add to ${configPath}:\n`)
            for (const line of maskedBlock.split('\n')) {
              log(`    ${line}`)
            }
            log('')
          }

          const confirmPrompt = hasEntry
            ? '  Replace MegaLens token in Codex? (y/n): '
            : '  Add MegaLens to Codex? (y/n): '
          let answer
          try {
            answer = await prompter.askPlain(confirmPrompt)
          } catch (err) {
            if (err?.exitCode === 130) {
              return { exitCode: 130, written, dryRun: parsed.dryRun }
            }
            throw err
          }

          if (isYes(answer)) {
            let nextConfig
            if (hasEntry) {
              nextConfig = replacement.nextConfig
            } else {
              const block = formatCodexTomlBlock(token, configEol)
              const base = !existingConfig
                ? ''
                : (existingConfig.endsWith('\n') ? existingConfig : `${existingConfig}${configEol}`)
              nextConfig = `${base}${block}`
            }

            if (parsed.dryRun) {
              dryRunNotes.push(`${configPath} (would ${hasEntry ? 'update' : configRead.exists ? 'update' : 'create'})`)
              log(`  [dry-run] Would write ${configPath}`)
            } else {
              try {
                const target = await realpath(configPath).catch(() => configPath)
                if (configRead.exists) {
                  await backupExistingFile(target, timestamp)
                }
                await writeFileAtomicPreservingMode(configPath, nextConfig, {
                  defaultMode: 0o600,
                  preserveMode: false,
                  log,
                })
                written.push(configPath)
                log(`  Wrote ${configPath}`)
              } catch (err) {
                errLog(`  ! Failed to write ${configPath}: ${err?.message ?? err}`)
                return { exitCode: 1, written, dryRun: parsed.dryRun }
              }
            }
          } else {
            log(`  Skipped ${configPath}.`)
          }
          log('')
        }
      }
    }
  }

  // ── 3. AGENTS.md ──
  const agentsOverridePath = join(codexHome, 'AGENTS.override.md')
  const hasAgentsOverride = await access(agentsOverridePath).then(() => true, () => false)
  if (hasAgentsOverride) {
    log(`  Note: ${agentsOverridePath} exists; Codex may prefer it over AGENTS.md.`)
  }

  const agentsRead = await readOptionalFile(agentsPath)
  if (agentsRead.unreadable) {
    errLog(`  ! ${agentsPath} could not be read: ${agentsRead.unreadable}`)
    errLog('    Leaving AGENTS.md untouched.')
  } else if (agentsRead.exists && hasMegaLensAgentsLine(agentsRead.content)) {
    log(`  ${agentsPath} already has a MegaLens line. Leaving it unchanged.\n`)
  } else {
    const agentsReadOnlyReason = agentsRead.exists ? await getReadOnlyReason(agentsPath) : null
    if (agentsReadOnlyReason) {
      log(`  ! ${agentsPath} is read-only (${agentsReadOnlyReason}).`)
      log('    Refusing to replace it; leaving AGENTS.md unchanged.\n')
    } else {
      log('  Proposed AGENTS.md line:')
      log(`    ${CODEX_AGENTS_LINE}\n`)

      let answer
      try {
        answer = await prompter.askPlain(
          `  Add this line to ${agentsPath} so Codex offers a MegaLens review at the right moments? (y/n): `,
        )
      } catch (err) {
        if (err?.exitCode === 130) {
          return { exitCode: 130, written, dryRun: parsed.dryRun }
        }
        throw err
      }

      if (isYes(answer)) {
        const defaultEol = platform === 'win32' ? '\r\n' : '\n'
        const agentsEol = agentsRead.exists && agentsRead.content.length > 0
          ? (agentsRead.content.includes('\r\n') ? '\r\n' : '\n')
          : defaultEol
        const base = !agentsRead.content
          ? ''
          : (agentsRead.content.endsWith('\n') ? agentsRead.content : `${agentsRead.content}${agentsEol}`)
        const nextAgents = `${base}${CODEX_AGENTS_LINE}${agentsEol}`

        if (parsed.dryRun) {
          dryRunNotes.push(`${agentsPath} (would ${agentsRead.exists ? 'update' : 'create'})`)
          log(`  [dry-run] Would write ${agentsPath}`)
        } else {
          try {
            const target = await realpath(agentsPath).catch(() => agentsPath)
            if (agentsRead.exists) {
              await backupExistingFile(target, timestamp)
            }
            await writeFileAtomicPreservingMode(agentsPath, nextAgents, {
              defaultMode: 0o644,
              preserveMode: true,
              log,
            })
            written.push(agentsPath)
            log(`  Wrote ${agentsPath}`)
          } catch (err) {
            errLog(`  ! Failed to write ${agentsPath}: ${err?.message ?? err}`)
            return { exitCode: 1, written, dryRun: parsed.dryRun }
          }
        }
      } else {
        log(`  Skipped ${agentsPath}.`)
      }
      log('')
    }
  }

  // ── 6. Final message ──
  if (parsed.dryRun) {
    log(dryRunNotes.length > 0
      ? `  [dry-run] Would write: ${dryRunNotes.join(', ')}`
      : '  [dry-run] Nothing would be written.')
  } else if (written.length > 0) {
    log(`  Written: ${written.join(', ')}`)
  } else {
    log('  Nothing was written.')
  }
  log(`  ${FINAL_MESSAGE}\n`)

  return { exitCode: 0, written, dryRun: parsed.dryRun }
}
