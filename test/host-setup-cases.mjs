/**
 * Tests for `megalens-mcp setup claude-code`, `setup antigravity` (`setup agy`),
 * and `--remove-line` across all hosts.
 */
import { readFile, writeFile, appendFile, mkdir, rm, readdir, stat, lstat, readlink, chmod, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import {
  MEGALENS_REVIEW_LINE,
  DECISION_LINE,
  DECISION_LINE_V1,
  CLAUDE_MCP_URL,
  CLAUDE_DOCS_URL,
  ANTIGRAVITY_DOCS_URL,
  CLAUDE_FINAL_MESSAGE,
  ANTIGRAVITY_FINAL_MESSAGE,
  GEMINI_CLI_SHARED_NOTE,
  GEMINI_CLI_SHARED_NOTE_SINGLE,
  runSetupClaudeCode as rawRunSetupClaudeCode,
  runSetupAntigravity as rawRunSetupAntigravity,
} from '../bin/host-setup.mjs'
import { runSetupCodex as rawRunSetupCodex } from '../bin/codex-setup.mjs'

const okDefaultValidator = async () => ({ ok: true, isPro: false, isPayg: true, planCode: 'test', label: 'default' })
const runSetupClaudeCode = (args = [], io = {}) => rawRunSetupClaudeCode(args, { validateToken: okDefaultValidator, ...io })
const runSetupAntigravity = (args = [], io = {}) => rawRunSetupAntigravity(args, { validateToken: okDefaultValidator, ...io })
const runSetupCodex = (args = [], io = {}) => rawRunSetupCodex(args, { validateToken: okDefaultValidator, ...io })

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'cli.mjs')

const TOKEN_A = 'ml_tok_0123456789abcdef0123456789abcdef'
const TOKEN_B = 'ml_tok_fedcba9876543210fedcba9876543210'
const SECRET_PART_A = TOKEN_A.slice('ml_tok_'.length)
const SECRET_PART_B = TOKEN_B.slice('ml_tok_'.length)

const root = join(tmpdir(), `megalens-host-setup-${process.pid}`)
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })

const emptyBinDir = join(root, 'empty-bin')
await mkdir(emptyBinDir, { recursive: true })

const stubBinDir = join(root, 'stub-bin')
await mkdir(stubBinDir, { recursive: true })

const stubScript = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const logPath = process.env.STUB_LOG_PATH
const bin = process.env.STUB_BIN_NAME || process.argv[1].split('/').pop()
const argv = process.argv.slice(2)
const megalensEnvKeys = Object.keys(process.env).filter((k) => k.toUpperCase().startsWith('MEGALENS_'))
if (logPath) {
  appendFileSync(logPath, JSON.stringify({ bin, argv, megalensEnvKeys }) + '\\n', 'utf-8')
}
const sub = argv[0] === 'mcp' ? argv[1] : ''
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())
if (sub === 'get') {
  await sleep(Number(process.env.STUB_GET_SLEEP_MS ?? '0'))
  if (process.env.STUB_GET_STDERR) process.stderr.write(process.env.STUB_GET_STDERR)
  process.exit(Number(process.env.STUB_GET_EXIT ?? '1'))
}
if (sub === 'remove') {
  await sleep(Number(process.env.STUB_REMOVE_SLEEP_MS ?? '0'))
  if (process.env.STUB_REMOVE_STDERR) process.stderr.write(process.env.STUB_REMOVE_STDERR)
  process.exit(Number(process.env.STUB_REMOVE_EXIT ?? '0'))
}
if (sub === 'add') {
  await sleep(Number(process.env.STUB_ADD_SLEEP_MS ?? '0'))
  if (process.env.STUB_ADD_STDERR) process.stderr.write(process.env.STUB_ADD_STDERR)
  process.exit(Number(process.env.STUB_ADD_EXIT ?? '0'))
}
process.exit(0)
`

for (const name of ['claude', 'agy']) {
  const p = join(stubBinDir, name)
  await writeFile(p, stubScript, { mode: 0o755 })
  await chmod(p, 0o755)
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`pass  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        - ${detail}` : ''}`)
  }
}

function makeCaptureStream() {
  let buf = ''
  return {
    stream: {
      write(chunk) {
        buf += String(chunk)
        return true
      },
    },
    text: () => buf,
  }
}

function makePromptScript(answers, hiddenSecret = null) {
  const prompts = []
  let i = 0
  return {
    prompts,
    promptOverride: {
      async askHidden(prompt) {
        prompts.push({ type: 'hidden', prompt })
        if (hiddenSecret === null) throw new Error('unexpected hidden prompt')
        return hiddenSecret
      },
      async askPlain(prompt) {
        prompts.push({ type: 'plain', prompt })
        if (i >= answers.length) throw new Error(`ran out of answers at prompt: ${prompt}`)
        return answers[i++]
      },
    },
  }
}

let caseIdx = 0
async function newCaseEnv(stubName, extraEnv = {}) {
  const dir = join(root, `case-${++caseIdx}`)
  const home = join(dir, 'home')
  const stubLog = join(dir, 'stub.jsonl')
  await mkdir(home, { recursive: true })
  return {
    dir,
    home,
    stubLog,
    env: {
      HOME: home,
      PATH: stubBinDir,
      STUB_LOG_PATH: stubLog,
      STUB_BIN_NAME: stubName,
      ...extraEnv,
    },
  }
}

