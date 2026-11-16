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
  CLAUDE_DOCS_URL,
  ANTIGRAVITY_DOCS_URL,
  CLAUDE_FINAL_MESSAGE,
  ANTIGRAVITY_FINAL_MESSAGE,
  GEMINI_CLI_SHARED_NOTE,
  GEMINI_CLI_SHARED_NOTE_SINGLE,
  runSetupClaudeCode,
  runSetupAntigravity,
} from '../bin/host-setup.mjs'
import { runSetupCodex } from '../bin/codex-setup.mjs'

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

// ── 1. Claude Code: fresh home yes/yes (hidden token + exact argv + CLAUDE.md) ─
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
  const claudeMdPath = join(home, '.claude', 'CLAUDE.md')
  const claudeMd = await readFile(claudeMdPath, 'utf-8').catch(() => '')

  check('claude-code yes/yes: exits 0 and connects',
    res.exitCode === 0 && res.connected === true && res.written.includes(claudeMdPath))
  check('claude-code yes/yes: stub received exact get and add argv',
    calls.length === 2 &&
    calls[0].bin === 'claude' &&
    JSON.stringify(calls[0].argv) === JSON.stringify(['mcp', 'get', 'megalens']) &&
    calls[1].bin === 'claude' &&
    JSON.stringify(calls[1].argv) === JSON.stringify([
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'megalens',
      'https://megalens.ai/api/mcp?ide=claude-code',
      '--header',
      `Authorization: Bearer ${TOKEN_A}`,
    ]))
  check('claude-code yes/yes: CLAUDE.md created with both exact lines and mode 0644',
    claudeMd === `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n` &&
    ((await stat(claudeMdPath)).mode & 0o777) === 0o644)
  check('claude-code yes/yes: prompts show path, lines, masked cmd; final message matches spec; no token leak',
    prompts.length === 3 &&
    out.text().includes(MEGALENS_REVIEW_LINE) &&
    out.text().includes(DECISION_LINE) &&
    prompts.some((p) => p.prompt.includes('Add these lines to')) &&
    out.text().includes('Authorization: Bearer ml_tok_****') &&
    out.text().includes(CLAUDE_FINAL_MESSAGE) &&
    !out.text().includes(SECRET_PART_A) &&
    !err.text().includes(SECRET_PART_A))
}

// ── 2. Antigravity: fresh home yes/yes (MEGALENS_TOKEN + exact argv + GEMINI.md + Gemini CLI note) ─
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
  const geminiMdPath = join(home, '.gemini', 'GEMINI.md')
  const geminiMd = await readFile(geminiMdPath, 'utf-8').catch(() => '')

  check('antigravity yes/yes: exits 0 and connects',
    res.exitCode === 0 && res.connected === true && res.written.includes(geminiMdPath))
  check('antigravity yes/yes: stub received exact add argv with ide=antigravity',
    calls.length === 1 &&
    calls[0].bin === 'agy' &&
    JSON.stringify(calls[0].argv) === JSON.stringify([
      'mcp',
      'add',
      '--header',
      `Authorization: Bearer ${TOKEN_A}`,
      'megalens',
      'https://megalens.ai/api/mcp?ide=antigravity',
    ]))
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

  // Claude Code: no/no never calls add/remove and writes nothing
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
  check('claude-code empty/no: exits 0, writes nothing, never runs add/remove',
    cres.exitCode === 0 &&
    cres.written.length === 0 &&
    !cres.connected &&
    ccalls.every((c) => c.argv[1] === 'get') &&
    (await readdir(ch)).length === 0)
}