async function readStubCalls(stubLog) {
  try {
    const raw = await readFile(stubLog, 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

// ── 1. Claude Code: fresh home yes/yes (hidden token + direct 0600 ~/.claude.json + 0 child procs + CLAUDE.md) ─
{
  const { home, stubLog, env } = await newCaseEnv('claude')
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { prompts, promptOverride } = makePromptScript(['y', 'y'], TOKEN_A)

  const res = await runSetupClaudeCode([], {
    stdout: out.stream,
    stderr: err.stream,
    env,
    home,
    isTTY: true,
    promptOverride,
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  })

  const calls = await readStubCalls(stubLog)
  const claudeCfgPath = join(home, '.claude.json')
  const claudeCfg = JSON.parse(await readFile(claudeCfgPath, 'utf-8'))
  const claudeMdPath = join(home, '.claude', 'CLAUDE.md')
  const claudeMd = await readFile(claudeMdPath, 'utf-8').catch(() => '')

  check('claude-code yes/yes: exits 0, connects, writes ~/.claude.json and CLAUDE.md',
    res.exitCode === 0 && res.connected === true && res.written.includes(claudeCfgPath) && res.written.includes(claudeMdPath))
  check('claude-code yes/yes (Astra FINAL #2): writes ~/.claude.json directly at 0600 with 0 child-process invocations (no token in argv)',
    calls.length === 0 &&
    ((await stat(claudeCfgPath)).mode & 0o777) === 0o600 &&
    claudeCfg.mcpServers.megalens.type === 'http' &&
    claudeCfg.mcpServers.megalens.url === 'https://megalens.ai/api/mcp?ide=claude-code' &&
    claudeCfg.mcpServers.megalens.headers.Authorization === `Bearer ${TOKEN_A}`)
  check('claude-code yes/yes: CLAUDE.md created with both exact lines and mode 0644',
    claudeMd === `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n` &&
    ((await stat(claudeMdPath)).mode & 0o777) === 0o644)
  check('claude-code yes/yes: prompts show path, lines, masked preview; final message matches spec; no token leak',
    prompts.length === 3 &&
    out.text().includes(MEGALENS_REVIEW_LINE) &&
    out.text().includes(DECISION_LINE) &&
    prompts.some((p) => p.prompt.includes('Add these lines to')) &&
    out.text().includes('Bearer ml_tok_****') &&
    out.text().includes(CLAUDE_FINAL_MESSAGE) &&
    !out.text().includes(SECRET_PART_A) &&
    !err.text().includes(SECRET_PART_A))
}

// ── 2. Antigravity: fresh home yes/yes (MEGALENS_TOKEN + direct 0600 mcp_config.json + 0 child procs + GEMINI.md) ─
{
  const { home, stubLog, env } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { prompts, promptOverride } = makePromptScript(['y', 'y'])

  const res = await runSetupAntigravity([], {
    stdout: out.stream,
    stderr: err.stream,
    env,
    home,
    isTTY: true,
    promptOverride,
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  })

  const calls = await readStubCalls(stubLog)
  const agyCfgPath = join(home, '.gemini', 'config', 'mcp_config.json')
  const agyCfg = JSON.parse(await readFile(agyCfgPath, 'utf-8'))
  const geminiMdPath = join(home, '.gemini', 'GEMINI.md')
  const geminiMd = await readFile(geminiMdPath, 'utf-8').catch(() => '')

  check('antigravity yes/yes: exits 0, connects, writes mcp_config.json and GEMINI.md',
    res.exitCode === 0 && res.connected === true && res.written.includes(agyCfgPath) && res.written.includes(geminiMdPath))
  check('antigravity yes/yes (Astra FINAL #2): writes mcp_config.json directly at 0600 with 0 child-process invocations (no token in argv)',
    calls.length === 0 &&
    ((await stat(agyCfgPath)).mode & 0o777) === 0o600 &&
    agyCfg.mcpServers.megalens.disabled === false &&
    agyCfg.mcpServers.megalens.serverUrl === 'https://megalens.ai/api/mcp?ide=antigravity' &&
    agyCfg.mcpServers.megalens.headers.Authorization === `Bearer ${TOKEN_A}`)
  check('antigravity yes/yes: prompt includes Gemini CLI sentence and writes both lines to GEMINI.md',
    prompts.some((p) => p.prompt.includes(GEMINI_CLI_SHARED_NOTE) && p.prompt.includes('Add these lines to')) &&
    geminiMd === `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n` &&
    out.text().includes(ANTIGRAVITY_FINAL_MESSAGE) &&
    !out.text().includes(SECRET_PART_A) &&
    !err.text().includes(SECRET_PART_A))
}

// ── 3. no/no and default empty Enter (nothing written, nothing mutating run) ─
{
  // Antigravity: no/no runs 0 stub calls and creates no files
  const { home: ah, stubLog: al, env: ae } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  const ao = makeCaptureStream()
  const aer = makeCaptureStream()
  const ap = makePromptScript(['n', ''])
  const ares = await runSetupAntigravity([], {
    stdout: ao.stream,
    stderr: aer.stream,
    env: ae,
    home: ah,
    isTTY: true,
    promptOverride: ap.promptOverride,
  })
  const acalls = await readStubCalls(al)
  check('antigravity no/empty: exits 0, writes nothing, runs no stub, creates no .gemini dir',
    ares.exitCode === 0 &&
    ares.written.length === 0 &&
    !ares.connected &&
    acalls.length === 0 &&
    (await readdir(ah)).length === 0)

  // Claude Code: no/no never spawns claude and writes nothing
  const { home: ch, stubLog: cl, env: ce } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const co = makeCaptureStream()
  const cer = makeCaptureStream()
  const cp = makePromptScript(['', 'n'])
  const cres = await runSetupClaudeCode([], {
    stdout: co.stream,
    stderr: cer.stream,
    env: ce,
    home: ch,
    isTTY: true,
    promptOverride: cp.promptOverride,
  })
  const ccalls = await readStubCalls(cl)
  check('claude-code empty/no: exits 0, writes nothing, spawns 0 child processes',
    cres.exitCode === 0 &&
    cres.written.length === 0 &&
    !cres.connected &&
    ccalls.length === 0 &&
    (await readdir(ch)).length === 0)
}

// ── 4. Host CLI absent from PATH: direct private config write still works (no child process needed) ─
{
  for (const [label, fn, cfgRel, relMd] of [
    ['claude-code', runSetupClaudeCode, '.claude.json', join('.claude', 'CLAUDE.md')],
    ['antigravity', runSetupAntigravity, join('.gemini', 'config', 'mcp_config.json'), join('.gemini', 'GEMINI.md')],
  ]) {
    const { home, env } = await newCaseEnv(label, { PATH: emptyBinDir, MEGALENS_TOKEN: TOKEN_A })
    const o1 = makeCaptureStream()
    const e1 = makeCaptureStream()
    const p1 = makePromptScript(['n', 'n'])
    const r1 = await fn([], { stdout: o1.stream, stderr: e1.stream, env, home, isTTY: true, promptOverride: p1.promptOverride })
    check(`${label} without host CLI on PATH + n/n: exits 0, writes nothing`,
      r1.exitCode === 0 && r1.written.length === 0 && (await readdir(home)).length === 0)

    const { home: h2, env: env2 } = await newCaseEnv(label, { PATH: emptyBinDir, MEGALENS_TOKEN: TOKEN_A })
    const o2 = makeCaptureStream()
    const e2 = makeCaptureStream()
    const p2 = makePromptScript(['y', 'y'])
    const r2 = await fn([], { stdout: o2.stream, stderr: e2.stream, env: env2, home: h2, isTTY: true, promptOverride: p2.promptOverride })
    const md2 = await readFile(join(h2, relMd), 'utf-8').catch(() => '')
    const cfg2 = JSON.parse(await readFile(join(h2, cfgRel), 'utf-8'))
    check(`${label} without host CLI on PATH + y/y: writes private 0600 config and instruction lines directly`,
      r2.exitCode === 0 && r2.connected && cfg2.mcpServers.megalens.headers.Authorization === `Bearer ${TOKEN_A}` && md2 === `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n`)
  }
}

// ── 5. Read-only config file refused cleanly without touching it ──────────────
{
  for (const [label, fn, cfgRel] of [
    ['claude-code', runSetupClaudeCode, '.claude.json'],
    ['antigravity', runSetupAntigravity, join('.gemini', 'config', 'mcp_config.json')],
  ]) {
    const { home, env } = await newCaseEnv(label, { MEGALENS_TOKEN: TOKEN_A })
    const cfgPath = join(home, cfgRel)
    await mkdir(dirname(cfgPath), { recursive: true })
    await writeFile(cfgPath, '{"mcpServers":{}}\n', { mode: 0o444 })
    await chmod(cfgPath, 0o444)
    const out = makeCaptureStream()
    const err = makeCaptureStream()
    const { promptOverride } = makePromptScript(['n'])
    const res = await fn([], { stdout: out.stream, stderr: err.stream, env, home, isTTY: true, promptOverride })
    await chmod(cfgPath, 0o600)
    check(`${label} read-only config: skips write, leaves config intact, no token leak`,
      res.exitCode === 0 &&
      !res.connected &&
      (await readFile(cfgPath, 'utf-8')) === '{"mcpServers":{}}\n' &&
      out.text().includes('read-only') &&
      !out.text().includes(SECRET_PART_A) &&
      !err.text().includes(SECRET_PART_A))
  }
}

// ── 6. Existing server + update yes/no (preserves other servers, extra keys, and non-credential fields) ─
{
  // Claude Code: existing entry + update no -> untouched
  const { home: h1, stubLog: l1, env: e1 } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const c1Init = JSON.stringify({ theme: 'dark', mcpServers: { other: { url: 'https://other' }, megalens: { type: 'http', url: 'https://old', headers: { Authorization: `Bearer ${TOKEN_A}` } } } })
  await writeFile(join(h1, '.claude.json'), c1Init)
  const o1 = makeCaptureStream()
  const er1 = makeCaptureStream()
  const p1 = makePromptScript(['n', 'n'])
  const r1 = await runSetupClaudeCode([], { stdout: o1.stream, stderr: er1.stream, env: e1, home: h1, isTTY: true, promptOverride: p1.promptOverride })
  check('claude-code existing server + update n: untouched, 0 child calls, prompts for CLAUDE.md',
    r1.exitCode === 0 &&
    !r1.connected &&
    (await readStubCalls(l1)).length === 0 &&
    (await readFile(join(h1, '.claude.json'), 'utf-8')) === c1Init &&
    p1.prompts.length === 2)

  // Claude Code: existing SAME-ORIGIN entry + update y -> updates token+url, preserves other servers, disabled flag & custom headers, creates 0600 backup
  const { home: h2, stubLog: l2, env: e2 } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_B })
  await writeFile(join(h2, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { url: 'https://other' }, megalens: { disabled: true, type: 'http', url: 'https://megalens.ai/api/mcp', headers: { 'X-Custom': '1', authorization: `Bearer ${TOKEN_A}`, Authorization: `Bearer ${TOKEN_A}` } } } }))
  const o2 = makeCaptureStream()
  const er2 = makeCaptureStream()
  const p2 = makePromptScript(['y', 'n'])
  const r2 = await runSetupClaudeCode([], { stdout: o2.stream, stderr: er2.stream, env: e2, home: h2, isTTY: true, promptOverride: p2.promptOverride, now: () => new Date('2026-11-22T07:00:00.000Z') })
  const c2After = JSON.parse(await readFile(join(h2, '.claude.json'), 'utf-8'))
  const h2Files = await readdir(h2)
  check('claude-code existing same-origin server + update y: updates directly at 0600, preserves other servers, custom flags & same-origin headers, drops duplicate lowercase auth',
    r2.exitCode === 0 &&
    r2.connected === true &&
    (await readStubCalls(l2)).length === 0 &&
    c2After.theme === 'dark' &&
    c2After.mcpServers.other.url === 'https://other' &&
    c2After.mcpServers.megalens.disabled === true &&
    c2After.mcpServers.megalens.url === 'https://megalens.ai/api/mcp?ide=claude-code' &&
    c2After.mcpServers.megalens.headers['X-Custom'] === '1' &&
    c2After.mcpServers.megalens.headers.Authorization === `Bearer ${TOKEN_B}` &&
    !('authorization' in c2After.mcpServers.megalens.headers) &&
    h2Files.some((f) => f.startsWith('.claude.json.bak-')) &&
    !o2.text().includes(SECRET_PART_B))

  // Claude Code (Astra CONFIRM10 #12): changing origin from another host to MegaLens MUST NOT carry old headers (e.g. proxy API keys)
  const { home: h2x, env: e2x } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_B })
  await writeFile(join(h2x, '.claude.json'), JSON.stringify({
    mcpServers: {
      megalens: {
        disabled: true,
        type: 'http',
        url: 'https://proxy.example.com/mcp',
        serverUrl: 'https://proxy.example.com/mcp',
        headers: { 'X-Proxy-Api-Key': 'proxy-secret-999', Authorization: 'Bearer other-host-token' },
      },
    },
  }))
  const o2x = makeCaptureStream()
  const er2x = makeCaptureStream()
  const r2x = await runSetupClaudeCode([], { stdout: o2x.stream, stderr: er2x.stream, env: e2x, home: h2x, isTTY: true, promptOverride: makePromptScript(['y', 'n']).promptOverride })
  const c2xAfter = JSON.parse(await readFile(join(h2x, '.claude.json'), 'utf-8'))
  check('claude-code cross-origin update (Astra CONFIRM10 #12): drops old host headers and stale alternate URL fields while keeping disabled flag',
    r2x.exitCode === 0 &&
    r2x.connected === true &&
    c2xAfter.mcpServers.megalens.disabled === true &&
    c2xAfter.mcpServers.megalens.url === 'https://megalens.ai/api/mcp?ide=claude-code' &&
    !('serverUrl' in c2xAfter.mcpServers.megalens) &&
    c2xAfter.mcpServers.megalens.headers.Authorization === `Bearer ${TOKEN_B}` &&
    !('X-Proxy-Api-Key' in c2xAfter.mcpServers.megalens.headers))

  // Antigravity (Astra CONFIRM10 #12): changing serverUrl origin drops old host headers; same-origin preserves custom headers
  const { home: h4x, env: e4x } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_B })
  await mkdir(join(h4x, '.gemini', 'config'), { recursive: true })
  await writeFile(join(h4x, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      megalens: {
        disabled: true,
        serverUrl: 'https://other-gateway.example/mcp',
        headers: { 'X-Gateway-Key': 'gw-secret', Authorization: 'Bearer other' },
      },
    },
  }))
  const r4x = await runSetupAntigravity([], { stdout: makeCaptureStream().stream, stderr: makeCaptureStream().stream, env: e4x, home: h4x, isTTY: true, promptOverride: makePromptScript(['y', 'n']).promptOverride })
  const agy4xAfter = JSON.parse(await readFile(join(h4x, '.gemini', 'config', 'mcp_config.json'), 'utf-8'))
  check('antigravity cross-origin update (Astra CONFIRM10 #12): drops old host headers while keeping disabled flag',
    r4x.exitCode === 0 &&
    agy4xAfter.mcpServers.megalens.disabled === true &&
    agy4xAfter.mcpServers.megalens.serverUrl === 'https://megalens.ai/api/mcp?ide=antigravity' &&
    agy4xAfter.mcpServers.megalens.headers.Authorization === `Bearer ${TOKEN_B}` &&
    !('X-Gateway-Key' in agy4xAfter.mcpServers.megalens.headers))

  // Antigravity: existing entry in mcp_config.json + update no
  const { home: h3, stubLog: l3, env: e3 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  await mkdir(join(h3, '.gemini', 'config'), { recursive: true })
  const agy3Init = JSON.stringify({ mcpServers: { megalens: { serverUrl: 'old' } } })
  await writeFile(join(h3, '.gemini', 'config', 'mcp_config.json'), agy3Init)
  const o3 = makeCaptureStream()
  const er3 = makeCaptureStream()
  const p3 = makePromptScript(['n', 'n'])
  const r3 = await runSetupAntigravity([], { stdout: o3.stream, stderr: er3.stream, env: e3, home: h3, isTTY: true, promptOverride: p3.promptOverride })
  check('antigravity existing server + update n: runs 0 stub calls and leaves mcp_config.json intact',
    r3.exitCode === 0 && !r3.connected && (await readStubCalls(l3)).length === 0 && (await readFile(join(h3, '.gemini', 'config', 'mcp_config.json'), 'utf-8')) === agy3Init && p3.prompts.length === 2)

  // Antigravity: existing entry in mcp_config.json + update yes (preserves disabled: true & other servers)
  const { home: h4, stubLog: l4, env: e4 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_B })
  await mkdir(join(h4, '.gemini', 'config'), { recursive: true })
  await writeFile(join(h4, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { other: { serverUrl: 'https://other' }, megalens: { disabled: true, serverUrl: 'old' } } }))
  const o4 = makeCaptureStream()
  const er4 = makeCaptureStream()
  const p4 = makePromptScript(['y', 'n'])
  const r4 = await runSetupAntigravity([], { stdout: o4.stream, stderr: er4.stream, env: e4, home: h4, isTTY: true, promptOverride: p4.promptOverride })
  const agy4After = JSON.parse(await readFile(join(h4, '.gemini', 'config', 'mcp_config.json'), 'utf-8'))
  check('antigravity existing server + update y: writes directly at 0600, preserves disabled & other servers, 0 child calls',
    r4.exitCode === 0 &&
    r4.connected === true &&
    (await readStubCalls(l4)).length === 0 &&
    agy4After.mcpServers.other.serverUrl === 'https://other' &&
    agy4After.mcpServers.megalens.disabled === true &&
    agy4After.mcpServers.megalens.serverUrl === 'https://megalens.ai/api/mcp?ide=antigravity' &&
    agy4After.mcpServers.megalens.headers.Authorization === `Bearer ${TOKEN_B}` &&
    !o4.text().includes(SECRET_PART_B))
}

// ── 7. Antigravity invalid mcp_config.json (nothing touched) ──────────────────
{
  for (const [label, content] of [
    ['broken JSON', '{ "mcpServers": { "megalens": '],
    ['JSON array', '[]'],
    ['non-UTF8', Buffer.from([0x7b, 0xe9, 0x7d])],
  ]) {
    const { home, stubLog, env } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
    const cfgDir = join(home, '.gemini', 'config')
    const cfgPath = join(cfgDir, 'mcp_config.json')
    await mkdir(cfgDir, { recursive: true })
    await writeFile(cfgPath, content)
    const out = makeCaptureStream()
    const err = makeCaptureStream()
    const { prompts, promptOverride } = makePromptScript(['y', 'y'])
    const res = await runSetupAntigravity([], {
      stdout: out.stream,
      stderr: err.stream,
      env,
      home,
      isTTY: true,
      promptOverride,
    })
    const calls = await readStubCalls(stubLog)
    const after = await readFile(cfgPath)
    const geminiFiles = await readdir(join(home, '.gemini'))
    check(`antigravity invalid mcp_config.json (${label}): exits 1, touches nothing, runs no stub`,
      res.exitCode === 1 &&
      res.written.length === 0 &&
      prompts.length === 0 &&
      calls.length === 0 &&
      after.equals(Buffer.isBuffer(content) ? content : Buffer.from(content)) &&
      !geminiFiles.includes('GEMINI.md') &&
      err.text().includes('Not touching anything'))
  }
}