// ── 4. CLI missing (writes nothing on n; writes only line on y; prints manual cmd + docs) ─
{
  for (const [label, fn, docsUrl, expectedCmdPrefix, relMd] of [
    ['claude-code', runSetupClaudeCode, CLAUDE_DOCS_URL, 'claude mcp add --scope user', join('.claude', 'CLAUDE.md')],
    ['antigravity', runSetupAntigravity, ANTIGRAVITY_DOCS_URL, 'agy mcp add --header', join('.gemini', 'GEMINI.md')],
  ]) {
    const { home, env } = await newCaseEnv(label, { PATH: emptyBinDir })
    const o1 = makeCaptureStream()
    const e1 = makeCaptureStream()
    const p1 = makePromptScript(['n'])
    const r1 = await fn([], { stdout: o1.stream, stderr: e1.stream, env, home, isTTY: true, promptOverride: p1.promptOverride })
    check(`${label} CLI missing + n: prints masked command + docs link, writes nothing`,
      r1.exitCode === 0 &&
      r1.written.length === 0 &&
      o1.text().includes(expectedCmdPrefix) &&
      o1.text().includes('ml_tok_****') &&
      o1.text().includes(docsUrl) &&
      (await readdir(home)).length === 0)

    const { home: h2, env: env2 } = await newCaseEnv(label, { PATH: emptyBinDir })
    const o2 = makeCaptureStream()
    const e2 = makeCaptureStream()
    const p2 = makePromptScript(['y'])
    const r2 = await fn([], { stdout: o2.stream, stderr: e2.stream, env: env2, home: h2, isTTY: true, promptOverride: p2.promptOverride })
    const md2 = await readFile(join(h2, relMd), 'utf-8').catch(() => '')
    check(`${label} CLI missing + y: writes instruction lines only when user wants them`,
      r2.exitCode === 0 && !r2.connected && r2.written.length === 1 && md2 === `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n`)
  }
}

// ── 5. CLI non-zero exit (no success message, masked stderr) ──────────────────
{
  for (const [label, fn] of [['claude-code', runSetupClaudeCode], ['antigravity', runSetupAntigravity]]) {
    const { home, env } = await newCaseEnv(label, {
      MEGALENS_TOKEN: TOKEN_A,
      STUB_ADD_EXIT: '2',
      STUB_ADD_STDERR: `Auth error for Bearer ${TOKEN_A} at endpoint\n`,
    })
    const out = makeCaptureStream()
    const err = makeCaptureStream()
    const { promptOverride } = makePromptScript(['y'])
    const res = await fn([], { stdout: out.stream, stderr: err.stream, env, home, isTTY: true, promptOverride })
    check(`${label} CLI non-zero exit: exits 1, no success message, stderr token masked`,
      res.exitCode === 1 &&
      !res.connected &&
      !out.text().includes('Connected MegaLens') &&
      !out.text().includes('Restart ') &&
      err.text().includes('ml_tok_****') &&
      !err.text().includes(SECRET_PART_A) &&
      !out.text().includes(SECRET_PART_A))
  }
}

// ── 6. Existing server + replace yes/no ───────────────────────────────────────
{
  // Claude Code: replace no -> skips remove/add, proceeds to CLAUDE.md
  const { home: h1, stubLog: l1, env: e1 } = await newCaseEnv('claude', { STUB_GET_EXIT: '0', MEGALENS_TOKEN: TOKEN_A })
  const o1 = makeCaptureStream()
  const er1 = makeCaptureStream()
  const p1 = makePromptScript(['n', 'n'])
  const r1 = await runSetupClaudeCode([], { stdout: o1.stream, stderr: er1.stream, env: e1, home: h1, isTTY: true, promptOverride: p1.promptOverride })
  const calls1 = await readStubCalls(l1)
  check('claude-code existing server + replace n: only calls get, no remove/add, prompts for CLAUDE.md',
    r1.exitCode === 0 &&
    !r1.connected &&
    calls1.length === 1 &&
    calls1[0].argv[1] === 'get' &&
    p1.prompts.length === 2)

  // Claude Code: replace yes -> remove then add
  const { home: h2, stubLog: l2, env: e2 } = await newCaseEnv('claude', { STUB_GET_EXIT: '0', MEGALENS_TOKEN: TOKEN_B })
  const o2 = makeCaptureStream()
  const er2 = makeCaptureStream()
  const p2 = makePromptScript(['y', 'n'])
  const r2 = await runSetupClaudeCode([], { stdout: o2.stream, stderr: er2.stream, env: e2, home: h2, isTTY: true, promptOverride: p2.promptOverride })
  const calls2 = await readStubCalls(l2)
  check('claude-code existing server + replace y: runs get -> remove --scope user -> add with new token',
    r2.exitCode === 0 &&
    r2.connected === true &&
    calls2.length === 3 &&
    calls2[0].argv.join(' ') === 'mcp get megalens' &&
    calls2[1].argv.join(' ') === 'mcp remove --scope user megalens' &&
    calls2[2].argv[1] === 'add' &&
    calls2[2].argv[9] === `Authorization: Bearer ${TOKEN_B}` &&
    !o2.text().includes(SECRET_PART_B))

  // Claude Code: replace yes -> remove fails -> add NOT called, exits 1, clear .mcp.json message
  const { home: h2b, stubLog: l2b, env: e2b } = await newCaseEnv('claude', {
    STUB_GET_EXIT: '0',
    STUB_REMOVE_EXIT: '1',
    STUB_REMOVE_STDERR: `cannot remove Bearer ${TOKEN_B}\n`,
    MEGALENS_TOKEN: TOKEN_B,
  })
  const o2b = makeCaptureStream()
  const er2b = makeCaptureStream()
  const p2b = makePromptScript(['y'])
  const r2b = await runSetupClaudeCode([], { stdout: o2b.stream, stderr: er2b.stream, env: e2b, home: h2b, isTTY: true, promptOverride: p2b.promptOverride })
  const calls2b = await readStubCalls(l2b)
  check('claude-code existing server + remove fails: exits 1, add not called, clear user-settings/.mcp.json message, stderr masked',
    r2b.exitCode === 1 &&
    !r2b.connected &&
    r2b.written.length === 0 &&
    calls2b.length === 2 &&
    calls2b[1].argv.join(' ') === 'mcp remove --scope user megalens' &&
    er2b.text().includes('user settings') &&
    er2b.text().includes('.mcp.json') &&
    er2b.text().includes('ml_tok_****') &&
    !er2b.text().includes(SECRET_PART_B) &&
    (await readdir(h2b)).length === 0)

  // Antigravity: existing entry in mcp_config.json + replace no
  const { home: h3, stubLog: l3, env: e3 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_A })
  await mkdir(join(h3, '.gemini', 'config'), { recursive: true })
  await writeFile(join(h3, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { megalens: { serverUrl: 'old' } } }))
  const o3 = makeCaptureStream()
  const er3 = makeCaptureStream()
  const p3 = makePromptScript(['n', 'n'])
  const r3 = await runSetupAntigravity([], { stdout: o3.stream, stderr: er3.stream, env: e3, home: h3, isTTY: true, promptOverride: p3.promptOverride })
  const calls3 = await readStubCalls(l3)
  check('antigravity existing server + replace n: runs 0 stub calls and leaves mcp_config.json intact',
    r3.exitCode === 0 && !r3.connected && calls3.length === 0 && p3.prompts.length === 2)

  // Antigravity: existing entry in mcp_config.json + replace yes
  const { home: h4, stubLog: l4, env: e4 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_B })
  await mkdir(join(h4, '.gemini', 'config'), { recursive: true })
  await writeFile(join(h4, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { megalens: { serverUrl: 'old' } } }))
  const o4 = makeCaptureStream()
  const er4 = makeCaptureStream()
  const p4 = makePromptScript(['y', 'n'])
  const r4 = await runSetupAntigravity([], { stdout: o4.stream, stderr: er4.stream, env: e4, home: h4, isTTY: true, promptOverride: p4.promptOverride })
  const calls4 = await readStubCalls(l4)
  check('antigravity existing server + replace y: runs remove then add with new token',
    r4.exitCode === 0 &&
    r4.connected === true &&
    calls4.length === 2 &&
    calls4[0].argv.join(' ') === 'mcp remove megalens' &&
    calls4[1].argv[1] === 'add' &&
    calls4[1].argv[3] === `Authorization: Bearer ${TOKEN_B}` &&
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
  check('Ctrl-C at Consent 1 exits 130 with no stub add and no CLAUDE.md prompt',
    rc.exitCode === 130 &&
    !bufc.includes('CLAUDE.md') &&
    (await readStubCalls(lc)).every((c) => c.argv[1] === 'get'))
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

// ── 15. P2-1: replace remove=0 then add=1 prints recovery instructions ─────────
{
  const { home, stubLog, env } = await newCaseEnv('claude', {
    STUB_GET_EXIT: '0',
    STUB_REMOVE_EXIT: '0',
    STUB_ADD_EXIT: '1',
    MEGALENS_TOKEN: TOKEN_B,
  })
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y'])
  const res = await runSetupClaudeCode([], {
    stdout: out.stream,
    stderr: err.stream,
    env,
    home,
    isTTY: true,
    promptOverride,
  })
  const calls = await readStubCalls(stubLog)
  check('P2-1 claude-code replace remove=0 add=1: exits 1, explains previous entry was removed + masked add command',
    res.exitCode === 1 &&
    !res.connected &&
    calls.length === 3 &&
    err.text().includes('The previous MegaLens entry was removed. To add it again, run:') &&
    err.text().includes('claude mcp add --scope user --transport http megalens') &&
    err.text().includes('ml_tok_****') &&
    !err.text().includes(SECRET_PART_B) &&
    !out.text().includes(SECRET_PART_B))
}

// ── 16. P2-3: timeouts on get/add/remove + progress msg + strip MEGALENS_* ────
{
  // Checking message printed before get + MEGALENS_* stripped from child env
  const { home: h0, stubLog: l0, env: e0 } = await newCaseEnv('claude', {
    MEGALENS_TOKEN: TOKEN_A,
    MEGALENS_CUSTOM_SECRET: 'do-not-pass',
  })
  const o0 = makeCaptureStream()
  const er0 = makeCaptureStream()
  const p0 = makePromptScript(['y', 'n'])
  const r0 = await runSetupClaudeCode([], { stdout: o0.stream, stderr: er0.stream, env: e0, home: h0, isTTY: true, promptOverride: p0.promptOverride })
  const calls0 = await readStubCalls(l0)
  check('P2-3 prints checking message before get and strips all MEGALENS_* from child env',
    r0.exitCode === 0 &&
    o0.text().includes('Checking whether Claude Code already has MegaLens...') &&
    calls0.length === 2 &&
    calls0.every((c) => Array.isArray(c.megalensEnvKeys) && c.megalensEnvKeys.length === 0))

  // Timeout on get -> treated as unknown -> tells user -> asks add question and proceeds on y
  const { home: h1, stubLog: l1, env: e1 } = await newCaseEnv('claude', {
    MEGALENS_TOKEN: TOKEN_A,
    STUB_GET_SLEEP_MS: '5000',
  })
  const o1 = makeCaptureStream()
  const er1 = makeCaptureStream()
  const p1 = makePromptScript(['y', 'n'])
  const r1 = await runSetupClaudeCode([], {
    stdout: o1.stream,
    stderr: er1.stream,
    env: e1,
    home: h1,
    isTTY: true,
    promptOverride: p1.promptOverride,
    cliTimeouts: { get: 100, mutate: 1000 },
  })
  const calls1 = await readStubCalls(l1)
  check('P2-3 timeout on get: tells user, treats as unknown, asks add question and connects on y',
    r1.exitCode === 0 &&
    r1.connected === true &&
    o1.text().toLowerCase().includes('timed out') &&
    o1.text().toLowerCase().includes('unknown') &&
    p1.prompts.some((p) => p.prompt.includes('Add MegaLens to Claude Code? (y/N):')) &&
    calls1.some((c) => c.argv[1] === 'add'))

  // Timeout on add -> exits 1, no success message, prints P1-1 recovery text without token
  const { home: h2, env: e2 } = await newCaseEnv('claude', {
    MEGALENS_TOKEN: TOKEN_A,
    STUB_ADD_SLEEP_MS: '5000',
  })
  const o2 = makeCaptureStream()
  const er2 = makeCaptureStream()
  const p2 = makePromptScript(['y'])
  const r2 = await runSetupClaudeCode([], {
    stdout: o2.stream,
    stderr: er2.stream,
    env: e2,
    home: h2,
    isTTY: true,
    promptOverride: p2.promptOverride,
    cliTimeouts: { get: 1000, mutate: 100 },
  })
  check('P2-3 / P1-1 timeout on add (claude-code): exits 1, recovery path printed, no success message, no token',
    r2.exitCode === 1 &&
    !r2.connected &&
    er2.text().toLowerCase().includes('timed out') &&
    er2.text().includes('This may or may not have finished.') &&
    er2.text().includes('claude mcp get megalens') &&
    er2.text().includes('To add it again, run:') &&
    er2.text().includes('claude mcp add --scope user --transport http megalens') &&
    er2.text().includes('ml_tok_****') &&
    !er2.text().includes(SECRET_PART_A) &&
    !o2.text().includes(SECRET_PART_A) &&
    !o2.text().includes('Connected MegaLens') &&
    !o2.text().includes('Restart Claude Code'))

  // Timeout on remove -> exits 1, add not called, no success message, prints P1-1 recovery text without token
  const { home: h3, stubLog: l3, env: e3 } = await newCaseEnv('claude', {
    MEGALENS_TOKEN: TOKEN_A,
    STUB_GET_EXIT: '0',
    STUB_REMOVE_SLEEP_MS: '5000',
  })
  const o3 = makeCaptureStream()
  const er3 = makeCaptureStream()
  const p3 = makePromptScript(['y'])
  const r3 = await runSetupClaudeCode([], {
    stdout: o3.stream,
    stderr: er3.stream,
    env: e3,
    home: h3,
    isTTY: true,
    promptOverride: p3.promptOverride,
    cliTimeouts: { get: 1000, mutate: 100 },
  })
  const calls3 = await readStubCalls(l3)
  check('P2-3 / P1-1 timeout on remove (claude-code): exits 1, add not called, recovery path printed, no token',
    r3.exitCode === 1 &&
    !r3.connected &&
    calls3.every((c) => c.argv[1] !== 'add') &&
    er3.text().toLowerCase().includes('timed out') &&
    er3.text().includes('This may or may not have finished.') &&
    er3.text().includes('claude mcp get megalens') &&
    er3.text().includes('To add it again, run:') &&
    er3.text().includes('claude mcp add --scope user --transport http megalens') &&
    er3.text().includes('ml_tok_****') &&
    !er3.text().includes(SECRET_PART_A) &&
    !o3.text().includes(SECRET_PART_A) &&
    !o3.text().includes('Connected MegaLens') &&
    !o3.text().includes('Restart Claude Code'))

  // P1-1 Timeout on add & remove for agy
  const { home: h4, env: e4 } = await newCaseEnv('agy', {
    MEGALENS_TOKEN: TOKEN_A,
    STUB_ADD_SLEEP_MS: '5000',
  })
  const o4 = makeCaptureStream()
  const er4 = makeCaptureStream()
  const p4 = makePromptScript(['y'])
  const r4 = await runSetupAntigravity([], {
    stdout: o4.stream,
    stderr: er4.stream,
    env: e4,
    home: h4,
    isTTY: true,
    promptOverride: p4.promptOverride,
    cliTimeouts: { get: 1000, mutate: 100 },
  })
  check('P1-1 timeout on add (agy): exits 1, prints agy mcp list + masked add command, no token',
    r4.exitCode === 1 &&
    !r4.connected &&
    er4.text().includes('This may or may not have finished.') &&
    er4.text().includes('agy mcp list') &&
    er4.text().includes('To add it again, run:') &&
    er4.text().includes('agy mcp add --header') &&
    er4.text().includes('ml_tok_****') &&
    !er4.text().includes(SECRET_PART_A) &&
    !o4.text().includes(SECRET_PART_A))

  const { home: h5, stubLog: l5, env: e5 } = await newCaseEnv('agy', {
    MEGALENS_TOKEN: TOKEN_A,
    STUB_REMOVE_SLEEP_MS: '5000',
  })
  await mkdir(join(h5, '.gemini', 'config'), { recursive: true })
  await writeFile(join(h5, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { megalens: { serverUrl: 'old' } } }))
  const o5 = makeCaptureStream()
  const er5 = makeCaptureStream()
  const p5 = makePromptScript(['y'])
  const r5 = await runSetupAntigravity([], {
    stdout: o5.stream,
    stderr: er5.stream,
    env: e5,
    home: h5,
    isTTY: true,
    promptOverride: p5.promptOverride,
    cliTimeouts: { get: 1000, mutate: 100 },
  })
  const calls5 = await readStubCalls(l5)
  check('P1-1 timeout on remove (agy): exits 1, add not called, prints agy mcp list + masked add command, no token',
    r5.exitCode === 1 &&
    !r5.connected &&
    calls5.every((c) => c.argv[1] !== 'add') &&
    er5.text().includes('This may or may not have finished.') &&
    er5.text().includes('agy mcp list') &&
    er5.text().includes('To add it again, run:') &&
    er5.text().includes('agy mcp add --header') &&
    er5.text().includes('ml_tok_****') &&
    !er5.text().includes(SECRET_PART_A) &&
    !o5.text().includes(SECRET_PART_A))
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
    !p1.prompts.some((p) => p.prompt.includes('Replace existing')) &&
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
    p2.prompts.some((p) => p.prompt.includes('Replace existing MegaLens MCP server in Antigravity? (y/N):')))
}