// ── 8. Existing lines (no duplicate), backup + mode preserved, CRLF preserved, symlink preserved ─
{
  // Both lines already present -> no prompt, no duplicate, no backup
  const { home, env } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const claudeDir = join(home, '.claude')
  await mkdir(claudeDir, { recursive: true })
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')
  const existing = `# My Rules\n${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n`
  await writeFile(claudeMdPath, existing)
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { prompts, promptOverride } = makePromptScript(['n'])
  const res = await runSetupClaudeCode([], { stdout: out.stream, stderr: err.stream, env, home, isTTY: true, promptOverride })
  const files = await readdir(claudeDir)
  check('existing MegaLens lines: skipped with no duplicate and no backup',
    res.exitCode === 0 &&
    prompts.length === 1 &&
    out.text().includes('already has the MegaLens lines. Leaving it unchanged.') &&
    (await readFile(claudeMdPath, 'utf-8')) === existing &&
    !files.some((f) => f.includes('.bak-')))

  // CRLF + mode 0640 + backup + symlink preserved
  const { dir, home: h2, env: e2 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  const gemDir = join(h2, '.gemini')
  await mkdir(gemDir, { recursive: true })
  const realTarget = join(dir, 'dotfiles-GEMINI.md')
  const crlfInit = '# Header\r\nRule 1\r\n'
  await writeFile(realTarget, crlfInit, { mode: 0o640 })
  await chmod(realTarget, 0o640)
  const linkPath = join(gemDir, 'GEMINI.md')
  await symlink(realTarget, linkPath)

  const o2 = makeCaptureStream()
  const er2 = makeCaptureStream()
  const p2 = makePromptScript(['n', 'y'])
  const r2 = await runSetupAntigravity([], {
    stdout: o2.stream,
    stderr: er2.stream,
    env: e2,
    home: h2,
    isTTY: true,
    promptOverride: p2.promptOverride,
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  })
  const afterBuf = await readFile(realTarget)
  const afterStr = afterBuf.toString('utf-8')
  const dirFiles = await readdir(dir)
  const st = await stat(realTarget)
  const lstatLink = await stat(linkPath)
  check('CRLF + mode 0640 + backup + symlink preserved on GEMINI.md',
    r2.exitCode === 0 &&
    afterStr === `# Header\r\nRule 1\r\n${MEGALENS_REVIEW_LINE}\r\n${DECISION_LINE}\r\n` &&
    (st.mode & 0o777) === 0o640 &&
    lstatLink.ino === st.ino &&
    dirFiles.some((f) => f.startsWith('dotfiles-GEMINI.md.bak-')))
}

// ── 9. Non-UTF8 instruction file refused ──────────────────────────────────────
{
  const { home, env } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const claudeDir = join(home, '.claude')
  await mkdir(claudeDir, { recursive: true })
  const mdPath = join(claudeDir, 'CLAUDE.md')
  const latin1 = Buffer.from('# Caf\xe9\n', 'latin1')
  await writeFile(mdPath, latin1)
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { prompts, promptOverride } = makePromptScript(['n'])
  const res = await runSetupClaudeCode([], { stdout: out.stream, stderr: err.stream, env, home, isTTY: true, promptOverride })
  check('non-UTF8 CLAUDE.md refused and left byte-for-byte untouched',
    res.exitCode === 0 &&
    prompts.length === 1 &&
    (await readFile(mdPath)).equals(latin1) &&
    err.text().includes('Leaving CLAUDE.md untouched'))
}

// ── 10. --dry-run and no-TTY write nothing and run no stub ────────────────────
{
  for (const [label, fn, subcmd] of [
    ['claude-code', runSetupClaudeCode, 'claude-code'],
    ['antigravity', runSetupAntigravity, 'antigravity'],
    ['agy', runSetupAntigravity, 'agy'],
  ]) {
    // --dry-run with TTY
    const { home, stubLog, env } = await newCaseEnv(label === 'claude-code' ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const out = makeCaptureStream()
    const err = makeCaptureStream()
    const { promptOverride } = makePromptScript(['y', 'y'])
    const res = await fn(['--dry-run'], { stdout: out.stream, stderr: err.stream, env, home, isTTY: true, promptOverride })
    const calls = await readStubCalls(stubLog)
    check(`${label} --dry-run: exits 0, writes nothing, runs 0 stub calls`,
      res.exitCode === 0 &&
      res.dryRun === true &&
      res.written.length === 0 &&
      !res.connected &&
      calls.length === 0 &&
      (await readdir(home)).length === 0 &&
      out.text().includes('[dry-run]'))

    // no-TTY via spawned CLI
    const { home: h2, stubLog: l2, env: e2 } = await newCaseEnv(label === 'claude-code' ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const cliRun = spawnSync(process.execPath, [CLI, 'setup', subcmd], {
      env: e2,
      input: 'y\ny\n',
      encoding: 'utf-8',
    })
    const calls2 = await readStubCalls(l2)
    check(`${label} no-TTY CLI child: exits 0, writes nothing, runs no stub, masks token`,
      cliRun.status === 0 &&
      calls2.length === 0 &&
      (await readdir(h2)).length === 0 &&
      cliRun.stdout.includes('Add these lines to') &&
      cliRun.stdout.includes(MEGALENS_REVIEW_LINE) &&
      cliRun.stdout.includes(DECISION_LINE) &&
      !cliRun.stdout.includes(SECRET_PART_A) &&
      !cliRun.stderr.includes(SECRET_PART_A))
  }
}

// ── 11. Hidden input, type-ahead safety, Ctrl-C (130), invalid token, --yes ──
{
  // Invalid token rejected without echoing token
  const { home, stubLog, env } = await newCaseEnv('claude', { MEGALENS_TOKEN: 'ml_tok_notvalidsecret' })
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript([])
  const res = await runSetupClaudeCode([], { stdout: out.stream, stderr: err.stream, env, home, isTTY: true, promptOverride })
  check('invalid token exits 1, runs no stub, never echoes bad token',
    res.exitCode === 1 &&
    (await readStubCalls(stubLog)).length === 0 &&
    !err.text().includes('notvalidsecret') &&
    !out.text().includes('notvalidsecret'))

  // --yes rejected
  const { home: hy, env: ey } = await newCaseEnv('agy')
  const oy = makeCaptureStream()
  const ery = makeCaptureStream()
  const ry = await runSetupAntigravity(['--yes'], { stdout: oy.stream, stderr: ery.stream, env: ey, home: hy, isTTY: true })
  check('--yes rejected with exit 1', ry.exitCode === 1 && ery.text().includes('--yes is not supported'))

  // Type-ahead discarded before y/N prompt
  const { home: ht, stubLog: lt, env: et } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  const pt = new PassThrough()
  pt.isTTY = true
  pt.setRawMode = () => {}
  pt.write('y\r')
  let buf = ''
  let n1 = false
  let n2 = false
  const outStream = {
    write(chunk) {
      buf += String(chunk)
      if (!n1 && buf.includes('Add MegaLens to Antigravity? (y/N):')) {
        n1 = true
        setImmediate(() => pt.write('n\r'))
      }
      if (!n2 && buf.includes('so Antigravity offers a MegaLens review at the right moments?')) {
        n2 = true
        setImmediate(() => pt.write('n\r'))
      }
      return true
    },
  }
  const rt = await runSetupAntigravity([], {
    stdin: pt,
    stdout: outStream,
    stderr: makeCaptureStream().stream,
    env: et,
    home: ht,
    isTTY: true,
  })
  check('type-ahead y\\r discarded -> nothing written and no stub called',
    rt.exitCode === 0 &&
    rt.written.length === 0 &&
    (await readStubCalls(lt)).length === 0 &&
    (await readdir(ht)).length === 0)

  // Ctrl-C aborts with exit 130
  const { home: hc, stubLog: lc, env: ec } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const ptc = new PassThrough()
  ptc.isTTY = true
  ptc.setRawMode = () => {}
  let bufc = ''
  let sent = false
  const outc = {
    write(chunk) {
      bufc += String(chunk)
      if (!sent && bufc.includes('Add MegaLens to Claude Code? (y/N):')) {
        sent = true
        setImmediate(() => ptc.write('\x03'))
      }
      return true
    },
  }
  const rc = await runSetupClaudeCode([], {
    stdin: ptc,
    stdout: outc,
    stderr: makeCaptureStream().stream,
    env: ec,
    home: hc,
    isTTY: true,
  })
  check('Ctrl-C at Consent 1 exits 130 with 0 child calls and no CLAUDE.md prompt',
    rc.exitCode === 130 &&
    !bufc.includes('CLAUDE.md') &&
    (await readStubCalls(lc)).length === 0)
}

// ── 12. --remove-line across claude-code, antigravity, and codex ──────────────
{
  // Claude Code --remove-line: removes both exact lines in 1 prompt, keeps surrounding & custom/variant lines, preserves CRLF & mode 0640, creates backup
  const { home, stubLog, env } = await newCaseEnv('claude')
  const claudeDir = join(home, '.claude')
  await mkdir(claudeDir, { recursive: true })
  const mdPath = join(claudeDir, 'CLAUDE.md')
  const initial = `# Top\r\n# Custom: offer a MegaLens review manually\r\nPlease Offer a MegaLens review before merge.\r\nAfter you change code in billing, offer a MegaLens review.\r\n${MEGALENS_REVIEW_LINE}\r\n${DECISION_LINE}\r\n# Bottom\r\n`
  await writeFile(mdPath, initial, { mode: 0o640 })
  await chmod(mdPath, 0o640)

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { prompts, promptOverride } = makePromptScript(['y'])
  const res = await runSetupClaudeCode(['--remove-line'], {
    stdout: out.stream,
    stderr: err.stream,
    env,
    home,
    isTTY: true,
    promptOverride,
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  })
  const after = await readFile(mdPath, 'utf-8')
  const files = await readdir(claudeDir)
  check('claude-code --remove-line: removes both exact lines in 1 prompt, preserves CRLF/mode/custom/variant lines, backs up, calls no stub',
    res.exitCode === 0 &&
    prompts.length === 1 &&
    out.text().includes(`- ${MEGALENS_REVIEW_LINE}`) &&
    out.text().includes(`- ${DECISION_LINE}`) &&
    after === '# Top\r\n# Custom: offer a MegaLens review manually\r\nPlease Offer a MegaLens review before merge.\r\nAfter you change code in billing, offer a MegaLens review.\r\n# Bottom\r\n' &&
    ((await stat(mdPath)).mode & 0o777) === 0o640 &&
    files.some((f) => f.startsWith('CLAUDE.md.bak-')) &&
    (await readStubCalls(stubLog)).length === 0)

  // Antigravity --remove-line with default No -> untouched
  const { home: ah, env: ae } = await newCaseEnv('agy')
  const gemDir = join(ah, '.gemini')
  await mkdir(gemDir, { recursive: true })
  const gPath = join(gemDir, 'GEMINI.md')
  const gInit = `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n# Keep\n`
  await writeFile(gPath, gInit)
  const ao = makeCaptureStream()
  const ap = makePromptScript([''])
  const ares = await runSetupAntigravity(['--remove-line'], { stdout: ao.stream, stderr: makeCaptureStream().stream, env: ae, home: ah, isTTY: true, promptOverride: ap.promptOverride })
  check('antigravity --remove-line with empty answer (default No): leaves GEMINI.md untouched',
    ares.exitCode === 0 && (await readFile(gPath, 'utf-8')) === gInit && !(await readdir(gemDir)).some((f) => f.includes('.bak-')))

  // Antigravity --remove-line with y -> removes both exact lines in 1 prompt and creates backup
  const ao2 = makeCaptureStream()
  const ap2 = makePromptScript(['y'])
  const ares2 = await runSetupAntigravity(['--remove-line'], { stdout: ao2.stream, stderr: makeCaptureStream().stream, env: ae, home: ah, isTTY: true, promptOverride: ap2.promptOverride })
  check('antigravity --remove-line with y: removes both exact lines and keeps rest',
    ares2.exitCode === 0 &&
    ap2.prompts.length === 1 &&
    (await readFile(gPath, 'utf-8')) === '# Keep\n' &&
    (await readdir(gemDir)).some((f) => f.startsWith('GEMINI.md.bak-')))

  // Codex --remove-line: removes both exact lines from AGENTS.md without touching config.toml
  const { home: ch, env: ce } = await newCaseEnv('codex')
  const codexDir = join(ch, '.codex')
  await mkdir(codexDir, { recursive: true })
  const agentsPath = join(codexDir, 'AGENTS.md')
  const cfgPath = join(codexDir, 'config.toml')
  await writeFile(cfgPath, 'model = "o3"\n')
  await writeFile(agentsPath, `# Codex\n${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n# Other rule\n`)
  const co = makeCaptureStream()
  const cp = makePromptScript(['y'])
  const cres = await runSetupCodex(['--remove-line'], {
    stdout: co.stream,
    stderr: makeCaptureStream().stream,
    env: ce,
    home: ch,
    isTTY: true,
    promptOverride: cp.promptOverride,
  })
  check('codex --remove-line: removes both exact lines from AGENTS.md and leaves other lines & config.toml untouched',
    cres.exitCode === 0 &&
    cp.prompts.length === 1 &&
    (await readFile(agentsPath, 'utf-8')) === '# Codex\n# Other rule\n' &&
    (await readFile(cfgPath, 'utf-8')) === 'model = "o3"\n')

  // Codex --remove-line + --replace-token rejected
  const cerr = makeCaptureStream()
  const badRes = await runSetupCodex(['--remove-line', '--replace-token'], {
    stdout: makeCaptureStream().stream,
    stderr: cerr.stream,
    env: ce,
    home: ch,
    isTTY: true,
  })
  check('codex --remove-line + --replace-token rejected with exit 1', badRes.exitCode === 1)
}

// ── 13. cli.mjs help & dispatch checks ────────────────────────────────────────
{
  const helpRun = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf-8' })
  check('cli.mjs help lists setup claude-code, setup antigravity, setup agy without em dash',
    helpRun.status === 0 &&
    helpRun.stdout.includes('setup claude-code') &&
    helpRun.stdout.includes('setup antigravity') &&
    helpRun.stdout.includes('setup agy') &&
    !/[—–]/.test(helpRun.stdout))

  const badTarget = spawnSync(process.execPath, [CLI, 'setup', 'unknown-host'], { encoding: 'utf-8' })
  check('cli.mjs setup unknown-host exits 1 and prints valid targets',
    badTarget.status === 1 &&
    badTarget.stderr.includes('codex') &&
    badTarget.stderr.includes('claude-code') &&
    badTarget.stderr.includes('antigravity') &&
    badTarget.stderr.includes('agy'))

  const dryGeneric = spawnSync(process.execPath, [CLI, 'setup', '--dry-run'], { encoding: 'utf-8' })
  check('cli.mjs setup --dry-run (no target) refuses conservatively, exits 1, and prints valid targets',
    dryGeneric.status === 1 &&
    dryGeneric.stderr.includes('does not support --dry-run') &&
    dryGeneric.stderr.includes('codex') &&
    dryGeneric.stderr.includes('claude-code') &&
    dryGeneric.stderr.includes('antigravity') &&
    dryGeneric.stderr.includes('agy'))
}

// ── 14. P1-1: positional token and --token=<token> never echoed in error paths ─
{
  for (const [host, fn] of [
    ['codex', runSetupCodex],
    ['claude-code', runSetupClaudeCode],
    ['antigravity', runSetupAntigravity],
  ]) {
    for (const [kind, args] of [
      ['positional token', [TOKEN_A]],
      ['--token=<token>', [`--token=${TOKEN_A}`]],
    ]) {
      const { home, env } = await newCaseEnv(host)
      const out = makeCaptureStream()
      const err = makeCaptureStream()
      const res = await fn(args, { stdout: out.stream, stderr: err.stream, env, home, isTTY: true })
      const cliRun = spawnSync(process.execPath, [CLI, 'setup', host, ...args], { env, encoding: 'utf-8' })
      check(`P1-1 ${host} ${kind}: exits non-zero and never echoes token`,
        res.exitCode !== 0 &&
        !out.text().includes(TOKEN_A) &&
        !out.text().includes(SECRET_PART_A) &&
        !err.text().includes(TOKEN_A) &&
        !err.text().includes(SECRET_PART_A) &&
        cliRun.status !== 0 &&
        !cliRun.stdout.includes(TOKEN_A) &&
        !cliRun.stdout.includes(SECRET_PART_A) &&
        !cliRun.stderr.includes(TOKEN_A) &&
        !cliRun.stderr.includes(SECRET_PART_A))
    }
  }

  const badTargetTok = spawnSync(process.execPath, [CLI, 'setup', TOKEN_A], { encoding: 'utf-8' })
  check('P1-1 setup <token> via cli.mjs exits 1 and never echoes token',
    badTargetTok.status === 1 &&
    !badTargetTok.stdout.includes(SECRET_PART_A) &&
    !badTargetTok.stderr.includes(SECRET_PART_A))
}

// ── 15 & 16. Astra FINAL #2, #3, #9: no child-process bearer, git-safe backup, default-label required ─
{
  // #9: setup claude-code and setup antigravity refuse github-action, missing label, invalid, and network errors
  for (const [hostLabel, fn, cfgRel] of [
    ['claude-code', runSetupClaudeCode, '.claude.json'],
    ['antigravity', runSetupAntigravity, join('.gemini', 'config', 'mcp_config.json')],
  ]) {
    for (const [reasonLabel, validator] of [
      ['github-action token', async () => ({ ok: false, reason: 'wrong_label', label: 'github-action' })],
      ['unlabeled token', async () => ({ ok: false, reason: 'wrong_label', label: null })],
      ['invalid token', async () => ({ ok: false, reason: 'invalid', error: 'revoked' })],
      ['network error', async () => ({ ok: false, reason: 'network', error: 'offline' })],
    ]) {
      const { home, stubLog, env } = await newCaseEnv(hostLabel === 'claude-code' ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
      const out = makeCaptureStream()
      const err = makeCaptureStream()
      const res = await fn([], {
        stdout: out.stream,
        stderr: err.stream,
        env,
        home,
        isTTY: true,
        validateToken: validator,
        promptOverride: makePromptScript([]).promptOverride,
      })
      const cfgExists = await stat(join(home, cfgRel)).then(() => true, () => false)
      check(`Astra FINAL #9 (${hostLabel}): refuses ${reasonLabel}, writes nothing, 0 child calls`,
        res.exitCode === 1 && !res.connected && !cfgExists && (await readStubCalls(stubLog)).length === 0)
    }
  }

  // #3: git-ignored Antigravity config inside a dotfiles repo stores backup outside the worktree
  const { home: hDot, env: eDot } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_B })
  const dots = join(hDot, 'dotfiles')
  const stateDir = join(hDot, 'ext-state')
  await mkdir(join(dots, '.gemini', 'config'), { recursive: true })
  spawnSync('git', ['init', '-q', dots])
  await writeFile(join(dots, '.gitignore'), '.gemini/config/mcp_config.json\n')
  const prior = JSON.stringify({ mcpServers: { other: { headers: { Authorization: 'Bearer sk-other' } } } })
  await writeFile(join(dots, '.gemini', 'config', 'mcp_config.json'), prior)
  await symlink(join(dots, '.gemini'), join(hDot, '.gemini'))
  const oDot = makeCaptureStream()
  const erDot = makeCaptureStream()
  const rDot = await runSetupAntigravity([], {
    stdout: oDot.stream,
    stderr: erDot.stream,
    env: { ...eDot, PATH: process.env.PATH ?? '', XDG_STATE_HOME: stateDir },
    home: hDot,
    isTTY: true,
    promptOverride: makePromptScript(['y', 'n']).promptOverride,
    now: () => new Date('2026-11-22T07:10:00.000Z'),
  })
  const dotFiles = await readdir(join(dots, '.gemini', 'config'))
  const gitSt = spawnSync('git', ['-C', dots, 'status', '--porcelain'], { encoding: 'utf-8' }).stdout
  const extBaks = await readdir(join(stateDir, 'megalens', 'backups')).catch(() => [])
  check('Astra FINAL #3 (antigravity): backup of git-ignored config stays outside dotfiles repo',
    rDot.exitCode === 0 &&
    rDot.connected === true &&
    !dotFiles.some((f) => f.includes('.bak-')) &&
    !gitSt.includes('.bak-') &&
    extBaks.some((f) => f.startsWith('mcp_config.json.') && f.includes('.bak-')))
}

// ── 17. P2-4 & P3: agy unrecognised top-level key ("unknown") & UTF-8 BOM ─────
{
  // Unrecognised top-level key -> treated as unknown, says so, no blind replace
  const { home: h1, stubLog: l1, env: e1 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  await mkdir(join(h1, '.gemini', 'config'), { recursive: true })
  await writeFile(join(h1, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ customServers: { megalens: { url: 'old' } } }))
  const o1 = makeCaptureStream()
  const er1 = makeCaptureStream()
  const p1 = makePromptScript(['n', 'n'])
  const r1 = await runSetupAntigravity([], { stdout: o1.stream, stderr: er1.stream, env: e1, home: h1, isTTY: true, promptOverride: p1.promptOverride })
  const calls1 = await readStubCalls(l1)
  check('P2-4 agy unrecognised top-level key: treats entry as unknown, says so, no blind replace',
    r1.exitCode === 0 &&
    !r1.connected &&
    o1.text().toLowerCase().includes('unknown') &&
    p1.prompts.some((p) => p.prompt.includes('Add MegaLens to Antigravity? (y/N):')) &&
    !p1.prompts.some((p) => p.prompt.includes('Update MegaLens')) &&
    calls1.length === 0)

  // UTF-8 BOM in mcp_config.json -> stripped before JSON.parse and existing entry detected
  const { home: h2, stubLog: l2, env: e2 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  await mkdir(join(h2, '.gemini', 'config'), { recursive: true })
  await writeFile(join(h2, '.gemini', 'config', 'mcp_config.json'), `\uFEFF${JSON.stringify({ mcpServers: { megalens: { serverUrl: 'old' } } })}`, 'utf-8')
  const o2 = makeCaptureStream()
  const er2 = makeCaptureStream()
  const p2 = makePromptScript(['n', 'n'])
  const r2 = await runSetupAntigravity([], { stdout: o2.stream, stderr: er2.stream, env: e2, home: h2, isTTY: true, promptOverride: p2.promptOverride })
  check('P3 agy UTF-8 BOM in mcp_config.json: parsed cleanly and existing megalens entry detected',
    r2.exitCode === 0 &&
    (await readStubCalls(l2)).length === 0 &&
    p2.prompts.some((p) => p.prompt.includes('Update MegaLens MCP server in Antigravity? (y/N):')))
}

// ── 18. P3: dry-run previews, --remove-line --dry-run, dangling symlink ───────
{
  // setup claude-code --dry-run previews config path without modifying files or spawning child processes
  const { home: h1, stubLog: l1, env: e1 } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const o1 = makeCaptureStream()
  const er1 = makeCaptureStream()
  const p1 = makePromptScript(['y', 'n'])
  const r1 = await runSetupClaudeCode(['--dry-run'], { stdout: o1.stream, stderr: er1.stream, env: e1, home: h1, isTTY: true, promptOverride: p1.promptOverride })
  check('P3 setup claude-code --dry-run preview shows [dry-run] Would write ~/.claude.json without modifying anything',
    r1.exitCode === 0 &&
    r1.dryRun === true &&
    (await readStubCalls(l1)).length === 0 &&
    o1.text().includes(`[dry-run] Would write ${join(h1, '.claude.json')}`) &&
    !o1.text().includes(SECRET_PART_A))

  // update + --dry-run (antigravity)
  const { home: h2, stubLog: l2, env: e2 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_B })
  await mkdir(join(h2, '.gemini', 'config'), { recursive: true })
  const cfgPath2 = join(h2, '.gemini', 'config', 'mcp_config.json')
  const cfgContent2 = JSON.stringify({ mcpServers: { megalens: { serverUrl: 'old' } } })
  await writeFile(cfgPath2, cfgContent2)
  const o2 = makeCaptureStream()
  const er2 = makeCaptureStream()
  const p2 = makePromptScript(['y', 'n'])
  const r2 = await runSetupAntigravity(['--dry-run'], { stdout: o2.stream, stderr: er2.stream, env: e2, home: h2, isTTY: true, promptOverride: p2.promptOverride })
  check('P3 update + --dry-run: exits 0, runs 0 stub calls, previews masked write without touching file',
    r2.exitCode === 0 &&
    r2.dryRun === true &&
    !r2.connected &&
    (await readStubCalls(l2)).length === 0 &&
    (await readFile(cfgPath2, 'utf-8')) === cfgContent2 &&
    o2.text().includes(`[dry-run] Would write ${cfgPath2}`) &&
    !o2.text().includes(SECRET_PART_B))

  // --remove-line --dry-run (claude-code)
  const { home: h3, env: e3 } = await newCaseEnv('claude')
  const cDir3 = join(h3, '.claude')
  await mkdir(cDir3, { recursive: true })
  const mdPath3 = join(cDir3, 'CLAUDE.md')
  const mdInit3 = `# Header\n${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n`
  await writeFile(mdPath3, mdInit3)
  const o3 = makeCaptureStream()
  const er3 = makeCaptureStream()
  const p3 = makePromptScript(['y'])
  const r3 = await runSetupClaudeCode(['--remove-line', '--dry-run'], { stdout: o3.stream, stderr: er3.stream, env: e3, home: h3, isTTY: true, promptOverride: p3.promptOverride })
  check('P3 --remove-line --dry-run: exits 0, leaves file unchanged, creates no backup',
    r3.exitCode === 0 &&
    r3.dryRun === true &&
    r3.written.length === 0 &&
    (await readFile(mdPath3, 'utf-8')) === mdInit3 &&
    !(await readdir(cDir3)).some((f) => f.includes('.bak-')) &&
    o3.text().includes(`[dry-run] Would write ${mdPath3}`))

  // Dangling symlink at CLAUDE.md and AGENTS.md: must not write through or replace symlink
  const { dir: d4, home: h4, env: e4 } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const cDir4 = join(h4, '.claude')
  await mkdir(cDir4, { recursive: true })
  const claudeLink4 = join(cDir4, 'CLAUDE.md')
  const missingTarget4 = join(d4, 'nonexistent-CLAUDE.md')
  await symlink(missingTarget4, claudeLink4)
  const o4 = makeCaptureStream()
  const er4 = makeCaptureStream()
  const p4 = makePromptScript(['n'])
  const r4 = await runSetupClaudeCode([], { stdout: o4.stream, stderr: er4.stream, env: e4, home: h4, isTTY: true, promptOverride: p4.promptOverride })
  const claudeLst4 = await lstat(claudeLink4)
  let targetExists4 = true
  try { await stat(missingTarget4) } catch { targetExists4 = false }
  check('P3 dangling symlink at CLAUDE.md: must not write through it or replace link',
    r4.exitCode === 0 &&
    !r4.written.includes(claudeLink4) &&
    p4.prompts.length === 1 &&
    claudeLst4.isSymbolicLink() &&
    (await readlink(claudeLink4)) === missingTarget4 &&
    !targetExists4 &&
    er4.text().includes('Leaving CLAUDE.md untouched'))

  // Same handling for codex AGENTS.md dangling symlink
  const { dir: d5, home: h5 } = await newCaseEnv('codex')
  const codexDir5 = join(h5, '.codex')
  await mkdir(codexDir5, { recursive: true })
  const agentsLink5 = join(codexDir5, 'AGENTS.md')
  const missingTarget5 = join(d5, 'nonexistent-AGENTS.md')
  await symlink(missingTarget5, agentsLink5)
  const o5 = makeCaptureStream()
  const er5 = makeCaptureStream()
  const p5 = makePromptScript(['n'])
  const r5 = await runSetupCodex([], { stdout: o5.stream, stderr: er5.stream, env: { MEGALENS_TOKEN: TOKEN_A }, home: h5, isTTY: true, promptOverride: p5.promptOverride })
  const agentsLst5 = await lstat(agentsLink5)
  let targetExists5 = true
  try { await stat(missingTarget5) } catch { targetExists5 = false }
  check('P3 dangling symlink at codex AGENTS.md: matching handling (untouched, not written through)',
    r5.exitCode === 0 &&
    !r5.written.includes(agentsLink5) &&
    p5.prompts.length === 1 &&
    agentsLst5.isSymbolicLink() &&
    (await readlink(agentsLink5)) === missingTarget5 &&
    !targetExists5 &&
    er5.text().includes('Leaving AGENTS.md untouched'))
}

// ── 19. Round 2 fixes: P1-2, P2-1, P2-2, P2-3, P2-4, P2-5 ────────────────────
{
  // P1-2: token as top-level command is masked
  const topTok = spawnSync(process.execPath, [CLI, TOKEN_A], { encoding: 'utf-8' })
  check('P1-2 node cli.mjs <token>: exits non-zero, token absent from stdout/stderr, ml_tok_**** allowed',
    topTok.status !== 0 &&
    !topTok.stdout.includes(TOKEN_A) &&
    !topTok.stdout.includes(SECRET_PART_A) &&
    !topTok.stderr.includes(TOKEN_A) &&
    !topTok.stderr.includes(SECRET_PART_A) &&
    topTok.stderr.includes('ml_tok_****'))

  // P2-2: token prompt runs BEFORE reading .claude.json and BEFORE reading agy config
  const { home: hOrd, env: eOrd } = await newCaseEnv('claude')
  await writeFile(join(hOrd, '.claude.json'), '{ invalid json')
  let claudeAskedHidden = false
  const rOrd = await runSetupClaudeCode([], {
    stdout: makeCaptureStream().stream,
    stderr: makeCaptureStream().stream,
    env: eOrd,
    home: hOrd,
    isTTY: true,
    promptOverride: {
      async askHidden() {
        claudeAskedHidden = true
        return TOKEN_A
      },
      async askPlain() {
        throw new Error('unexpected plain prompt')
      },
    },
  })
  check('P2-2 (claude-code) token prompt runs BEFORE reading .claude.json',
    rOrd.exitCode === 1 && claudeAskedHidden === true)

  // P2-2 (agy): token prompt runs BEFORE reading agy mcp_config.json
  const { home: hOrdAgy, env: eOrdAgy } = await newCaseEnv('agy')
  await mkdir(join(hOrdAgy, '.gemini', 'config'), { recursive: true })
  await writeFile(join(hOrdAgy, '.gemini', 'config', 'mcp_config.json'), '{ invalid json')
  let agyAskedHidden = false
  const rOrdAgy = await runSetupAntigravity([], {
    stdout: makeCaptureStream().stream,
    stderr: makeCaptureStream().stream,
    env: eOrdAgy,
    home: hOrdAgy,
    isTTY: true,
    promptOverride: {
      async askHidden() {
        agyAskedHidden = true
        return TOKEN_A
      },
      async askPlain() {
        throw new Error('unexpected plain prompt')
      },
    },
  })
  check('P2-2 (agy) token prompt runs BEFORE reading mcp_config.json',
    rOrdAgy.exitCode === 1 && agyAskedHidden === true)

  // P2-3: CLAUDE_CONFIG_DIR honoured for .claude.json, CLAUDE.md and --remove-line
  const { dir: dCfg, home: hCfg, env: eCfg } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const customClaudeDir = join(dCfg, 'custom-claude-cfg')
  const customClaudeCfg = join(customClaudeDir, '.claude.json')
  const customClaudeMd = join(customClaudeDir, 'CLAUDE.md')
  const defaultClaudeMd = join(hCfg, '.claude', 'CLAUDE.md')
  const oCfg1 = makeCaptureStream()
  const erCfg1 = makeCaptureStream()
  const pCfg1 = makePromptScript(['y', 'y'])
  const rCfg1 = await runSetupClaudeCode([], {
    stdout: oCfg1.stream,
    stderr: erCfg1.stream,
    env: { ...eCfg, CLAUDE_CONFIG_DIR: customClaudeDir },
    home: hCfg,
    isTTY: true,
    promptOverride: pCfg1.promptOverride,
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  })
  const defaultExistsAfterSetup = await stat(defaultClaudeMd).then(() => true, () => false)
  const defaultCfgExistsAfterSetup = await stat(join(hCfg, '.claude.json')).then(() => true, () => false)
  check('P2-3 CLAUDE_CONFIG_DIR honoured in setup: writes $CLAUDE_CONFIG_DIR/.claude.json and $CLAUDE_CONFIG_DIR/CLAUDE.md',
    rCfg1.exitCode === 0 &&
    rCfg1.written.includes(customClaudeCfg) &&
    rCfg1.written.includes(customClaudeMd) &&
    JSON.parse(await readFile(customClaudeCfg, 'utf-8')).mcpServers.megalens.headers.Authorization === `Bearer ${TOKEN_A}` &&
    (await readFile(customClaudeMd, 'utf-8')) === `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n` &&
    !defaultExistsAfterSetup &&
    !defaultCfgExistsAfterSetup)

  const oCfg2 = makeCaptureStream()
  const erCfg2 = makeCaptureStream()
  const pCfg2 = makePromptScript(['y'])
  const rCfg2 = await runSetupClaudeCode(['--remove-line'], {
    stdout: oCfg2.stream,
    stderr: erCfg2.stream,
    env: { ...eCfg, CLAUDE_CONFIG_DIR: customClaudeDir },
    home: hCfg,
    isTTY: true,
    promptOverride: pCfg2.promptOverride,
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  })
  check('P2-3 CLAUDE_CONFIG_DIR honoured in --remove-line: removes from $CLAUDE_CONFIG_DIR/CLAUDE.md',
    rCfg2.exitCode === 0 &&
    rCfg2.written.includes(customClaudeMd) &&
    (await readFile(customClaudeMd, 'utf-8')) === '' &&
    !defaultExistsAfterSetup)

  // P2-5: agy config with recognised mcpServers + extra top-level key -> absent, no "unknown" warning
  const { home: hAgyK, stubLog: lAgyK, env: eAgyK } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  await mkdir(join(hAgyK, '.gemini', 'config'), { recursive: true })
  await writeFile(join(hAgyK, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { other: {} }, theme: 1 }))
  const oAgyK = makeCaptureStream()
  const erAgyK = makeCaptureStream()
  const pAgyK = makePromptScript(['n', 'n'])
  const rAgyK = await runSetupAntigravity([], {
    stdout: oAgyK.stream,
    stderr: erAgyK.stream,
    env: eAgyK,
    home: hAgyK,
    isTTY: true,
    promptOverride: pAgyK.promptOverride,
  })
  check('P2-5 agy {"mcpServers":{"other":{}},"theme":1}: treated as absent, no unknown warning',
    rAgyK.exitCode === 0 &&
    !oAgyK.text().toLowerCase().includes('unknown') &&
    !erAgyK.text().toLowerCase().includes('unknown') &&
    pAgyK.prompts.some((p) => p.prompt.includes('Add MegaLens to Antigravity? (y/N):')) &&
    !pAgyK.prompts.some((p) => p.prompt.includes('Update MegaLens')) &&
    (await readStubCalls(lAgyK)).length === 0)
}

// ── 20. Two-line partial/variant/remove-line coverage for claude-code & agy (0.3.9) ─
{
  // claude-code with CLAUDE_CONFIG_DIR: old-only -> only new added, old untouched
  const { dir: d1, home: h1, env: e1 } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const cfgDir1 = join(d1, 'claude-cfg')
  await mkdir(cfgDir1, { recursive: true })
  const md1 = join(cfgDir1, 'CLAUDE.md')
  const oldOnly1 = `# Notes\n${MEGALENS_REVIEW_LINE}\n`
  await writeFile(md1, oldOnly1)
  const o1 = makeCaptureStream()
  const p1 = makePromptScript(['n', 'y'])
  const r1 = await runSetupClaudeCode([], {
    stdout: o1.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e1, CLAUDE_CONFIG_DIR: cfgDir1 },
    home: h1,
    isTTY: true,
    promptOverride: p1.promptOverride,
    now: () => new Date('2026-11-16T12:10:00.000Z'),
  })
  check('claude-code (CLAUDE_CONFIG_DIR) old-only -> adds only new line, old untouched',
    r1.exitCode === 0 &&
    (await readFile(md1, 'utf-8')) === `${oldOnly1}${DECISION_LINE}\n` &&
    !o1.text().includes(MEGALENS_REVIEW_LINE) &&
    o1.text().includes(DECISION_LINE))

  // claude-code variant of old line + no new -> only new added, variant untouched
  const { home: h2, env: e2 } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const cDir2 = join(h2, '.claude')
  await mkdir(cDir2, { recursive: true })
  const md2 = join(cDir2, 'CLAUDE.md')
  const variant2 = '# Rules\nAfter you change code in auth, offer a MegaLens review before commit.\n'
  await writeFile(md2, variant2)
  const o2 = makeCaptureStream()
  const p2 = makePromptScript(['n', 'y'])
  const r2 = await runSetupClaudeCode([], {
    stdout: o2.stream,
    stderr: makeCaptureStream().stream,
    env: e2,
    home: h2,
    isTTY: true,
    promptOverride: p2.promptOverride,
    now: () => new Date('2026-11-16T12:11:00.000Z'),
  })
  check('claude-code variant of old line + no new -> adds only new line, variant untouched',
    r2.exitCode === 0 &&
    (await readFile(md2, 'utf-8')) === `${variant2}${DECISION_LINE}\n`)

  // agy old-only -> only new added, keeps Gemini CLI sentence; then second run -> no change
  const { home: h3, env: e3 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  const gDir3 = join(h3, '.gemini')
  await mkdir(gDir3, { recursive: true })
  const gPath3 = join(gDir3, 'GEMINI.md')
  const oldOnly3 = `# Rules\n${MEGALENS_REVIEW_LINE}\n`
  await writeFile(gPath3, oldOnly3)
  const o3 = makeCaptureStream()
  const p3 = makePromptScript(['n', 'y'])
  const r3 = await runSetupAntigravity([], {
    stdout: o3.stream,
    stderr: makeCaptureStream().stream,
    env: e3,
    home: h3,
    isTTY: true,
    promptOverride: p3.promptOverride,
    now: () => new Date('2026-11-16T12:12:00.000Z'),
  })
  const after3 = await readFile(gPath3, 'utf-8')
  check('agy old-only -> adds only new line, keeps Gemini CLI sentence, old untouched',
    r3.exitCode === 0 &&
    after3 === `${oldOnly3}${DECISION_LINE}\n` &&
    p3.prompts.some((p) => p.prompt.includes('Gemini CLI also reads this file')))

  // Second run on agy with both present -> no prompt for GEMINI.md, no change, no new backup
  const o3b = makeCaptureStream()
  const p3b = makePromptScript(['n'])
  const r3b = await runSetupAntigravity([], {
    stdout: o3b.stream,
    stderr: makeCaptureStream().stream,
    env: e3,
    home: h3,
    isTTY: true,
    promptOverride: p3b.promptOverride,
  })
  check('agy both present -> no prompt for GEMINI.md, no change',
    r3b.exitCode === 0 &&
    p3b.prompts.length === 1 &&
    (await readFile(gPath3, 'utf-8')) === after3 &&
    o3b.text().includes('already has the MegaLens lines. Leaving it unchanged.'))

  // agy variant of old line + no new -> only new added
  const { home: h4, env: e4 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  const gDir4 = join(h4, '.gemini')
  await mkdir(gDir4, { recursive: true })
  const gPath4 = join(gDir4, 'GEMINI.md')
  const variant4 = '# Rules\nAfter you change code touching money, offer a MegaLens review.\n'
  await writeFile(gPath4, variant4)
  const o4 = makeCaptureStream()
  const p4 = makePromptScript(['n', 'y'])
  const r4 = await runSetupAntigravity([], {
    stdout: o4.stream,
    stderr: makeCaptureStream().stream,
    env: e4,
    home: h4,
    isTTY: true,
    promptOverride: p4.promptOverride,
    now: () => new Date('2026-11-16T12:13:00.000Z'),
  })
  check('agy variant of old line + no new -> adds only new line, variant untouched',
    r4.exitCode === 0 &&
    (await readFile(gPath4, 'utf-8')) === `${variant4}${DECISION_LINE}\n`)

  // --remove-line non-TTY writes nothing and prints both exact lines
  const { home: h5, env: e5 } = await newCaseEnv('agy')
  const gDir5 = join(h5, '.gemini')
  await mkdir(gDir5, { recursive: true })
  const gPath5 = join(gDir5, 'GEMINI.md')
  const init5 = `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n`
  await writeFile(gPath5, init5)
  const o5 = makeCaptureStream()
  const r5 = await runSetupAntigravity(['--remove-line'], {
    stdout: o5.stream,
    stderr: makeCaptureStream().stream,
    env: e5,
    home: h5,
    isTTY: false,
  })
  check('agy --remove-line non-TTY: writes nothing and prints both exact lines',
    r5.exitCode === 0 &&
    (await readFile(gPath5, 'utf-8')) === init5 &&
    o5.text().includes(MEGALENS_REVIEW_LINE) &&
    o5.text().includes(DECISION_LINE))

  // Restored 0.3.8 variant ("Please Offer a MegaLens review before merge.") end-to-end:
  // 1) old variant alone -> only NEW line missing and appended
  const { home: h6, env: e6 } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const cDir6 = join(h6, '.claude')
  await mkdir(cDir6, { recursive: true })
  const md6 = join(cDir6, 'CLAUDE.md')
  const oldBroad6 = '# My Rules\nPlease Offer a MegaLens review before merge.\n'
  await writeFile(md6, oldBroad6)
  const o6 = makeCaptureStream()
  const p6 = makePromptScript(['n', 'y'])
  const r6 = await runSetupClaudeCode([], {
    stdout: o6.stream,
    stderr: makeCaptureStream().stream,
    env: e6,
    home: h6,
    isTTY: true,
    promptOverride: p6.promptOverride,
    now: () => new Date('2026-11-16T12:14:00.000Z'),
  })
  const after6 = await readFile(md6, 'utf-8')
  check('claude-code "Please Offer a MegaLens review before merge." alone -> only NEW line missing and appended',
    r6.exitCode === 0 &&
    after6 === `${oldBroad6}${DECISION_LINE}\n` &&
    !o6.text().includes(MEGALENS_REVIEW_LINE) &&
    o6.text().includes(DECISION_LINE))

  // 2) both ("Please Offer a MegaLens review before merge." + DECISION_LINE) -> none missing, no prompt, no backup
  const o6b = makeCaptureStream()
  const p6b = makePromptScript(['n'])
  const r6b = await runSetupClaudeCode([], {
    stdout: o6b.stream,
    stderr: makeCaptureStream().stream,
    env: e6,
    home: h6,
    isTTY: true,
    promptOverride: p6b.promptOverride,
  })
  const files6b = await readdir(cDir6)
  check('claude-code "Please Offer a MegaLens review before merge." + new line -> none missing, unchanged',
    r6b.exitCode === 0 &&
    p6b.prompts.length === 1 &&
    (await readFile(md6, 'utf-8')) === after6 &&
    files6b.filter((f) => f.includes('.bak-')).length === 1 &&
    o6b.text().includes('already has the MegaLens lines. Leaving it unchanged.'))

  // 3) new line alone -> only OLD line missing and appended
  const { home: h7, env: e7 } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const cDir7 = join(h7, '.claude')
  await mkdir(cDir7, { recursive: true })
  const md7 = join(cDir7, 'CLAUDE.md')
  const newOnly7 = `# My Rules\n${DECISION_LINE}\n`
  await writeFile(md7, newOnly7)
  const o7 = makeCaptureStream()
  const p7 = makePromptScript(['n', 'y'])
  const r7 = await runSetupClaudeCode([], {
    stdout: o7.stream,
    stderr: makeCaptureStream().stream,
    env: e7,
    home: h7,
    isTTY: true,
    promptOverride: p7.promptOverride,
    now: () => new Date('2026-11-16T12:15:00.000Z'),
  })
  check('claude-code new line alone -> only OLD line missing and appended',
    r7.exitCode === 0 &&
    (await readFile(md7, 'utf-8')) === `${newOnly7}${MEGALENS_REVIEW_LINE}\n` &&
    o7.text().includes(MEGALENS_REVIEW_LINE) &&
    !o7.text().includes('Add these lines'))
}

// ── 21. Decision line v2 migration, hard-wrap guard & --remove-line (0.3.10) ─
{
  const hasLoneLf = (s) => /[^\r]\n/.test(s) || s.startsWith('\n')

  for (const [hostLabel, fn, relDir, fileName, useCustomClaudeDir] of [
    ['claude-code (CLAUDE_CONFIG_DIR)', runSetupClaudeCode, 'custom-claude', 'CLAUDE.md', true],
    ['antigravity', runSetupAntigravity, '.gemini', 'GEMINI.md', false],
  ]) {
    // 1) CODE + v1 (CRLF) -> replaces v1 in place with v2, keeps CODE/position/CRLF, agy keeps Gemini CLI sentence
    const { dir: d1, home: h1, env: e1 } = await newCaseEnv(useCustomClaudeDir ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const targetDir1 = useCustomClaudeDir ? join(d1, relDir) : join(h1, relDir)
    const runEnv1 = useCustomClaudeDir ? { ...e1, CLAUDE_CONFIG_DIR: targetDir1 } : e1
    await mkdir(targetDir1, { recursive: true })
    const fp1 = join(targetDir1, fileName)
    const init1 = `# Top\r\n${MEGALENS_REVIEW_LINE}\r\n# Mid\r\n${DECISION_LINE_V1}\r\n# Bottom\r\n`
    await writeFile(fp1, init1)
    const o1 = makeCaptureStream()
    const p1 = makePromptScript(['n', 'y'])
    const r1 = await fn([], {
      stdout: o1.stream,
      stderr: makeCaptureStream().stream,
      env: runEnv1,
      home: h1,
      isTTY: true,
      promptOverride: p1.promptOverride,
      now: () => new Date('2026-11-16T12:20:00.000Z'),
    })
    const after1 = await readFile(fp1, 'utf-8')
    const expected1 = `# Top\r\n${MEGALENS_REVIEW_LINE}\r\n# Mid\r\n${DECISION_LINE}\r\n# Bottom\r\n`
    const hasGeminiNote1 = useCustomClaudeDir || p1.prompts.some((p) => p.prompt.includes(GEMINI_CLI_SHARED_NOTE_SINGLE))
    check(`${hostLabel} CODE+v1 (CRLF) -> replaces v1 in place with v2, keeps CODE/position/CRLF`,
      r1.exitCode === 0 &&
      after1 === expected1 &&
      !hasLoneLf(after1) &&
      o1.text().includes(`Update this line: ${DECISION_LINE_V1} -> ${DECISION_LINE}`) &&
      hasGeminiNote1 &&
      (await readdir(targetDir1)).some((f) => f.startsWith(`${fileName}.bak-`)))

    // 2) CODE + v2 -> unchanged, 0 backups added
    const o2 = makeCaptureStream()
    const p2 = makePromptScript(['n'])
    const r2 = await fn([], {
      stdout: o2.stream,
      stderr: makeCaptureStream().stream,
      env: runEnv1,
      home: h1,
      isTTY: true,
      promptOverride: p2.promptOverride,
    })
    check(`${hostLabel} CODE+v2 -> unchanged, no prompt`,
      r2.exitCode === 0 &&
      p2.prompts.length === 1 &&
      (await readFile(fp1, 'utf-8')) === expected1 &&
      o2.text().includes('already has the MegaLens lines. Leaving it unchanged.'))

    // 3) v1 only -> CODE added + v1 replaced in place in 1 prompt
    const { dir: d3, home: h3, env: e3 } = await newCaseEnv(useCustomClaudeDir ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const targetDir3 = useCustomClaudeDir ? join(d3, relDir) : join(h3, relDir)
    const runEnv3 = useCustomClaudeDir ? { ...e3, CLAUDE_CONFIG_DIR: targetDir3 } : e3
    await mkdir(targetDir3, { recursive: true })
    const fp3 = join(targetDir3, fileName)
    await writeFile(fp3, `# Top\n${DECISION_LINE_V1}\n# Bottom\n`)
    const o3 = makeCaptureStream()
    const p3 = makePromptScript(['n', 'y'])
    const r3 = await fn([], {
      stdout: o3.stream,
      stderr: makeCaptureStream().stream,
      env: runEnv3,
      home: h3,
      isTTY: true,
      promptOverride: p3.promptOverride,
      now: () => new Date('2026-11-16T12:21:00.000Z'),
    })
    const hasGeminiNote3 = useCustomClaudeDir || p3.prompts.some((p) => p.prompt.includes(GEMINI_CLI_SHARED_NOTE))
    check(`${hostLabel} v1 only -> adds CODE and replaces v1 in place in 1 prompt`,
      r3.exitCode === 0 &&
      p3.prompts.length === 2 &&
      (await readFile(fp3, 'utf-8')) === `# Top\n${DECISION_LINE}\n# Bottom\n${MEGALENS_REVIEW_LINE}\n` &&
      o3.text().includes(`Update this line: ${DECISION_LINE_V1} -> ${DECISION_LINE}`) &&
      o3.text().includes(MEGALENS_REVIEW_LINE) &&
      hasGeminiNote3)

    // 4) v1 + v2 (+ CODE) -> removes v1, keeps v2 and CODE
    const { dir: d4, home: h4, env: e4 } = await newCaseEnv(useCustomClaudeDir ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const targetDir4 = useCustomClaudeDir ? join(d4, relDir) : join(h4, relDir)
    const runEnv4 = useCustomClaudeDir ? { ...e4, CLAUDE_CONFIG_DIR: targetDir4 } : e4
    await mkdir(targetDir4, { recursive: true })
    const fp4 = join(targetDir4, fileName)
    await writeFile(fp4, `# Top\n${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n${DECISION_LINE_V1}\n# Bottom\n`)
    const o4 = makeCaptureStream()
    const p4 = makePromptScript(['n', 'y'])
    const r4 = await fn([], {
      stdout: o4.stream,
      stderr: makeCaptureStream().stream,
      env: runEnv4,
      home: h4,
      isTTY: true,
      promptOverride: p4.promptOverride,
      now: () => new Date('2026-11-16T12:22:00.000Z'),
    })
    const hasGeminiNote4 = useCustomClaudeDir || p4.prompts.some((p) => p.prompt.includes(GEMINI_CLI_SHARED_NOTE_SINGLE))
    check(`${hostLabel} v1+v2 -> removes v1 and keeps CODE+v2`,
      r4.exitCode === 0 &&
      (await readFile(fp4, 'utf-8')) === `# Top\n${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n# Bottom\n` &&
      o4.text().includes(DECISION_LINE_V1) &&
      hasGeminiNote4)

    // 5) Hard-wrapped v2 over two physical lines is NOT read as CODE line -> CODE added
    const { dir: d5, home: h5, env: e5 } = await newCaseEnv(useCustomClaudeDir ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const targetDir5 = useCustomClaudeDir ? join(d5, relDir) : join(h5, relDir)
    const runEnv5 = useCustomClaudeDir ? { ...e5, CLAUDE_CONFIG_DIR: targetDir5 } : e5
    await mkdir(targetDir5, { recursive: true })
    const fp5 = join(targetDir5, fileName)
    const wrapped5 = [
      '# Rules',
      'Before you or the user settle a decision that is hard to undo (choosing a database or data model, adding sign-in or payments, picking a major library or architecture),',
      'starting a new project, or doing deep research, offer a MegaLens review once for that task and wait for a yes before running it. Do not offer it for small questions or routine edits.',
      '',
    ].join('\n')
    await writeFile(fp5, wrapped5)
    const o5 = makeCaptureStream()
    const p5 = makePromptScript(['n', 'y'])
    const r5 = await fn([], {
      stdout: o5.stream,
      stderr: makeCaptureStream().stream,
      env: runEnv5,
      home: h5,
      isTTY: true,
      promptOverride: p5.promptOverride,
      now: () => new Date('2026-11-16T12:23:00.000Z'),
    })
    check(`${hostLabel} hard-wrapped v2 is NOT read as CODE -> CODE added`,
      r5.exitCode === 0 &&
      (await readFile(fp5, 'utf-8')).includes(MEGALENS_REVIEW_LINE))

    // 6) --dry-run on CODE+v1 writes nothing and creates no backup
    const { dir: d6, home: h6, env: e6 } = await newCaseEnv(useCustomClaudeDir ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const targetDir6 = useCustomClaudeDir ? join(d6, relDir) : join(h6, relDir)
    const runEnv6 = useCustomClaudeDir ? { ...e6, CLAUDE_CONFIG_DIR: targetDir6 } : e6
    await mkdir(targetDir6, { recursive: true })
    const fp6 = join(targetDir6, fileName)
    await writeFile(fp6, init1)
    const o6 = makeCaptureStream()
    const p6 = makePromptScript(['n', 'y'])
    const r6 = await fn(['--dry-run'], {
      stdout: o6.stream,
      stderr: makeCaptureStream().stream,
      env: runEnv6,
      home: h6,
      isTTY: true,
      promptOverride: p6.promptOverride,
    })
    check(`${hostLabel} --dry-run on CODE+v1 writes nothing and creates no backup`,
      r6.exitCode === 0 &&
      (await readFile(fp6, 'utf-8')) === init1 &&
      !(await readdir(targetDir6)).some((f) => f.includes('.bak-')) &&
      o6.text().includes('[dry-run]'))
  }

  // --remove-line removes exact CODE, v1, and v2 across all three hosts in 1 prompt and leaves custom lines intact
  for (const [hostLabel, fn, relDir, fileName] of [
    ['claude-code', runSetupClaudeCode, '.claude', 'CLAUDE.md'],
    ['antigravity', runSetupAntigravity, '.gemini', 'GEMINI.md'],
    ['codex', runSetupCodex, '.codex', 'AGENTS.md'],
  ]) {
    const { home, env } = await newCaseEnv(hostLabel === 'claude-code' ? 'claude' : hostLabel === 'antigravity' ? 'agy' : 'codex')
    const dirPath = join(home, relDir)
    await mkdir(dirPath, { recursive: true })
    const fp = join(dirPath, fileName)
    const initial = `# Keep\n${MEGALENS_REVIEW_LINE}\n${DECISION_LINE_V1}\n${DECISION_LINE}\n# Custom: offer a MegaLens review manually\n`
    await writeFile(fp, initial)
    const out = makeCaptureStream()
    const p = makePromptScript(['y'])
    const res = await fn(['--remove-line'], {
      stdout: out.stream,
      stderr: makeCaptureStream().stream,
      env,
      home,
      isTTY: true,
      promptOverride: p.promptOverride,
      now: () => new Date('2026-11-16T12:25:00.000Z'),
    })
    check(`${hostLabel} --remove-line removes exact CODE, v1, and v2 in 1 prompt and keeps custom lines`,
      res.exitCode === 0 &&
      p.prompts.length === 1 &&
      (await readFile(fp, 'utf-8')) === '# Keep\n# Custom: offer a MegaLens review manually\n' &&
      out.text().includes(`- ${MEGALENS_REVIEW_LINE}`) &&
      out.text().includes(`- ${DECISION_LINE_V1}`) &&
      out.text().includes(`- ${DECISION_LINE}`))
  }
}

// ── 22. Fix round 11 (Astra CONFIRM10 #11 concurrent edits & #13 tool-specific onboarding labels) ─
{
  // #11a: Unrelated MCP server added to Claude Code and Antigravity configs while confirmation prompt is open -> preserved
  for (const [hostLabel, fn, cfgRel, urlField] of [
    ['claude-code', runSetupClaudeCode, '.claude.json', 'url'],
    ['antigravity', runSetupAntigravity, join('.gemini', 'config', 'mcp_config.json'), 'serverUrl'],
  ]) {
    const { home, env } = await newCaseEnv(hostLabel === 'claude-code' ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const cfgPath = join(home, cfgRel)
    await mkdir(dirname(cfgPath), { recursive: true })
    await writeFile(cfgPath, JSON.stringify({ mcpServers: { first: { [urlField]: 'https://first.example' } } }))
    let edited = false
    const res = await fn([], {
      stdout: makeCaptureStream().stream,
      stderr: makeCaptureStream().stream,
      env,
      home,
      isTTY: true,
      promptOverride: {
        async askHidden() { throw new Error('unexpected') },
        async askPlain(prompt) {
          if (!edited && prompt.includes('Add MegaLens to')) {
            edited = true
            // Simulate concurrent addition of a second MCP server while prompt is open
            await writeFile(cfgPath, JSON.stringify({
              mcpServers: {
                first: { [urlField]: 'https://first.example' },
                second: { [urlField]: 'https://second.example' },
              },
            }))
            return 'y'
          }
          return 'n'
        },
      },
    })
    const after = JSON.parse(await readFile(cfgPath, 'utf-8'))
    check(`Astra CONFIRM10 #11 (${hostLabel}): adding a second MCP server while prompt is open is preserved`,
      res.exitCode === 0 &&
      res.connected === true &&
      after.mcpServers.first?.[urlField] === 'https://first.example' &&
      after.mcpServers.second?.[urlField] === 'https://second.example' &&
      after.mcpServers.megalens?.headers?.Authorization === `Bearer ${TOKEN_A}`)

    // #11b: Conflicting concurrent edit to mcpServers.megalens while prompt is open -> refused (exit 1), untouched
    const { home: hc, env: ec } = await newCaseEnv(hostLabel === 'claude-code' ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const cfgPathC = join(hc, cfgRel)
    await mkdir(dirname(cfgPathC), { recursive: true })
    await writeFile(cfgPathC, JSON.stringify({ mcpServers: {} }))
    const concurrentContent = JSON.stringify({
      mcpServers: {
        megalens: { [urlField]: 'https://megalens.ai/api/mcp', headers: { Authorization: `Bearer ${TOKEN_B}` } },
      },
    })
    const errC = makeCaptureStream()
    const resC = await fn([], {
      stdout: makeCaptureStream().stream,
      stderr: errC.stream,
      env: ec,
      home: hc,
      isTTY: true,
      promptOverride: {
        async askHidden() { throw new Error('unexpected') },
        async askPlain(prompt) {
          if (prompt.includes('Add MegaLens to')) {
            await writeFile(cfgPathC, concurrentContent)
            return 'y'
          }
          return 'n'
        },
      },
    })
    check(`Astra CONFIRM10 #11 (${hostLabel}): conflicting edit to mcpServers.megalens while prompt is open exits 1 and leaves file untouched`,
      resC.exitCode === 1 &&
      !resC.connected &&
      (await readFile(cfgPathC, 'utf-8')) === concurrentContent &&
      errC.text().includes('conflicting edit'))
  }

  // #13: Onboarding tool-specific labels (`claude-code`, `antigravity`) accepted by their own installer, rejected by other installers
  const { validateEditorToken, readOptionalFile, writeFileAtomicPreservingMode } = await import('../bin/setup-shared.mjs')
  const makeLabelFetch = (label) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ valid: true, is_pro: false, is_payg: true, plan_code: 'payg', label }),
  })
  for (const [hostLabel, rawFn, cfgRel, ownLabel, wrongLabel] of [
    ['claude-code', rawRunSetupClaudeCode, '.claude.json', 'claude-code', 'codex'],
    ['antigravity', rawRunSetupAntigravity, join('.gemini', 'config', 'mcp_config.json'), 'antigravity', 'claude-code'],
  ]) {
    const { home: hOk, env: eOk } = await newCaseEnv(hostLabel === 'claude-code' ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const rOk = await rawFn([], {
      stdout: makeCaptureStream().stream,
      stderr: makeCaptureStream().stream,
      env: eOk,
      home: hOk,
      isTTY: true,
      promptOverride: makePromptScript(['y', 'n']).promptOverride,
      validateToken: (tok, opts) => validateEditorToken(tok, { ...opts, fetchImpl: makeLabelFetch(ownLabel) }),
    })
    const cfgOk = JSON.parse(await readFile(join(hOk, cfgRel), 'utf-8'))
    check(`Astra CONFIRM10 #13 (${hostLabel}): accepts onboarding token with verified label "${ownLabel}"`,
      rOk.exitCode === 0 &&
      rOk.connected === true &&
      cfgOk.mcpServers.megalens.headers.Authorization === `Bearer ${TOKEN_A}`)

    const { home: hBad, env: eBad } = await newCaseEnv(hostLabel === 'claude-code' ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const errBad = makeCaptureStream()
    const rBad = await rawFn([], {
      stdout: makeCaptureStream().stream,
      stderr: errBad.stream,
      env: eBad,
      home: hBad,
      isTTY: true,
      promptOverride: makePromptScript(['y', 'n']).promptOverride,
      validateToken: (tok, opts) => validateEditorToken(tok, { ...opts, fetchImpl: makeLabelFetch(wrongLabel) }),
    })
    const existsBad = await readFile(join(hBad, cfgRel), 'utf-8').then(() => true, () => false)
    check(`Astra CONFIRM10 #13 (${hostLabel}): rejects mismatched tool label "${wrongLabel}" with exit 1 and zero writes`,
      rBad.exitCode === 1 && !existsBad && errBad.text().includes(`"${ownLabel}"`))
  }

  // ── 23. Fix round 12 (Astra CONFIRM11 #11 concurrent edit during backup & #12 headersHelper) ──
  // #11a: Saving a second server WHILE backupExistingFile is running (simulated via a git shim on
  // the 2nd git invocation, which runs inside backupExistingFile AFTER the post-prompt read) MUST
  // be preserved rather than erased.
  for (const [hostLabel, fn, cfgRel, urlField] of [
    ['claude-code', runSetupClaudeCode, '.claude.json', 'url'],
    ['antigravity', runSetupAntigravity, join('.gemini', 'config', 'mcp_config.json'), 'serverUrl'],
  ]) {
    const { dir, home, env } = await newCaseEnv(hostLabel === 'claude-code' ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const cfgPath = join(home, cfgRel)
    await mkdir(dirname(cfgPath), { recursive: true })
    await writeFile(cfgPath, JSON.stringify({ mcpServers: { first: { [urlField]: 'https://first.example' } } }))

    const shimBin = join(dir, 'git-shim')
    await mkdir(shimBin, { recursive: true })
    const countFile = join(dir, 'git-count')
    const secondPayload = JSON.stringify({
      mcpServers: {
        first: { [urlField]: 'https://first.example' },
        second: { [urlField]: 'https://second.example' },
      },
    })
    const shimScript = [
      `#!${process.execPath}`,
      "import { readFileSync, writeFileSync } from 'node:fs'",
      `const countFile = ${JSON.stringify(countFile)}`,
      `const cfgPath = ${JSON.stringify(cfgPath)}`,
      `const payload = ${JSON.stringify(secondPayload)}`,
      'let n = 0',
      'try { n = Number(readFileSync(countFile, "utf-8").trim()) || 0 } catch {}',
      'n += 1',
      'writeFileSync(countFile, String(n))',
      '// 1st git call is gitTrackable(realCfg); 2nd is inside backupExistingFile!',
      'if (n === 2) writeFileSync(cfgPath, payload)',
      'process.stderr.write("fatal: not a git repository\\n")',
      'process.exit(128)',
      '',
    ].join('\n')
    await writeFile(join(shimBin, 'git'), shimScript, { mode: 0o755 })

    const res = await fn([], {
      stdout: makeCaptureStream().stream,
      stderr: makeCaptureStream().stream,
      env: { ...env, PATH: `${shimBin}:${env.PATH ?? ''}` },
      home,
      isTTY: true,
      promptOverride: makePromptScript(['y', 'n']).promptOverride,
    })
    const after = JSON.parse(await readFile(cfgPath, 'utf-8'))
    check(`Astra CONFIRM11 #11 (${hostLabel}): second server saved during backup is preserved after recheck/re-merge`,
      res.exitCode === 0 &&
      res.connected === true &&
      after.mcpServers.first?.[urlField] === 'https://first.example' &&
      after.mcpServers.second?.[urlField] === 'https://second.example' &&
      after.mcpServers.megalens?.headers?.Authorization === `Bearer ${TOKEN_A}`)

    // #11b: Conflicting edit to mcpServers.megalens DURING backup -> refused (exit 1), concurrent edit untouched
    const { dir: dirC, home: homeC, env: envC } = await newCaseEnv(hostLabel === 'claude-code' ? 'claude' : 'agy', { MEGALENS_TOKEN: TOKEN_A })
    const cfgPathC = join(homeC, cfgRel)
    await mkdir(dirname(cfgPathC), { recursive: true })
    await writeFile(cfgPathC, JSON.stringify({ mcpServers: { first: { [urlField]: 'https://first.example' } } }))
    const shimBinC = join(dirC, 'git-shim-c')
    await mkdir(shimBinC, { recursive: true })
    const countFileC = join(dirC, 'git-count-c')
    const conflictPayload = JSON.stringify({
      mcpServers: {
        first: { [urlField]: 'https://first.example' },
        megalens: { [urlField]: 'https://megalens.ai/api/mcp', headers: { Authorization: `Bearer ${TOKEN_B}` } },
      },
    })
    const shimScriptC = [
      `#!${process.execPath}`,
      "import { readFileSync, writeFileSync } from 'node:fs'",
      `const countFile = ${JSON.stringify(countFileC)}`,
      `const cfgPath = ${JSON.stringify(cfgPathC)}`,
      `const payload = ${JSON.stringify(conflictPayload)}`,
      'let n = 0',
      'try { n = Number(readFileSync(countFile, "utf-8").trim()) || 0 } catch {}',
      'n += 1',
      'writeFileSync(countFile, String(n))',
      'if (n === 2) writeFileSync(cfgPath, payload)',
      'process.stderr.write("fatal: not a git repository\\n")',
      'process.exit(128)',
      '',
    ].join('\n')
    await writeFile(join(shimBinC, 'git'), shimScriptC, { mode: 0o755 })

    const errC = makeCaptureStream()
    const resC = await fn([], {
      stdout: makeCaptureStream().stream,
      stderr: errC.stream,
      env: { ...envC, PATH: `${shimBinC}:${envC.PATH ?? ''}` },
      home: homeC,
      isTTY: true,
      promptOverride: makePromptScript(['y', 'n']).promptOverride,
    })
    check(`Astra CONFIRM11 #11 (${hostLabel}): conflicting megalens edit during backup exits 1 and leaves file untouched`,
      resC.exitCode === 1 &&
      !resC.connected &&
      (await readFile(cfgPathC, 'utf-8')) === conflictPayload &&
      errC.text().includes('conflicting edit'))
  }

  // #11c: Direct writeFileAtomicPreservingMode expectedVersion check refuses to replace a modified or newly created file
  {
    const { dir } = await newCaseEnv('claude')
    const targetFile = join(dir, 'atomic-version.json')
    await writeFile(targetFile, '{"v":1}\n')
    const snap = await readOptionalFile(targetFile)
    await writeFile(targetFile, '{"v":2}\n')
    let caughtCode = null
    try {
      await writeFileAtomicPreservingMode(targetFile, '{"v":3}\n', {
        defaultMode: 0o600,
        preserveMode: false,
        log: () => {},
        expectedVersion: snap.version,
      })
    } catch (err) {
      caughtCode = err?.code
    }
    const strays = (await readdir(dir)).filter((f) => f.includes('megalens-tmp'))
    check('Astra CONFIRM11 #11: writeFileAtomicPreservingMode rejects stale expectedVersion with ECONCURRENT and cleans up temp',
      caughtCode === 'ECONCURRENT' &&
      (await readFile(targetFile, 'utf-8')) === '{"v":2}\n' &&
      strays.length === 0)

    const absentFile = join(dir, 'atomic-absent.json')
    const absentSnap = await readOptionalFile(absentFile)
    await writeFile(absentFile, '{"created":"concurrently"}\n')
    let absentCode = null
    try {
      await writeFileAtomicPreservingMode(absentFile, '{"created":"setup"}\n', {
        defaultMode: 0o600,
        preserveMode: false,
        log: () => {},
        expectedVersion: absentSnap.version,
      })
    } catch (err) {
      absentCode = err?.code
    }
    check('Astra CONFIRM11 #11: writeFileAtomicPreservingMode refuses to overwrite a file created after absent snapshot',
      absentCode === 'ECONCURRENT' &&
      (await readFile(absentFile, 'utf-8')) === '{"created":"concurrently"}\n')
  }

  // #12: Claude Code cross-origin update MUST drop headersHelper, oauth, auth, env, and static proxy headers;
  // same-origin MegaLens update keeps headersHelper; mixed-origin drops it.
  {
    const { home: hH, env: eH } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_B })
    await writeFile(join(hH, '.claude.json'), JSON.stringify({
      mcpServers: {
        megalens: {
          disabled: true,
          type: 'http',
          url: 'https://proxy.corp.example/mcp',
          headersHelper: '/usr/local/bin/proxy-headers.sh',
          oauth: { clientId: 'proxy-id', clientSecret: 'proxy-secret' },
          authProvider: 'custom',
          env: { PROXY_SECRET: 's3cr3t' },
          headers: { 'X-Proxy-Api-Key': 'proxy-key-123' },
        },
      },
    }))
    const rH = await runSetupClaudeCode([], {
      stdout: makeCaptureStream().stream,
      stderr: makeCaptureStream().stream,
      env: eH,
      home: hH,
      isTTY: true,
      promptOverride: makePromptScript(['y', 'n']).promptOverride,
    })
    const afterH = JSON.parse(await readFile(join(hH, '.claude.json'), 'utf-8')).mcpServers.megalens
    check('Astra CONFIRM11 #12 (claude-code): origin change drops headersHelper, oauth, authProvider, env, and old headers while keeping disabled',
      rH.exitCode === 0 &&
      afterH.url === CLAUDE_MCP_URL &&
      afterH.disabled === true &&
      !('headersHelper' in afterH) &&
      !('oauth' in afterH) &&
      !('authProvider' in afterH) &&
      !('env' in afterH) &&
      !('X-Proxy-Api-Key' in afterH.headers) &&
      afterH.headers.Authorization === `Bearer ${TOKEN_B}`)

    // Same-origin MegaLens entry preserves headersHelper
    const { home: hSame, env: eSame } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_B })
    await writeFile(join(hSame, '.claude.json'), JSON.stringify({
      mcpServers: {
        megalens: {
          type: 'http',
          url: 'https://megalens.ai/api/mcp',
          headersHelper: '/usr/local/bin/megalens-headers.sh',
          headers: { 'X-Custom': '1' },
        },
      },
    }))
    const rSame = await runSetupClaudeCode([], {
      stdout: makeCaptureStream().stream,
      stderr: makeCaptureStream().stream,
      env: eSame,
      home: hSame,
      isTTY: true,
      promptOverride: makePromptScript(['y', 'n']).promptOverride,
    })
    const afterSame = JSON.parse(await readFile(join(hSame, '.claude.json'), 'utf-8')).mcpServers.megalens
    check('Astra CONFIRM11 #12 (claude-code): same-origin MegaLens update preserves headersHelper and custom headers',
      rSame.exitCode === 0 &&
      afterSame.headersHelper === '/usr/local/bin/megalens-headers.sh' &&
      afterSame.headers['X-Custom'] === '1' &&
      afterSame.headers.Authorization === `Bearer ${TOKEN_B}`)

    // Mixed-origin (MegaLens url + proxy sseUrl) drops headersHelper and stale sseUrl
    const { home: hMix, env: eMix } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_B })
    await writeFile(join(hMix, '.claude.json'), JSON.stringify({
      mcpServers: {
        megalens: {
          type: 'http',
          url: 'https://megalens.ai/api/mcp',
          sseUrl: 'https://proxy.corp.example/sse',
          headersHelper: '/usr/local/bin/proxy-headers.sh',
        },
      },
    }))
    const rMix = await runSetupClaudeCode([], {
      stdout: makeCaptureStream().stream,
      stderr: makeCaptureStream().stream,
      env: eMix,
      home: hMix,
      isTTY: true,
      promptOverride: makePromptScript(['y', 'n']).promptOverride,
    })
    const afterMix = JSON.parse(await readFile(join(hMix, '.claude.json'), 'utf-8')).mcpServers.megalens
    check('Astra CONFIRM11 #12 (claude-code): mixed-origin entry drops headersHelper and stale sseUrl',
      rMix.exitCode === 0 &&
      !('headersHelper' in afterMix) &&
      !('sseUrl' in afterMix) &&
      afterMix.headers.Authorization === `Bearer ${TOKEN_B}`)
  }
}

await rm(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