// ── 18. P3: dry-run previews, --remove-line --dry-run, dangling symlink ───────
{
  // setup claude-code --dry-run mentions "would check for an existing server"
  const { home: h1, stubLog: l1, env: e1 } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const o1 = makeCaptureStream()
  const er1 = makeCaptureStream()
  const p1 = makePromptScript(['n', 'n'])
  const r1 = await runSetupClaudeCode(['--dry-run'], { stdout: o1.stream, stderr: er1.stream, env: e1, home: h1, isTTY: true, promptOverride: p1.promptOverride })
  check('P3 setup claude-code --dry-run preview says would check for an existing server',
    r1.exitCode === 0 &&
    r1.dryRun === true &&
    (await readStubCalls(l1)).length === 0 &&
    o1.text().includes('would check for an existing server'))

  // replace + --dry-run (antigravity)
  const { home: h2, stubLog: l2, env: e2 } = await newCaseEnv('agy', { MEGALENS_TOKEN: TOKEN_B })
  await mkdir(join(h2, '.gemini', 'config'), { recursive: true })
  const cfgPath2 = join(h2, '.gemini', 'config', 'mcp_config.json')
  const cfgContent2 = JSON.stringify({ mcpServers: { megalens: { serverUrl: 'old' } } })
  await writeFile(cfgPath2, cfgContent2)
  const o2 = makeCaptureStream()
  const er2 = makeCaptureStream()
  const p2 = makePromptScript(['y', 'n'])
  const r2 = await runSetupAntigravity(['--dry-run'], { stdout: o2.stream, stderr: er2.stream, env: e2, home: h2, isTTY: true, promptOverride: p2.promptOverride })
  check('P3 replace + --dry-run: exits 0, runs 0 stub calls, previews remove and masked add',
    r2.exitCode === 0 &&
    r2.dryRun === true &&
    !r2.connected &&
    (await readStubCalls(l2)).length === 0 &&
    (await readFile(cfgPath2, 'utf-8')) === cfgContent2 &&
    o2.text().includes('[dry-run] Would run: agy mcp remove megalens') &&
    o2.text().includes('[dry-run] Would run: agy mcp add') &&
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

  // P2-1: bash wrapper running `sleep 40` as a grandchild is killed with process group on get timeout
  const { dir: dPg, home: hPg, env: ePg } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const pgBinDir = join(dPg, 'pg-bin')
  await mkdir(pgBinDir, { recursive: true })
  const pgClaude = join(pgBinDir, 'claude')
  await writeFile(pgClaude, '#!/usr/bin/env bash\nsleep 40\n', { mode: 0o755 })
  await chmod(pgClaude, 0o755)
  const oPg = makeCaptureStream()
  const erPg = makeCaptureStream()
  const pPg = makePromptScript(['n', 'n'])
  const t0 = Date.now()
  const rPg = await runSetupClaudeCode([], {
    stdout: oPg.stream,
    stderr: erPg.stream,
    env: { ...ePg, PATH: `${pgBinDir}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}` },
    home: hPg,
    isTTY: true,
    promptOverride: pPg.promptOverride,
    cliTimeouts: { get: 200, mutate: 1000 },
  })
  const elapsedPg = Date.now() - t0
  check('P2-1 bash stub with sleep 40 grandchild: get timeout fires within ~timeout+3s',
    rPg.exitCode === 0 &&
    elapsedPg < 3200 &&
    oPg.text().toLowerCase().includes('timed out') &&
    oPg.text().toLowerCase().includes('unknown'))

  // P2-2: token prompt runs BEFORE `claude mcp get` and BEFORE reading agy config
  const { home: hOrd, stubLog: lOrd, env: eOrd } = await newCaseEnv('claude')
  const oOrd = makeCaptureStream()
  const erOrd = makeCaptureStream()
  let plainIdx = 0
  const plainAnswers = ['n', 'n']
  const rOrd = await runSetupClaudeCode([], {
    stdout: oOrd.stream,
    stderr: erOrd.stream,
    env: eOrd,
    home: hOrd,
    isTTY: true,
    promptOverride: {
      async askHidden() {
        await appendFile(lOrd, JSON.stringify({ event: 'askHidden' }) + '\n', 'utf-8')
        return TOKEN_A
      },
      async askPlain() {
        return plainAnswers[plainIdx++]
      },
    },
  })
  const ordEvents = await readStubCalls(lOrd)
  check('P2-2 token prompt runs BEFORE claude mcp get',
    rOrd.exitCode === 0 &&
    ordEvents.length >= 2 &&
    ordEvents[0].event === 'askHidden' &&
    ordEvents[1].bin === 'claude' &&
    ordEvents[1].argv.join(' ') === 'mcp get megalens')

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

  // P2-3: CLAUDE_CONFIG_DIR honoured for setup and --remove-line
  const { dir: dCfg, home: hCfg, env: eCfg } = await newCaseEnv('claude', { MEGALENS_TOKEN: TOKEN_A })
  const customClaudeDir = join(dCfg, 'custom-claude-cfg')
  const customClaudeMd = join(customClaudeDir, 'CLAUDE.md')
  const defaultClaudeMd = join(hCfg, '.claude', 'CLAUDE.md')
  const oCfg1 = makeCaptureStream()
  const erCfg1 = makeCaptureStream()
  const pCfg1 = makePromptScript(['n', 'y'])
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
  check('P2-3 CLAUDE_CONFIG_DIR honoured in setup: writes $CLAUDE_CONFIG_DIR/CLAUDE.md',
    rCfg1.exitCode === 0 &&
    rCfg1.written.includes(customClaudeMd) &&
    (await readFile(customClaudeMd, 'utf-8')) === `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n` &&
    !defaultExistsAfterSetup)

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

  // P2-4: existing project/local-scoped megalens entry -> continues to CLAUDE.md, exits 0 on decline and accept
  for (const [label, lineAnswer, expectWritten] of [
    ['declines CLAUDE.md', 'n', false],
    ['completes CLAUDE.md', 'y', true],
  ]) {
    const { home: hProj, stubLog: lProj, env: eProj } = await newCaseEnv('claude', {
      MEGALENS_TOKEN: TOKEN_B,
      STUB_GET_EXIT: '0',
      STUB_REMOVE_EXIT: '1',
      STUB_REMOVE_STDERR: 'No MCP server named "megalens" in user scope\n',
    })
    const oProj = makeCaptureStream()
    const erProj = makeCaptureStream()
    const pProj = makePromptScript(['y', lineAnswer])
    const rProj = await runSetupClaudeCode([], {
      stdout: oProj.stream,
      stderr: erProj.stream,
      env: eProj,
      home: hProj,
      isTTY: true,
      promptOverride: pProj.promptOverride,
      now: () => new Date('2026-11-16T12:00:00.000Z'),
    })
    const callsProj = await readStubCalls(lProj)
    const mdPathProj = join(hProj, '.claude', 'CLAUDE.md')
    const mdWritten = expectWritten
      ? (await readFile(mdPathProj, 'utf-8').catch(() => '')) === `${MEGALENS_REVIEW_LINE}\n${DECISION_LINE}\n`
      : !(await stat(mdPathProj).then(() => true, () => false))
    check(`P2-4 project/local-scoped megalens entry (${label}): continues to CLAUDE.md and exits 0`,
      rProj.exitCode === 0 &&
      !rProj.connected &&
      callsProj.length === 2 &&
      callsProj.every((c) => c.argv[1] !== 'add') &&
      oProj.text().includes("this folder's project settings") &&
      oProj.text().includes('Nothing was changed') &&
      oProj.text().includes('another folder') &&
      pProj.prompts.some((p) => p.prompt.includes('CLAUDE.md')) &&
      mdWritten)
  }

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
    !pAgyK.prompts.some((p) => p.prompt.includes('Replace existing')) &&
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

await rm(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
