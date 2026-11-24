/**
 * Tests for `megalens-mcp setup codex` (`bin/codex-setup.mjs` & `bin/cli.mjs`).
 */
import { readFile, writeFile, mkdir, rm, readdir, stat, chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import {
  CODEX_AGENTS_LINE,
  DECISION_LINE,
  DECISION_LINE_V1,
  FINAL_MESSAGE,
  hasMegaLensAgentsLine,
  hasMegaLensDecisionLine,
  hasMegaLensDecisionV1Line,
  getMissingInstructionLines,
  runSetupCodex as rawRunSetupCodex,
} from '../bin/codex-setup.mjs'
import { planInstructionLineUpdates } from '../bin/setup-shared.mjs'
import { DECISION_LINE_V2, MEGALENS_REVIEW_LINE_V1 } from '../bin/review-guidance.mjs'

const okDefaultValidator = async () => ({ ok: true, isPro: false, isPayg: true, planCode: 'test', label: 'default' })
const runSetupCodex = (args = [], io = {}) => rawRunSetupCodex(args, { validateToken: okDefaultValidator, ...io })

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'cli.mjs')
const cliSrc = await readFile(CLI, 'utf-8')

const pick = (name) => {
  const i = cliSrc.indexOf(`function ${name}(`)
  if (i === -1) throw new Error(`not found: ${name}`)
  let depth = 0
  const j = cliSrc.indexOf('{', i)
  for (let k = j; k < cliSrc.length; k++) {
    if (cliSrc[k] === '{') depth++
    else if (cliSrc[k] === '}') {
      depth--
      if (depth === 0) return cliSrc.slice(i, k + 1)
    }
  }
  throw new Error(`unterminated: ${name}`)
}

const tomlMod = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [pick('scanTomlLine'), pick('tomlHeaderPath'), pick('stripTomlTable')].join('\n') +
        '\nexport { scanTomlLine, tomlHeaderPath, stripTomlTable }',
    ),
)
const tomlHelpers = {
  scanTomlLine: tomlMod.scanTomlLine,
  tomlHeaderPath: tomlMod.tomlHeaderPath,
  stripTomlTable: tomlMod.stripTomlTable,
}

const TOKEN_A = 'ml_tok_0123456789abcdef0123456789abcdef'
const TOKEN_B = 'ml_tok_fedcba9876543210fedcba9876543210'
const SECRET_PART_A = TOKEN_A.slice('ml_tok_'.length)
const SECRET_PART_B = TOKEN_B.slice('ml_tok_'.length)

const root = join(tmpdir(), `megalens-codex-setup-${process.pid}`)
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })

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

function makeFakeTTYStdin(chunks) {
  const pt = new PassThrough()
  pt.isTTY = true
  pt.setRawMode = () => {}
  let idx = 0
  const sendNext = () => {
    if (idx < chunks.length) {
      const c = chunks[idx++]
      setImmediate(() => {
        pt.write(c)
        sendNext()
      })
    }
  }
  setImmediate(sendNext)
  return pt
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
async function newHome(useDefaultHome = false) {
  const dir = join(root, `case-${++caseIdx}`)
  await mkdir(dir, { recursive: true })
  if (useDefaultHome) {
    return { home: dir, codexHome: join(dir, '.codex'), env: {} }
  }
  const codexHome = join(dir, 'custom-codex')
  return { home: dir, codexHome, env: { CODEX_HOME: codexHome } }
}

// ── 1. Fresh home (using ~/.codex fallback, hidden prompt + y/y) ──────────────
{
  const { home, codexHome, env } = await newHome(true)
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { prompts, promptOverride } = makePromptScript(['y', 'y'], TOKEN_A)

  const res = await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env,
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  })

  const configPath = join(codexHome, 'config.toml')
  const agentsPath = join(codexHome, 'AGENTS.md')
  const configText = await readFile(configPath, 'utf-8')
  const agentsText = await readFile(agentsPath, 'utf-8')
  const configMode = (await stat(configPath)).mode & 0o777
  const files = await readdir(codexHome)

  check('fresh home exits 0', res.exitCode === 0)
  check('fresh home prompts for Add MegaLens to Codex? (y/n)',
    prompts.some((p) => p.prompt.includes('Add MegaLens to Codex? (y/n)')))
  check('fresh home prompts for AGENTS.md with exact path',
    prompts.some((p) => p.prompt.includes(`Add these lines to ${agentsPath} so Codex offers a MegaLens review at the right moments? (y/N)`)))
  check('fresh home writes config.toml with ?ide=codex and Bearer token',
    configText.includes('[mcp_servers.megalens]') &&
    configText.includes('url = "https://megalens.ai/api/mcp?ide=codex"') &&
    configText.includes(`http_headers = { "Authorization" = "Bearer ${TOKEN_A}" }`))
  check('fresh home sets 0600 on new config.toml', configMode === 0o600, `got ${configMode.toString(8)}`)
  check('fresh home creates AGENTS.md with both exact lines',
    agentsText === `${CODEX_AGENTS_LINE}\n${DECISION_LINE}\n`)
  check('fresh home creates no backups when files did not exist',
    !files.some((f) => f.includes('.bak-')))
  check('fresh home final message matches spec', out.text().includes(FINAL_MESSAGE))
  check('fresh home never echoes token',
    !out.text().includes(TOKEN_A) && !out.text().includes(SECRET_PART_A) && !err.text().includes(SECRET_PART_A))
}

// ── 2. Raw TTY hidden input (char-by-char + backspace, never echoes) ─────────
{
  const { home, codexHome, env } = await newHome(false)
  const pt = new PassThrough()
  pt.isTTY = true
  pt.setRawMode = () => {}
  let outBuf = ''
  let sentConfigAnswer = false
  let sentAgentsAnswer = false
  const outStream = {
    write(chunk) {
      outBuf += String(chunk)
      if (!sentConfigAnswer && outBuf.includes('Add MegaLens to Codex? (y/n):')) {
        sentConfigAnswer = true
        setImmediate(() => pt.write('y\n'))
      }
      if (!sentAgentsAnswer && outBuf.includes('so Codex offers a MegaLens review at the right moments? (y/N):')) {
        sentAgentsAnswer = true
        setImmediate(() => pt.write('y\n'))
      }
      return true
    },
  }
  const err = makeCaptureStream()
  // Type wrong char 'z', backspace '\x7f', then rest of TOKEN_A, Enter
  setImmediate(() => {
    pt.write(TOKEN_A.slice(0, 10) + 'z\x7f' + TOKEN_A.slice(10) + '\r')
  })

  const res = await runSetupCodex([], {
    stdin: pt,
    stdout: outStream,
    stderr: err.stream,
    env,
    home,
    isTTY: true,
    tomlHelpers,
  })

  const configText = await readFile(join(codexHome, 'config.toml'), 'utf-8')
  check('raw TTY hidden input writes exact token after backspace',
    res.exitCode === 0 && configText.includes(`Bearer ${TOKEN_A}`))
  check('raw TTY hidden input never echoes token',
    !outBuf.includes(TOKEN_A) && !outBuf.includes(SECRET_PART_A))
}

// ── 3. Existing config without megalens + backup + tightened to 0600 ─────────
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  await writeFile(configPath, 'model = "o3"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n', { mode: 0o640 })
  await chmod(configPath, 0o640)

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y', 'n'])

  const res = await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
    now: () => new Date('2026-11-16T12:01:00.000Z'),
  })

  const updated = await readFile(configPath, 'utf-8')
  const mode = (await stat(configPath)).mode & 0o777
  const files = await readdir(codexHome)
  const backup = files.find((f) => f.startsWith('config.toml.bak-'))

  check('existing config without megalens appends cleanly',
    res.exitCode === 0 &&
    updated.includes('model = "o3"') &&
    updated.includes('[mcp_servers.other]') &&
    updated.includes(`Bearer ${TOKEN_A}`))
  check('existing config tightens file mode to 0600 when token is written', mode === 0o600, `got ${mode.toString(8)}`)
  check('existing config backup created with original content',
    Boolean(backup) && (await readFile(join(codexHome, backup), 'utf-8')).includes('model = "o3"') && !(await readFile(join(codexHome, backup), 'utf-8')).includes('megalens'))
  check('answering n to AGENTS.md does not create AGENTS.md', !files.includes('AGENTS.md'))
  check('MEGALENS_TOKEN never echoed', !out.text().includes(TOKEN_A) && !out.text().includes(SECRET_PART_A))
}

// ── 4. Existing megalens entry: leaves it alone without --replace-token ──────
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const initial = `[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN_A}" }\n`
  await writeFile(configPath, initial)

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['n'])

  const res = await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env,
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
  })

  const after = await readFile(configPath, 'utf-8')
  const files = await readdir(codexHome)
  check('existing megalens entry left unchanged', res.exitCode === 0 && after === initial)
  check('existing megalens entry mentions --replace-token', out.text().includes('--replace-token'))
  check('existing megalens entry creates no backup when untouched', !files.some((f) => f.includes('.bak-')))
}

// ── 5. Existing megalens entry with --replace-token ──────────────────────────
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const initial = `model = "gpt-5"\n\n[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN_A}" }\n\n[after]\nk = 1\n`
  await writeFile(configPath, initial)

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y', 'n'])

  const res = await runSetupCodex(['--replace-token'], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_B },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
    now: () => new Date('2026-11-16T12:02:00.000Z'),
  })

  const after = await readFile(configPath, 'utf-8')
  const files = await readdir(codexHome)
  const backup = files.find((f) => f.startsWith('config.toml.bak-'))
  check('--replace-token updates token and keeps surrounding tables',
    res.exitCode === 0 &&
    after.includes('model = "gpt-5"') &&
    after.includes('[after]') &&
    after.includes(TOKEN_B) &&
    !after.includes(TOKEN_A))
  check('--replace-token creates backup of old config',
    Boolean(backup) && (await readFile(join(codexHome, backup), 'utf-8')).includes(TOKEN_A))
  check('--replace-token never echoes new token', !out.text().includes(SECRET_PART_B))
}

// ── 5b. --replace-token on an entry for another server: the URL becomes production too (FIX 15) ──
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const initial = `[mcp_servers.megalens]\nurl = "https://staging.example/api/mcp?ide=codex&k=STAGINGSECRET"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN_A}" }\n`
  await writeFile(configPath, initial)
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y', 'n'])
  const res = await runSetupCodex(['--replace-token'], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_B },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
    now: () => new Date('2026-11-16T12:03:00.000Z'),
  })
  const after = await readFile(configPath, 'utf-8')
  check('--replace-token on a staging entry writes the production URL with the new token',
    res.exitCode === 0 &&
    after.includes('url = "https://megalens.ai/api/mcp?ide=codex"') &&
    !after.includes('staging.example') &&
    after.includes(TOKEN_B) &&
    !after.includes(TOKEN_A))
  check('--replace-token never prints the old URL', !out.text().includes('STAGINGSECRET') && !err.text().includes('STAGINGSECRET'))
}

// ── 6. AGENTS.md exists with / without MegaLens line (idempotent + backup) ───
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const agentsPath = join(codexHome, 'AGENTS.md')
  await writeFile(agentsPath, '# Global rules\nAlways run tests.\n', { mode: 0o644 })
  await chmod(agentsPath, 0o644)

  const out1 = makeCaptureStream()
  const err1 = makeCaptureStream()
  const p1 = makePromptScript(['n', 'y'])
  await runSetupCodex([], {
    stdout: out1.stream,
    stderr: err1.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride: p1.promptOverride,
    now: () => new Date('2026-11-16T12:03:00.000Z'),
  })

  const afterFirst = await readFile(agentsPath, 'utf-8')
  const modeAfter = (await stat(agentsPath)).mode & 0o777
  const filesAfter = await readdir(codexHome)
  const agentsBackup = filesAfter.find((f) => f.startsWith('AGENTS.md.bak-'))

  check('AGENTS.md without lines appends both exact lines',
    afterFirst.includes('# Global rules') &&
    afterFirst.includes(CODEX_AGENTS_LINE) &&
    afterFirst.includes(DECISION_LINE))
  check('AGENTS.md preserves mode 0644', modeAfter === 0o644, `got ${modeAfter.toString(8)}`)
  check('AGENTS.md backup created before edit', Boolean(agentsBackup))

  // Second run: AGENTS.md already has both MegaLens lines -> idempotent, no prompt, no second append
  const out2 = makeCaptureStream()
  const err2 = makeCaptureStream()
  const p2 = makePromptScript(['n'])
  await runSetupCodex([], {
    stdout: out2.stream,
    stderr: err2.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride: p2.promptOverride,
    now: () => new Date('2026-11-16T12:04:00.000Z'),
  })

  const afterSecond = await readFile(agentsPath, 'utf-8')
  const matches1 = afterSecond.split(CODEX_AGENTS_LINE).length - 1
  const matches2 = afterSecond.split(DECISION_LINE).length - 1
  check('AGENTS.md with both MegaLens lines is idempotent (only 1 prompt for config, 1 of each line total)',
    afterSecond === afterFirst &&
    matches1 === 1 &&
    matches2 === 1 &&
    p2.prompts.length === 1 &&
    out2.text().includes('already has the MegaLens lines. Leaving it unchanged.'))
}

// ── 7. Answering n (or empty Enter) at each prompt writes nothing ────────────
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const agentsPath = join(codexHome, 'AGENTS.md')
  await writeFile(configPath, 'model = "o3"\n')
  await writeFile(agentsPath, '# Existing\n')

  for (const ans of [['n', 'n'], ['', '']]) {
    const out = makeCaptureStream()
    const err = makeCaptureStream()
    const { promptOverride } = makePromptScript(ans)
    await runSetupCodex([], {
      stdout: out.stream,
      stderr: err.stream,
      env: { ...env, MEGALENS_TOKEN: TOKEN_A },
      home,
      isTTY: true,
      tomlHelpers,
      promptOverride,
    })
  }

  const files = await readdir(codexHome)
  check('answering n or empty writes nothing and creates no backups',
    (await readFile(configPath, 'utf-8')) === 'model = "o3"\n' &&
    (await readFile(agentsPath, 'utf-8')) === '# Existing\n' &&
    !files.some((f) => f.includes('.bak-')))
}

// ── 8. No TTY (both direct and spawned CLI) writes nothing ───────────────────
{
  const { home, codexHome, env } = await newHome(false)
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const res = await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: false,
    tomlHelpers,
  })
  let exists = true
  try { await stat(codexHome) } catch { exists = false }
  check('no TTY direct: exits 0, creates nothing', res.exitCode === 0 && !exists)
  check('no TTY direct: prints both blocks and manual steps without token',
    out.text().includes('[mcp_servers.megalens]') &&
    out.text().includes('Add these lines to') &&
    out.text().includes(CODEX_AGENTS_LINE) &&
    out.text().includes(DECISION_LINE) &&
    !out.text().includes(SECRET_PART_A))

  const cliRun = spawnSync(process.execPath, [CLI, 'setup', 'codex'], {
    env: { ...process.env, CODEX_HOME: codexHome, MEGALENS_TOKEN: TOKEN_A },
    input: 'y\ny\n',
    encoding: 'utf-8',
  })
  let existsAfterCli = true
  try { await stat(codexHome) } catch { existsAfterCli = false }
  check('no TTY CLI child: exits 0, writes nothing, never echoes token',
    cliRun.status === 0 &&
    !existsAfterCli &&
    cliRun.stdout.includes('[mcp_servers.megalens]') &&
    cliRun.stdout.includes(CODEX_AGENTS_LINE) &&
    cliRun.stdout.includes(DECISION_LINE) &&
    !cliRun.stdout.includes(SECRET_PART_A))
}

// ── 9. --dry-run writes nothing even when answering y ────────────────────────
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  await writeFile(configPath, 'model = "o3"\n')

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y', 'y'])
  const res = await runSetupCodex(['--dry-run'], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
  })

  const files = await readdir(codexHome)
  check('--dry-run writes nothing, creates no backup, no AGENTS.md',
    res.exitCode === 0 &&
    (await readFile(configPath, 'utf-8')) === 'model = "o3"\n' &&
    files.length === 1 &&
    out.text().includes('[dry-run]') &&
    !out.text().includes(SECRET_PART_A))
}

// ── 10. Windows CRLF files preserved ─────────────────────────────────────────
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const agentsPath = join(codexHome, 'AGENTS.md')
  await writeFile(configPath, 'model = "o3"\r\n[other]\r\nk = 1\r\n')
  await writeFile(agentsPath, '# Rules\r\nBe careful.\r\n')

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y', 'y'])
  await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
  })

  const nextConfig = await readFile(configPath, 'utf-8')
  const nextAgents = await readFile(agentsPath, 'utf-8')
  const hasLoneLf = (s) => /[^\r]\n/.test(s) || s.startsWith('\n')
  check('CRLF config.toml preserves CRLF on every line',
    nextConfig.includes('\r\n') && !hasLoneLf(nextConfig) && nextConfig.includes(`Bearer ${TOKEN_A}`))
  check('CRLF AGENTS.md preserves CRLF on every line',
    nextAgents.includes('\r\n') &&
    !hasLoneLf(nextAgents) &&
    nextAgents.includes(CODEX_AGENTS_LINE) &&
    nextAgents.includes(DECISION_LINE))
}

// ── 11. Invalid token and --yes flag rejected without leaking secret ─────────
{
  const { home, env } = await newHome(false)
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const badToken = 'ml_tok_nothex_1234567890'
  const resBad = await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: badToken },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride: makePromptScript([]).promptOverride,
  })
  check('invalid token format exits 1 and never echoes invalid token',
    resBad.exitCode === 1 &&
    err.text().includes('ml_tok_ followed by 32 hex characters') &&
    !err.text().includes(badToken) &&
    !out.text().includes(badToken))

  const outYes = makeCaptureStream()
  const errYes = makeCaptureStream()
  const resYes = await runSetupCodex(['--yes'], {
    stdout: outYes.stream,
    stderr: errYes.stream,
    env,
    home,
    isTTY: true,
    tomlHelpers,
  })
  check('--yes is rejected with exit 1', resYes.exitCode === 1 && errYes.text().includes('--yes is not supported'))
}

// ── 12. P1: Existing non-table / inline mcp_servers/megalens forms left untouched ──
{
  const forms = [
    ['[mcp_servers] with inline megalens', '[mcp_servers]\nmegalens = { url = "https://megalens.ai/api/mcp" }\n'],
    ['dotted mcp_servers.megalens.url', 'mcp_servers.megalens.url = "https://megalens.ai/api/mcp"\n'],
    ['inline mcp_servers = { megalens = ... }', 'mcp_servers = { megalens = { url = "https://megalens.ai/api/mcp" } }\n'],
  ]
  for (const [label, initial] of forms) {
    for (const extraArgs of [[], ['--replace-token']]) {
      const { home, codexHome, env } = await newHome(false)
      await mkdir(codexHome, { recursive: true })
      const configPath = join(codexHome, 'config.toml')
      await writeFile(configPath, initial)

      const out = makeCaptureStream()
      const err = makeCaptureStream()
      const { prompts, promptOverride } = makePromptScript(['n'])
      const res = await runSetupCodex(extraArgs, {
        stdout: out.stream,
        stderr: err.stream,
        env: { ...env, MEGALENS_TOKEN: TOKEN_A },
        home,
        isTTY: true,
        tomlHelpers,
        promptOverride,
      })

      const after = await readFile(configPath, 'utf-8')
      const files = await readdir(codexHome)
      const flagLabel = extraArgs.length ? ' (--replace-token)' : ''
      check(`P1 ${label}${flagLabel}: leaves config.toml unchanged, creates no backup, explains manual edit`,
        res.exitCode === 0 &&
        after === initial &&
        !files.some((f) => f.includes('.bak-')) &&
        prompts.length === 1 &&
        out.text().includes('cannot edit safely') &&
        out.text().includes('Leaving config.toml unchanged') &&
        out.text().includes('[mcp_servers.megalens]'))
    }
  }

  // [mcp_servers] with another server (no megalens) and fake string inside """ still proceeds normally
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const benign = 'instructions = """\nmcp_servers.megalens.url = "x"\n"""\n\n[mcp_servers]\nother = { url = "https://other.example/mcp" }\n'
  await writeFile(configPath, benign)

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y', 'n'])
  const res = await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
  })
  const after = await readFile(configPath, 'utf-8')
  check('P1 benign [mcp_servers] other + multiline string still adds [mcp_servers.megalens]',
    res.exitCode === 0 && after.includes('other = { url = "https://other.example/mcp" }') && after.includes(`Bearer ${TOKEN_A}`))
}

// ── 13. P2: --replace-token rewrites/inserts ONLY http_headers, preserves all other settings & subtables ──
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const initial = [
    'model = "gpt-5"',
    '',
    '[mcp_servers.megalens]',
    'url = "https://megalens.ai/api/mcp?ide=codex"',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
    'enabled_tools = ["megalens_debate"]',
    `http_headers = { "Authorization" = "Bearer ${TOKEN_A}" }`,
    '# keep this comment',
    '',
    '[mcp_servers.megalens.env]',
    'MEGALENS_DEBUG = "1"',
    '',
    '[after]',
    'k = 1',
    '',
  ].join('\n')
  await writeFile(configPath, initial)

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y', 'n'])
  const res = await runSetupCodex(['--replace-token'], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_B },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
  })

  const after = await readFile(configPath, 'utf-8')
  const expected = initial.replace(TOKEN_A, TOKEN_B)
  check('P2 --replace-token rewrites ONLY http_headers line and keeps every other key/subtable/comment byte for byte',
    res.exitCode === 0 && after === expected)
  check('P2 --replace-token preview shows exact before/after of http_headers line with masked tokens',
    out.text().includes('- http_headers = { "Authorization" = "Bearer ml_tok_****" }') &&
    out.text().includes('+ http_headers = { "Authorization" = "Bearer ml_tok_****" }') &&
    !out.text().includes(SECRET_PART_A) &&
    !out.text().includes(SECRET_PART_B))

  // Case where http_headers is absent inside [mcp_servers.megalens]
  const { home: home2, codexHome: codexHome2, env: env2 } = await newHome(false)
  await mkdir(codexHome2, { recursive: true })
  const configPath2 = join(codexHome2, 'config.toml')
  const initialNoHdr = [
    '[mcp_servers.megalens]',
    'url = "https://megalens.ai/api/mcp?ide=codex"',
    'startup_timeout_sec = 45',
    '',
    '[mcp_servers.megalens.env]',
    'FOO = "bar"',
    '',
  ].join('\n')
  await writeFile(configPath2, initialNoHdr)

  const out2 = makeCaptureStream()
  const err2 = makeCaptureStream()
  const p2 = makePromptScript(['y', 'n'])
  const res2 = await runSetupCodex(['--replace-token'], {
    stdout: out2.stream,
    stderr: err2.stream,
    env: { ...env2, MEGALENS_TOKEN: TOKEN_B },
    home: home2,
    isTTY: true,
    tomlHelpers,
    promptOverride: p2.promptOverride,
  })

  const after2 = await readFile(configPath2, 'utf-8')
  const expected2 = [
    '[mcp_servers.megalens]',
    'url = "https://megalens.ai/api/mcp?ide=codex"',
    'startup_timeout_sec = 45',
    `http_headers = { "Authorization" = "Bearer ${TOKEN_B}" }`,
    '',
    '[mcp_servers.megalens.env]',
    'FOO = "bar"',
    '',
  ].join('\n')
  check('P2 --replace-token inserts http_headers when absent and keeps surrounding keys & subtable byte for byte',
    res2.exitCode === 0 && after2 === expected2)
  check('P2 --replace-token insert preview shows - (none) and + masked http_headers line',
    out2.text().includes('- (none)') &&
    out2.text().includes('+ http_headers = { "Authorization" = "Bearer ml_tok_****" }') &&
    !out2.text().includes(SECRET_PART_B))
}

// ── 14. P3-1: Ctrl-D (EOF) at y/n prompt resolves as no and exits cleanly ────
{
  const { home, codexHome, env } = await newHome(false)
  let buf = ''
  const stdin = new PassThrough()
  stdin.isTTY = true
  let ended = false
  const outStream = {
    write(chunk) {
      buf += String(chunk)
      if (!ended && buf.includes('Add MegaLens to Codex? (y/n):')) {
        ended = true
        setImmediate(() => stdin.end())
      }
      return true
    },
  }
  const err = makeCaptureStream()

  const res = await runSetupCodex([], {
    stdin,
    stdout: outStream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
  })

  let exists = true
  try { await stat(codexHome) } catch { exists = false }
  check('P3-1 Ctrl-D (EOF) at y/n prompt exits 0 cleanly and writes nothing',
    res.exitCode === 0 && res.written.length === 0 && !exists)
}

// ── 15. P3-2: hasMegaLensAgentsLine ignores unrelated MegaLens notes ─────────
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const agentsPath = join(codexHome, 'AGENTS.md')
  const unrelated = '# Notes\nMegaLens MCP endpoint is https://megalens.ai/api/mcp\n'
  await writeFile(agentsPath, unrelated)

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { prompts, promptOverride } = makePromptScript(['n', 'y'])
  const res = await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
  })

  const after = await readFile(agentsPath, 'utf-8')
  check('P3-2 AGENTS.md with unrelated MegaLens notes still gets the offer and appends both lines on y',
    res.exitCode === 0 &&
    prompts.some((p) => p.prompt.includes('AGENTS.md')) &&
    after.includes(unrelated.trimEnd()) &&
    after.includes(CODEX_AGENTS_LINE) &&
    after.includes(DECISION_LINE))
}

// ── 16. P3-4: read-only config.toml (mode 0444) is refused, writes nothing ───
{
  for (const extraArgs of [[], ['--replace-token']]) {
    const { home, codexHome, env } = await newHome(false)
    await mkdir(codexHome, { recursive: true })
    const configPath = join(codexHome, 'config.toml')
    const initial = extraArgs.length
      ? `[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN_A}" }\n`
      : 'model = "o3"\n'
    await writeFile(configPath, initial, { mode: 0o444 })
    await chmod(configPath, 0o444)

    const out = makeCaptureStream()
    const err = makeCaptureStream()
    const { promptOverride } = makePromptScript(['n'])
    const res = await runSetupCodex(extraArgs, {
      stdout: out.stream,
      stderr: err.stream,
      env: { ...env, MEGALENS_TOKEN: TOKEN_B },
      home,
      isTTY: true,
      tomlHelpers,
      promptOverride,
    })

    const after = await readFile(configPath, 'utf-8')
    const files = await readdir(codexHome)
    await chmod(configPath, 0o644)
    const label = extraArgs.length ? ' (--replace-token)' : ''
    check(`P3-4 read-only config.toml (0444)${label}: refuses to replace, prints why, writes nothing`,
      res.exitCode === 0 &&
      after === initial &&
      res.written.length === 0 &&
      !files.some((f) => f.includes('.bak-')) &&
      out.text().includes('read-only') &&
      out.text().includes('0444'))
  }
}

// ── 17. Fable P1-1 (a-d) + P2-4: uneditable TOML forms left untouched ──────────
{
  const fableCases = [
    [
      'P1-1a dotted http_headers.Authorization (--replace-token)',
      ['--replace-token'],
      `[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\nhttp_headers.Authorization = "Bearer ${TOKEN_A}"\n`,
    ],
    [
      'P1-1b quoted "http_headers" = { ... } (--replace-token)',
      ['--replace-token'],
      `[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\n"http_headers" = { "Authorization" = "Bearer ${TOKEN_A}" }\n`,
    ],
    [
      'P1-1c stdio entry with command/args (--replace-token)',
      ['--replace-token'],
      '[mcp_servers.megalens]\ncommand = "npx"\nargs = ["-y", "megalens-mcp"]\n',
    ],
    [
      'P1-1d quoted root "mcp_servers".megalens.url (default)',
      [],
      '"mcp_servers".megalens.url = "https://megalens.ai/api/mcp?ide=codex"\n',
    ],
    [
      'P1-1/P2-4 http_headers with extra header X-Team (--replace-token)',
      ['--replace-token'],
      `[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN_A}", "X-Team" = "secretteamkey" }\n`,
    ],
    [
      'P1-1 [mcp_servers.megalens] without url (--replace-token)',
      ['--replace-token'],
      '[mcp_servers.megalens]\nstartup_timeout_sec = 30\n',
    ],
  ]

  for (const [label, extraArgs, initial] of fableCases) {
    const { home, codexHome, env } = await newHome(false)
    await mkdir(codexHome, { recursive: true })
    const configPath = join(codexHome, 'config.toml')
    await writeFile(configPath, initial)

    const out = makeCaptureStream()
    const err = makeCaptureStream()
    const { prompts, promptOverride } = makePromptScript(['n'])
    const res = await runSetupCodex(extraArgs, {
      stdout: out.stream,
      stderr: err.stream,
      env: { ...env, MEGALENS_TOKEN: TOKEN_B },
      home,
      isTTY: true,
      tomlHelpers,
      promptOverride,
    })

    const after = await readFile(configPath, 'utf-8')
    const files = await readdir(codexHome)
    check(`${label}: marked uneditable, unchanged, no backup, no secret leak`,
      res.exitCode === 0 &&
      after === initial &&
      res.written.length === 0 &&
      !files.some((f) => f.includes('.bak-')) &&
      prompts.length === 1 &&
      out.text().includes('cannot edit safely') &&
      out.text().includes('Leaving config.toml unchanged') &&
      !out.text().includes('secretteamkey') &&
      !out.text().includes(SECRET_PART_B))
  }
}

// ── 18. Fable P2-1: type-ahead 'y\r' before prompt is discarded ──────────────
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  await writeFile(configPath, 'model = "o3"\n')

  const pt = new PassThrough()
  pt.isTTY = true
  pt.setRawMode = () => {}
  // Send type-ahead 'y\r' immediately at spawn before any prompt is printed
  pt.write('y\r')

  let buf = ''
  let n1 = false
  let n2 = false
  const outStream = {
    write(chunk) {
      buf += String(chunk)
      if (!n1 && buf.includes('Add MegaLens to Codex? (y/n):')) {
        n1 = true
        setImmediate(() => pt.write('n\r'))
      }
      if (!n2 && buf.includes('so Codex offers a MegaLens review at the right moments? (y/N):')) {
        n2 = true
        setImmediate(() => pt.write('n\r'))
      }
      return true
    },
  }
  const err = makeCaptureStream()

  const res = await runSetupCodex([], {
    stdin: pt,
    stdout: outStream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
  })

  const after = await readFile(configPath, 'utf-8')
  const files = await readdir(codexHome)
  check('P2-1 type-ahead y\\r sent before prompt is discarded -> nothing written',
    res.exitCode === 0 &&
    res.written.length === 0 &&
    after === 'model = "o3"\n' &&
    !files.includes('AGENTS.md') &&
    !files.some((f) => f.includes('.bak-')))
}

// ── 19. Fable P2-2: Ctrl-C at y/n prompt aborts whole run with exit 130 ──────
{
  const { home, codexHome, env } = await newHome(false)
  const pt = new PassThrough()
  pt.isTTY = true
  pt.setRawMode = () => {}
  let buf = ''
  let sentAbort = false
  const outStream = {
    write(chunk) {
      buf += String(chunk)
      if (!sentAbort && buf.includes('Add MegaLens to Codex? (y/n):')) {
        sentAbort = true
        setImmediate(() => pt.write('\x03'))
      }
      return true
    },
  }
  const err = makeCaptureStream()

  const res = await runSetupCodex([], {
    stdin: pt,
    stdout: outStream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
  })

  let exists = true
  try { await stat(codexHome) } catch { exists = false }
  check('P2-2 Ctrl-C at y/n prompt exits 130 immediately with no further prompts',
    res.exitCode === 130 &&
    res.written.length === 0 &&
    !exists &&
    !buf.includes('Proposed AGENTS.md line') &&
    !buf.includes(FINAL_MESSAGE))
}

// ── 20. Fable P2-3: non-UTF8 files (byte 0xE9) left untouched with message ───
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const agentsPath = join(codexHome, 'AGENTS.md')
  const rawLatin1 = Buffer.from('# caf\xe9 comment\nmodel = "gpt-5"\n', 'latin1')
  const rawAgentsLatin1 = Buffer.from('# R\xe9sum\xe9\n', 'latin1')
  await writeFile(configPath, rawLatin1)
  await writeFile(agentsPath, rawAgentsLatin1)

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { prompts, promptOverride } = makePromptScript([])

  const res = await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
  })

  const afterConfig = await readFile(configPath)
  const afterAgents = await readFile(agentsPath)
  check('P2-3 non-UTF8 (0xE9) config.toml and AGENTS.md left untouched with message',
    res.exitCode === 0 &&
    res.written.length === 0 &&
    prompts.length === 0 &&
    afterConfig.equals(rawLatin1) &&
    afterAgents.equals(rawAgentsLatin1) &&
    err.text().includes('Leaving config.toml untouched') &&
    err.text().includes('Leaving AGENTS.md untouched'))
}

// ── 21. Fable P2-4: preview masks every quoted value ─────────────────────────
{
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  await writeFile(
    configPath,
    '[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\nhttp_headers = { "Authorization" = "custom_opaque_secret_value" }\n',
  )
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['n', 'n'])
  const res = await runSetupCodex(['--replace-token'], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_B },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
  })
  check('P2-4 preview masks non-Bearer quoted value in http_headers',
    res.exitCode === 0 &&
    out.text().includes('- http_headers = { "Authorization" = "****" }') &&
    !out.text().includes('custom_opaque_secret_value'))
}

// ── 22. Fable P3: trailing whitespace, read-only AGENTS.md, AGENTS.override.md, MegaLens case, BOM, write error ──
{
  // Trailing whitespace preserved on config.toml and AGENTS.md
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const agentsPath = join(codexHome, 'AGENTS.md')
  const origConfig = 'model = "gpt-5"   \n\n\n  \t'
  const origAgents = '# Rules   \n\n  \t'
  await writeFile(configPath, origConfig)
  await writeFile(agentsPath, origAgents)

  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y', 'y'])
  const res = await runSetupCodex([], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_A },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
  })

  const afterConfig = await readFile(configPath, 'utf-8')
  const afterAgents = await readFile(agentsPath, 'utf-8')
  check('P3 trailing whitespace preserved as exact prefix on config.toml and AGENTS.md',
    res.exitCode === 0 &&
    afterConfig.startsWith(`${origConfig}\n[mcp_servers.megalens]`) &&
    afterAgents.startsWith(`${origAgents}\n${CODEX_AGENTS_LINE}\n${DECISION_LINE}\n`))

  // Read-only AGENTS.md (0444) refused + AGENTS.override.md note printed
  const { home: home2, codexHome: codexHome2, env: env2 } = await newHome(false)
  await mkdir(codexHome2, { recursive: true })
  const agentsPath2 = join(codexHome2, 'AGENTS.md')
  const overridePath2 = join(codexHome2, 'AGENTS.override.md')
  await writeFile(agentsPath2, '# Read-only\n', { mode: 0o444 })
  await chmod(agentsPath2, 0o444)
  await writeFile(overridePath2, '# Override\n')

  const out2 = makeCaptureStream()
  const err2 = makeCaptureStream()
  const p2 = makePromptScript(['n'])
  const res2 = await runSetupCodex([], {
    stdout: out2.stream,
    stderr: err2.stream,
    env: { ...env2, MEGALENS_TOKEN: TOKEN_A },
    home: home2,
    isTTY: true,
    tomlHelpers,
    promptOverride: p2.promptOverride,
  })
  const afterAgents2 = await readFile(agentsPath2, 'utf-8')
  await chmod(agentsPath2, 0o644)
  check('P3 read-only AGENTS.md refused and AGENTS.override.md note printed',
    res2.exitCode === 0 &&
    afterAgents2 === '# Read-only\n' &&
    out2.text().includes('read-only') &&
    out2.text().includes('AGENTS.override.md'))

  // [mcp_servers.MegaLens] (mixed case) and UTF-8 BOM treated as existing
  for (const [label, content] of [
    ['[mcp_servers.MegaLens] mixed case', '[mcp_servers.MegaLens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\n'],
    ['UTF-8 BOM [mcp_servers.megalens]', '\uFEFF[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\n'],
  ]) {
    const { home: h3, codexHome: ch3, env: e3 } = await newHome(false)
    await mkdir(ch3, { recursive: true })
    const cp3 = join(ch3, 'config.toml')
    await writeFile(cp3, content, 'utf-8')
    const o3 = makeCaptureStream()
    const er3 = makeCaptureStream()
    const p3 = makePromptScript(['n'])
    const r3 = await runSetupCodex([], {
      stdout: o3.stream,
      stderr: er3.stream,
      env: { ...e3, MEGALENS_TOKEN: TOKEN_A },
      home: h3,
      isTTY: true,
      tomlHelpers,
      promptOverride: p3.promptOverride,
    })
    check(`P3 ${label} treated as existing`,
      r3.exitCode === 0 &&
      (await readFile(cp3, 'utf-8')) === content &&
      o3.text().includes('already exists'))
  }

  // Write failure caught: one line, exit 1, no stack (root-proof ENOTDIR on write path)
  const { home: h4 } = await newHome(false)
  const blocker4 = join(h4, 'afile')
  const ch4 = join(blocker4, 'codexhome')
  const o4 = makeCaptureStream()
  const er4 = makeCaptureStream()
  const p4 = makePromptScript(['y'])
  let threw = false
  let r4
  try {
    r4 = await runSetupCodex([], {
      stdout: o4.stream,
      stderr: er4.stream,
      env: { CODEX_HOME: ch4, MEGALENS_TOKEN: TOKEN_A },
      home: h4,
      isTTY: true,
      tomlHelpers,
      promptOverride: {
        askHidden: p4.promptOverride.askHidden,
        async askPlain(prompt) {
          const ans = await p4.promptOverride.askPlain(prompt)
          // Plant regular file after readOptionalFile succeeds (ENOENT) so write mkdir fails with ENOTDIR even as root
          await writeFile(blocker4, 'not a directory\n', 'utf-8')
          return ans
        },
      },
    })
  } catch {
    threw = true
  }
  check('P3 write failure caught: one line on stderr, exit 1, no stack',
    !threw &&
    r4?.exitCode === 1 &&
    er4.text().trim().split('\n').length === 1 &&
    !er4.text().includes('at '))

  // cli.mjs help has no em dash
  const helpRun = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf-8' })
  check('P3 cli.mjs help has no em dash', helpRun.status === 0 && !/[—–]/.test(helpRun.stdout))
}

// ── 23. Two-line detection & partial AGENTS.md states (0.3.9) ────────────────
{
  const legacy = `\uFEFF# Rules\r\n- ${MEGALENS_REVIEW_LINE_V1} ${DECISION_LINE_V2}\r\n${DECISION_LINE_V1}\r\n# Keep this line\r\n`
  const upgraded = planInstructionLineUpdates(legacy)
  check('setup upgrades both shipped offer rules and removes the older decision line',
    upgraded.hasChanges && upgraded.replacements.length === 2 && upgraded.removals.length === 1 &&
    upgraded.nextContent === `\uFEFF# Rules\r\n- ${CODEX_AGENTS_LINE} ${DECISION_LINE}\r\n# Keep this line\r\n` &&
    !planInstructionLineUpdates(upgraded.nextContent).hasChanges)
  check('setup limits offers for both plans and changes, with both opt outs',
    CODEX_AGENTS_LINE.includes('Offer a MegaLens review at most once per task, even if the task has both a plan and code changes.') &&
    CODEX_AGENTS_LINE.includes('Skip the offer if the task came from a MegaLens fix prompt or the user says “just fix it” or otherwise asks you to proceed without a review.') &&
    DECISION_LINE.includes('Follow the same rules for offers and permission.'))

  // Unit checks for separate detection of old vs new line
  check('detection tells old and new lines apart: old only',
    hasMegaLensAgentsLine(`${CODEX_AGENTS_LINE}\r\n`) &&
    !hasMegaLensDecisionLine(`${CODEX_AGENTS_LINE}\r\n`) &&
    getMissingInstructionLines(CODEX_AGENTS_LINE).length === 1 &&
    getMissingInstructionLines(CODEX_AGENTS_LINE)[0] === DECISION_LINE)

  check('detection tells old and new lines apart: new only (must NOT count as old)',
    !hasMegaLensAgentsLine(`${DECISION_LINE}\n`) &&
    hasMegaLensDecisionLine(`  ${DECISION_LINE}\r\n`) &&
    getMissingInstructionLines(DECISION_LINE).length === 1 &&
    getMissingInstructionLines(DECISION_LINE)[0] === CODEX_AGENTS_LINE)

  check('detection matches user-edited variants independently (CR & BOM tolerant)',
    hasMegaLensAgentsLine('\uFEFF- After you change code in billing, always offer a MegaLens review first.\r\n') &&
    !hasMegaLensDecisionLine('\uFEFF- After you change code in billing, always offer a MegaLens review first.\r\n') &&
    hasMegaLensDecisionLine('Before you or the user settle a decision that is hard to undo, ask MegaLens.\r\n') &&
    !hasMegaLensAgentsLine('Before you or the user settle a decision that is hard to undo, ask MegaLens.\r\n') &&
    hasMegaLensDecisionV1Line('When the user is making a decision that is hard to undo, ask MegaLens.\r\n') &&
    !hasMegaLensDecisionLine('When the user is making a decision that is hard to undo, ask MegaLens.\r\n') &&
    !hasMegaLensAgentsLine('When the user is making a decision that is hard to undo, ask MegaLens.\r\n'))

  const editedOldOnly = 'Please Offer a MegaLens review before merge.'
  check('detection restores 0.3.8 broad old-line variant alone -> only NEW line missing',
    hasMegaLensAgentsLine(editedOldOnly) &&
    !hasMegaLensDecisionLine(editedOldOnly) &&
    getMissingInstructionLines(editedOldOnly).length === 1 &&
    getMissingInstructionLines(editedOldOnly)[0] === DECISION_LINE)

  const newVariantWithOffer = 'Before you or the user settle a decision that is hard to undo, offer a MegaLens review once.'
  check('detection new-line variant containing "offer a MegaLens review" alone -> only OLD line missing',
    !hasMegaLensAgentsLine(newVariantWithOffer) &&
    hasMegaLensDecisionLine(newVariantWithOffer) &&
    getMissingInstructionLines(newVariantWithOffer).length === 1 &&
    getMissingInstructionLines(newVariantWithOffer)[0] === CODEX_AGENTS_LINE)

  const editedOldAndNew = `${editedOldOnly}\n${DECISION_LINE}\n`
  check('detection 0.3.8 broad old-line variant + new line -> none missing',
    hasMegaLensAgentsLine(editedOldAndNew) &&
    hasMegaLensDecisionLine(editedOldAndNew) &&
    getMissingInstructionLines(editedOldAndNew).length === 0)

  // Hard-wrapped v2 decision line over two physical lines is NOT read as the CODE line
  const wrappedV2SplitA = [
    'Before you or the user settle a decision that is hard to undo (choosing a database or data model, adding sign-in or payments, picking a major library or architecture),',
    'starting a new project, or doing deep research, offer a MegaLens review once for that task and wait for a yes before running it. Do not offer it for small questions or routine edits.',
  ].join('\n')
  const wrappedV2SplitB = [
    'Before you or the user settle a decision that is hard to undo (choosing a database or data model, adding sign-in or payments, picking a major library or architecture), starting a new project, or doing deep research, offer a MegaLens review',
    'once for that task and wait for a yes before running it. Do not offer it for small questions or routine edits.',
  ].join('\n')
  check('detection hard-wrapped v2 over two physical lines is NOT read as the CODE line',
    !hasMegaLensAgentsLine(wrappedV2SplitA) &&
    !hasMegaLensAgentsLine(wrappedV2SplitB) &&
    getMissingInstructionLines(wrappedV2SplitA).includes(CODEX_AGENTS_LINE) &&
    getMissingInstructionLines(wrappedV2SplitB).includes(CODEX_AGENTS_LINE))

  // Old-only AGENTS.md -> adds only new line, leaves old untouched
  const { home: h1, codexHome: ch1, env: e1 } = await newHome(false)
  await mkdir(ch1, { recursive: true })
  const ap1 = join(ch1, 'AGENTS.md')
  const oldOnly = `# Rules\n${CODEX_AGENTS_LINE}\n`
  await writeFile(ap1, oldOnly)
  const o1 = makeCaptureStream()
  const p1 = makePromptScript(['n', 'y'])
  const r1 = await runSetupCodex([], {
    stdout: o1.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e1, MEGALENS_TOKEN: TOKEN_A },
    home: h1,
    isTTY: true,
    tomlHelpers,
    promptOverride: p1.promptOverride,
    now: () => new Date('2026-11-16T12:05:00.000Z'),
  })
  const after1 = await readFile(ap1, 'utf-8')
  check('codex old-only AGENTS.md -> adds only new line, leaves old untouched',
    r1.exitCode === 0 &&
    after1 === `${oldOnly}${DECISION_LINE}\n` &&
    o1.text().includes(`Proposed AGENTS.md line (${ap1}):`) &&
    o1.text().includes(DECISION_LINE) &&
    !o1.text().includes(CODEX_AGENTS_LINE) &&
    p1.prompts.some((p) => p.prompt.includes('Add this line to')))

  // Variant of old line + no new -> adds only new line, leaves variant untouched
  const { home: h2, codexHome: ch2, env: e2 } = await newHome(false)
  await mkdir(ch2, { recursive: true })
  const ap2 = join(ch2, 'AGENTS.md')
  const oldVariant = '# Rules\nAfter you change code for payments or auth, offer a MegaLens review first.\n'
  await writeFile(ap2, oldVariant)
  const o2 = makeCaptureStream()
  const p2 = makePromptScript(['n', 'y'])
  const r2 = await runSetupCodex([], {
    stdout: o2.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e2, MEGALENS_TOKEN: TOKEN_A },
    home: h2,
    isTTY: true,
    tomlHelpers,
    promptOverride: p2.promptOverride,
    now: () => new Date('2026-11-16T12:06:00.000Z'),
  })
  check('codex variant of old line + no new -> adds only new line, variant untouched',
    r2.exitCode === 0 &&
    (await readFile(ap2, 'utf-8')) === `${oldVariant}${DECISION_LINE}\n`)

  // New-only AGENTS.md -> adds only old line, leaves new untouched
  const { home: h3, codexHome: ch3, env: e3 } = await newHome(false)
  await mkdir(ch3, { recursive: true })
  const ap3 = join(ch3, 'AGENTS.md')
  const newOnly = `# Rules\n${DECISION_LINE}\n`
  await writeFile(ap3, newOnly)
  const o3 = makeCaptureStream()
  const p3 = makePromptScript(['n', 'y'])
  const r3 = await runSetupCodex([], {
    stdout: o3.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e3, MEGALENS_TOKEN: TOKEN_A },
    home: h3,
    isTTY: true,
    tomlHelpers,
    promptOverride: p3.promptOverride,
    now: () => new Date('2026-11-16T12:07:00.000Z'),
  })
  check('codex new-only AGENTS.md -> adds only old line, new untouched',
    r3.exitCode === 0 &&
    (await readFile(ap3, 'utf-8')) === `${newOnly}${CODEX_AGENTS_LINE}\n`)

  // Both present (variant of old + variant of v2) -> no prompt, no change, no backup
  const { home: h4, codexHome: ch4, env: e4 } = await newHome(false)
  await mkdir(ch4, { recursive: true })
  const ap4 = join(ch4, 'AGENTS.md')
  const bothVariants = [
    '# Rules',
    'After you change code touching billing, offer a MegaLens review.',
    'Before you or the user settle a decision that is hard to undo, ask MegaLens.',
    '',
  ].join('\n')
  await writeFile(ap4, bothVariants)
  const o4 = makeCaptureStream()
  const p4 = makePromptScript(['n'])
  const r4 = await runSetupCodex([], {
    stdout: o4.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e4, MEGALENS_TOKEN: TOKEN_A },
    home: h4,
    isTTY: true,
    tomlHelpers,
    promptOverride: p4.promptOverride,
  })
  check('codex both variants present -> no AGENTS.md prompt, no change, no backup',
    r4.exitCode === 0 &&
    p4.prompts.length === 1 &&
    (await readFile(ap4, 'utf-8')) === bothVariants &&
    !(await readdir(ch4)).some((f) => f.includes('.bak-')) &&
    o4.text().includes('already has the MegaLens lines. Leaving it unchanged.'))

  // --dry-run on old-only file writes nothing
  const { home: h5, codexHome: ch5, env: e5 } = await newHome(false)
  await mkdir(ch5, { recursive: true })
  const ap5 = join(ch5, 'AGENTS.md')
  await writeFile(ap5, oldOnly)
  const o5 = makeCaptureStream()
  const p5 = makePromptScript(['n', 'y'])
  const r5 = await runSetupCodex(['--dry-run'], {
    stdout: o5.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e5, MEGALENS_TOKEN: TOKEN_A },
    home: h5,
    isTTY: true,
    tomlHelpers,
    promptOverride: p5.promptOverride,
  })
  check('codex --dry-run on old-only AGENTS.md writes nothing and creates no backup',
    r5.exitCode === 0 &&
    (await readFile(ap5, 'utf-8')) === oldOnly &&
    !(await readdir(ch5)).some((f) => f.includes('.bak-')) &&
    o5.text().includes('[dry-run]'))
}

// ── 24. Decision line v2 migration & edge cases for Codex (0.3.10) ───────────
{
  const hasLoneLf = (s) => /[^\r]\n/.test(s) || s.startsWith('\n')

  // CODE + v1 (with CRLF + surrounding lines) -> v1 replaced in place by v2, CODE untouched, position & CRLF kept
  const { home: h1, codexHome: ch1, env: e1 } = await newHome(false)
  await mkdir(ch1, { recursive: true })
  const ap1 = join(ch1, 'AGENTS.md')
  const codeV1Crlf = `# Top\r\n${CODEX_AGENTS_LINE}\r\n# Mid\r\n${DECISION_LINE_V1}\r\n# Bottom\r\n`
  await writeFile(ap1, codeV1Crlf)
  const o1 = makeCaptureStream()
  const p1 = makePromptScript(['n', 'y'])
  const r1 = await runSetupCodex([], {
    stdout: o1.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e1, MEGALENS_TOKEN: TOKEN_A },
    home: h1,
    isTTY: true,
    tomlHelpers,
    promptOverride: p1.promptOverride,
    now: () => new Date('2026-11-16T12:10:00.000Z'),
  })
  const after1 = await readFile(ap1, 'utf-8')
  const expected1 = `# Top\r\n${CODEX_AGENTS_LINE}\r\n# Mid\r\n${DECISION_LINE}\r\n# Bottom\r\n`
  check('codex CODE+v1 (CRLF) -> replaces v1 in place with v2, keeps CODE/position/CRLF',
    r1.exitCode === 0 &&
    after1 === expected1 &&
    !hasLoneLf(after1) &&
    o1.text().includes(`Update this line: ${DECISION_LINE_V1} -> ${DECISION_LINE}`) &&
    (await readdir(ch1)).some((f) => f.startsWith('AGENTS.md.bak-')))

  // v1 only -> CODE added + v1 replaced in place in 1 prompt
  const { home: h2, codexHome: ch2, env: e2 } = await newHome(false)
  await mkdir(ch2, { recursive: true })
  const ap2 = join(ch2, 'AGENTS.md')
  const v1Only = `# Top\n${DECISION_LINE_V1}\n# Bottom\n`
  await writeFile(ap2, v1Only)
  const o2 = makeCaptureStream()
  const p2 = makePromptScript(['n', 'y'])
  const r2 = await runSetupCodex([], {
    stdout: o2.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e2, MEGALENS_TOKEN: TOKEN_A },
    home: h2,
    isTTY: true,
    tomlHelpers,
    promptOverride: p2.promptOverride,
    now: () => new Date('2026-11-16T12:11:00.000Z'),
  })
  check('codex v1 only -> adds CODE and replaces v1 in place in 1 prompt',
    r2.exitCode === 0 &&
    p2.prompts.length === 2 &&
    (await readFile(ap2, 'utf-8')) === `# Top\n${DECISION_LINE}\n# Bottom\n${CODEX_AGENTS_LINE}\n` &&
    o2.text().includes(`Update this line: ${DECISION_LINE_V1} -> ${DECISION_LINE}`) &&
    o2.text().includes(CODEX_AGENTS_LINE))

  // CODE + v1 + v2 -> removes v1, keeps CODE + v2
  const { home: h3, codexHome: ch3, env: e3 } = await newHome(false)
  await mkdir(ch3, { recursive: true })
  const ap3 = join(ch3, 'AGENTS.md')
  const v1AndV2 = `# Top\n${CODEX_AGENTS_LINE}\n${DECISION_LINE_V1}\n${DECISION_LINE}\n# Bottom\n`
  await writeFile(ap3, v1AndV2)
  const o3 = makeCaptureStream()
  const p3 = makePromptScript(['n', 'y'])
  const r3 = await runSetupCodex([], {
    stdout: o3.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e3, MEGALENS_TOKEN: TOKEN_A },
    home: h3,
    isTTY: true,
    tomlHelpers,
    promptOverride: p3.promptOverride,
    now: () => new Date('2026-11-16T12:12:00.000Z'),
  })
  check('codex CODE+v1+v2 -> removes v1, keeps CODE and v2',
    r3.exitCode === 0 &&
    (await readFile(ap3, 'utf-8')) === `# Top\n${CODEX_AGENTS_LINE}\n${DECISION_LINE}\n# Bottom\n` &&
    o3.text().includes(DECISION_LINE_V1))

  // Hard-wrapped v2 over two lines is NOT read as CODE -> adds CODE on y
  const { home: h4, codexHome: ch4, env: e4 } = await newHome(false)
  await mkdir(ch4, { recursive: true })
  const ap4 = join(ch4, 'AGENTS.md')
  const wrappedV2 = [
    '# Rules',
    'Before you or the user settle a decision that is hard to undo (choosing a database or data model, adding sign-in or payments, picking a major library or architecture),',
    'starting a new project, or doing deep research, offer a MegaLens review once for that task and wait for a yes before running it. Do not offer it for small questions or routine edits.',
    '',
  ].join('\n')
  await writeFile(ap4, wrappedV2)
  const o4 = makeCaptureStream()
  const p4 = makePromptScript(['n', 'y'])
  const r4 = await runSetupCodex([], {
    stdout: o4.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e4, MEGALENS_TOKEN: TOKEN_A },
    home: h4,
    isTTY: true,
    tomlHelpers,
    promptOverride: p4.promptOverride,
    now: () => new Date('2026-11-16T12:13:00.000Z'),
  })
  check('codex hard-wrapped v2 is NOT read as CODE line -> CODE line added',
    r4.exitCode === 0 &&
    (await readFile(ap4, 'utf-8')).includes(CODEX_AGENTS_LINE))

  // --dry-run on CODE + v1 writes nothing and creates no backup
  const { home: h5, codexHome: ch5, env: e5 } = await newHome(false)
  await mkdir(ch5, { recursive: true })
  const ap5 = join(ch5, 'AGENTS.md')
  await writeFile(ap5, codeV1Crlf)
  const o5 = makeCaptureStream()
  const p5 = makePromptScript(['n', 'y'])
  const r5 = await runSetupCodex(['--dry-run'], {
    stdout: o5.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e5, MEGALENS_TOKEN: TOKEN_A },
    home: h5,
    isTTY: true,
    tomlHelpers,
    promptOverride: p5.promptOverride,
  })
  check('codex --dry-run on CODE+v1 writes nothing and creates no backup',
    r5.exitCode === 0 &&
    (await readFile(ap5, 'utf-8')) === codeV1Crlf &&
    !(await readdir(ch5)).some((f) => f.includes('.bak-')) &&
    o5.text().includes('[dry-run]') &&
    o5.text().includes(`Update this line: ${DECISION_LINE_V1} -> ${DECISION_LINE}`))
}

// ── 25. P2 fix: substring v1 replace/remove preserves surrounding text & CODE ──
{
  // 1) `- <v1>` -> `- <v2>` (bullet kept) via runSetupCodex + idempotent second run
  const { home: h1, codexHome: ch1, env: e1 } = await newHome(false)
  await mkdir(ch1, { recursive: true })
  const ap1 = join(ch1, 'AGENTS.md')
  await writeFile(ap1, `${CODEX_AGENTS_LINE}\n- ${DECISION_LINE_V1}\n`)
  const o1 = makeCaptureStream()
  const p1 = makePromptScript(['n', 'y'])
  const r1 = await runSetupCodex([], {
    stdout: o1.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e1, MEGALENS_TOKEN: TOKEN_A },
    home: h1,
    isTTY: true,
    tomlHelpers,
    promptOverride: p1.promptOverride,
    now: () => new Date('2026-11-16T12:30:00.000Z'),
  })
  const expected1 = `${CODEX_AGENTS_LINE}\n- ${DECISION_LINE}\n`
  check('codex `- <v1>` -> `- <v2>` keeps bullet',
    r1.exitCode === 0 &&
    (await readFile(ap1, 'utf-8')) === expected1 &&
    o1.text().includes(`Update this line: ${DECISION_LINE_V1} -> ${DECISION_LINE}`))

  // 2) `"<v1>"` keeps quotes
  const { home: h2, codexHome: ch2, env: e2 } = await newHome(false)
  await mkdir(ch2, { recursive: true })
  const ap2 = join(ch2, 'AGENTS.md')
  await writeFile(ap2, `${CODEX_AGENTS_LINE}\n"${DECISION_LINE_V1}"\n`)
  const o2 = makeCaptureStream()
  const p2 = makePromptScript(['n', 'y'])
  const r2 = await runSetupCodex([], {
    stdout: o2.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e2, MEGALENS_TOKEN: TOKEN_A },
    home: h2,
    isTTY: true,
    tomlHelpers,
    promptOverride: p2.promptOverride,
    now: () => new Date('2026-11-16T12:31:00.000Z'),
  })
  check('codex `"<v1>"` -> `"<v2>"` keeps quotes',
    r2.exitCode === 0 &&
    (await readFile(ap2, 'utf-8')) === `${CODEX_AGENTS_LINE}\n"${DECISION_LINE}"\n`)

  // 3) `<v1> Also tell Bob.` keeps the tail
  const { home: h3, codexHome: ch3, env: e3 } = await newHome(false)
  await mkdir(ch3, { recursive: true })
  const ap3 = join(ch3, 'AGENTS.md')
  await writeFile(ap3, `${CODEX_AGENTS_LINE}\n${DECISION_LINE_V1} Also tell Bob.\n`)
  const o3 = makeCaptureStream()
  const p3 = makePromptScript(['n', 'y'])
  const r3 = await runSetupCodex([], {
    stdout: o3.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e3, MEGALENS_TOKEN: TOKEN_A },
    home: h3,
    isTTY: true,
    tomlHelpers,
    promptOverride: p3.promptOverride,
    now: () => new Date('2026-11-16T12:32:00.000Z'),
  })
  check('codex `<v1> Also tell Bob.` keeps tail',
    r3.exitCode === 0 &&
    (await readFile(ap3, 'utf-8')) === `${CODEX_AGENTS_LINE}\n${DECISION_LINE} Also tell Bob.\n`)

  // 4) `<CODE> <v1>` on one line -> CODE kept and v2 present (and no duplicate CODE added)
  const { home: h4, codexHome: ch4, env: e4 } = await newHome(false)
  await mkdir(ch4, { recursive: true })
  const ap4 = join(ch4, 'AGENTS.md')
  await writeFile(ap4, `${CODEX_AGENTS_LINE} ${DECISION_LINE_V1}\n`)
  const o4 = makeCaptureStream()
  const p4 = makePromptScript(['n', 'y'])
  const r4 = await runSetupCodex([], {
    stdout: o4.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e4, MEGALENS_TOKEN: TOKEN_A },
    home: h4,
    isTTY: true,
    tomlHelpers,
    promptOverride: p4.promptOverride,
    now: () => new Date('2026-11-16T12:33:00.000Z'),
  })
  check('codex `<CODE> <v1>` on one line -> CODE kept and v2 present',
    r4.exitCode === 0 &&
    (await readFile(ap4, 'utf-8')) === `${CODEX_AGENTS_LINE} ${DECISION_LINE}\n` &&
    !o4.text().includes('Add this line:'))

  // 5) v2 present + `- <v1>` -> bullet line removed entirely
  const { home: h5, codexHome: ch5, env: e5 } = await newHome(false)
  await mkdir(ch5, { recursive: true })
  const ap5 = join(ch5, 'AGENTS.md')
  await writeFile(ap5, `${CODEX_AGENTS_LINE}\n${DECISION_LINE}\n- ${DECISION_LINE_V1}\n# End\n`)
  const o5 = makeCaptureStream()
  const p5 = makePromptScript(['n', 'y'])
  const r5 = await runSetupCodex([], {
    stdout: o5.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e5, MEGALENS_TOKEN: TOKEN_A },
    home: h5,
    isTTY: true,
    tomlHelpers,
    promptOverride: p5.promptOverride,
    now: () => new Date('2026-11-16T12:34:00.000Z'),
  })
  check('codex v2 present + `- <v1>` -> bullet line removed entirely',
    r5.exitCode === 0 &&
    (await readFile(ap5, 'utf-8')) === `${CODEX_AGENTS_LINE}\n${DECISION_LINE}\n# End\n`)

  // 6) v2 present + `<v1> Also tell Bob.` -> only v1 text removed, tail kept
  const { home: h6, codexHome: ch6, env: e6 } = await newHome(false)
  await mkdir(ch6, { recursive: true })
  const ap6 = join(ch6, 'AGENTS.md')
  await writeFile(ap6, `${CODEX_AGENTS_LINE}\n${DECISION_LINE}\n${DECISION_LINE_V1} Also tell Bob.\n`)
  const o6 = makeCaptureStream()
  const p6 = makePromptScript(['n', 'y'])
  const r6 = await runSetupCodex([], {
    stdout: o6.stream,
    stderr: makeCaptureStream().stream,
    env: { ...e6, MEGALENS_TOKEN: TOKEN_A },
    home: h6,
    isTTY: true,
    tomlHelpers,
    promptOverride: p6.promptOverride,
    now: () => new Date('2026-11-16T12:35:00.000Z'),
  })
  check('codex v2 present + `<v1> Also tell Bob.` -> only v1 text removed, tail kept',
    r6.exitCode === 0 &&
    (await readFile(ap6, 'utf-8')) === `${CODEX_AGENTS_LINE}\n${DECISION_LINE}\nAlso tell Bob.\n`)

  // 7) v2 present + line merely quoting v1 opening + "MegaLens" -> NOT removed
  const quoteNote = `${CODEX_AGENTS_LINE}\n${DECISION_LINE}\nNote: we replaced "When the user is making a decision that is hard to undo" with the new MegaLens rule.\n`
  const planNote = planInstructionLineUpdates(quoteNote)
  check('v2 present + line quoting v1 opening + MegaLens is NOT removed',
    !planNote.hasChanges &&
    planNote.removals.length === 0 &&
    planNote.nextContent === quoteNote)

  // 8) Pattern-only reworded v1 with bullet keeps bullet prefix, and BOM/CRLF preserved
  const rewordedBullet = `\uFEFF${CODEX_AGENTS_LINE}\r\n- When the user is making a decision that is hard to undo, ask MegaLens.\r\n`
  const planReworded = planInstructionLineUpdates(rewordedBullet)
  check('pattern-only reworded v1 keeps bullet prefix, BOM, and CRLF',
    planReworded.hasChanges &&
    planReworded.replacements.length === 1 &&
    planReworded.nextContent === `\uFEFF${CODEX_AGENTS_LINE}\r\n- ${DECISION_LINE}\r\n`)

  // 9) BOM on removed `- <v1>` moves BOM to surviving line and keeps CRLF
  const bomRemove = `\uFEFF- ${DECISION_LINE_V1}\r\n${CODEX_AGENTS_LINE}\r\n${DECISION_LINE}\r\n`
  const planBomRemove = planInstructionLineUpdates(bomRemove)
  check('v2 present + BOM on removed `- <v1>` preserves BOM and CRLF',
    planBomRemove.hasChanges &&
    planBomRemove.removals.length === 1 &&
    planBomRemove.nextContent === `\uFEFF${CODEX_AGENTS_LINE}\r\n${DECISION_LINE}\r\n`)
}

// ── Fix round 10 (Astra FINAL): #3 backup outside git, #5 preserve fields, #6 quoted ], #9 label check ─
{
  // #5 + #6: --replace-token preserves enabled=false, enabled_tools, and following [projects."/a/b[1]"]
  const { home, codexHome, env } = await newHome(false)
  await mkdir(codexHome, { recursive: true })
  const cfgPath = join(codexHome, 'config.toml')
  await writeFile(
    cfgPath,
    [
      '[mcp_servers.megalens]',
      'url = "https://megalens.ai/api/mcp?ide=codex"',
      `http_headers = { "Authorization" = "Bearer ${TOKEN_A}" }`,
      'enabled = false',
      'enabled_tools = ["megalens_review"]',
      '',
      '[projects."/home/user/app[v2]"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'),
  )
  const out = makeCaptureStream()
  const err = makeCaptureStream()
  const { promptOverride } = makePromptScript(['y', 'n'])
  const res = await runSetupCodex(['--replace-token'], {
    stdout: out.stream,
    stderr: err.stream,
    env: { ...env, MEGALENS_TOKEN: TOKEN_B },
    home,
    isTTY: true,
    tomlHelpers,
    promptOverride,
    now: () => new Date('2026-11-22T07:00:00.000Z'),
  })
  const after = await readFile(cfgPath, 'utf-8')
  check('Astra FINAL #5/#6: codex --replace-token preserves enabled, enabled_tools, and [projects."...[v2]"]',
    res.exitCode === 0 &&
    after.includes(`Bearer ${TOKEN_B}`) &&
    !after.includes(TOKEN_A) &&
    after.includes('enabled = false') &&
    after.includes('enabled_tools = ["megalens_review"]') &&
    after.includes('[projects."/home/user/app[v2]"]') &&
    after.includes('trust_level = "trusted"'))

  // #9: setup codex refuses github-action label, unlabeled token, invalid token, and network failure
  for (const [label, validator] of [
    ['github-action token', async () => ({ ok: false, reason: 'wrong_label', label: 'github-action' })],
    ['missing label', async () => ({ ok: false, reason: 'wrong_label', label: null })],
    ['invalid token', async () => ({ ok: false, reason: 'invalid', error: 'revoked' })],
    ['network error', async () => ({ ok: false, reason: 'network', error: 'ECONNREFUSED' })],
  ]) {
    const { home: h9, codexHome: ch9, env: e9 } = await newHome(false)
    const o9 = makeCaptureStream()
    const er9 = makeCaptureStream()
    const r9 = await runSetupCodex([], {
      stdout: o9.stream,
      stderr: er9.stream,
      env: { ...e9, MEGALENS_TOKEN: TOKEN_A },
      home: h9,
      isTTY: true,
      tomlHelpers,
      validateToken: validator,
      promptOverride: makePromptScript([]).promptOverride,
    })
    const existsAfter = await readFile(join(ch9, 'config.toml'), 'utf-8').then(() => true, () => false)
    check(`Astra FINAL #9: setup codex refuses ${label} and writes nothing`, r9.exitCode === 1 && !existsAfter)
  }

  // #3: git-ignored config.toml inside a dotfiles git repo saves backup outside the repo (git status clean)
  const { home: h3, env: e3 } = await newHome(true)
  const repoDir = join(h3, 'dotfiles')
  const repoCodex = join(repoDir, '.codex')
  await mkdir(repoCodex, { recursive: true })
  spawnSync('git', ['init', '-q', repoDir])
  await writeFile(join(repoDir, '.gitignore'), '.codex/config.toml\n')
  const ignoredCfg = join(repoCodex, 'config.toml')
  const prior = 'other_secret = "sk-other-999"\n'
  await writeFile(ignoredCfg, prior)
  const o3 = makeCaptureStream()
  const er3 = makeCaptureStream()
  const r3 = await runSetupCodex([], {
    stdout: o3.stream,
    stderr: er3.stream,
    env: { ...e3, HOME: h3, PATH: process.env.PATH ?? '', CODEX_HOME: repoCodex, MEGALENS_TOKEN: TOKEN_A },
    home: h3,
    isTTY: true,
    tomlHelpers,
    promptOverride: makePromptScript(['y', 'n']).promptOverride,
    now: () => new Date('2026-11-22T07:05:00.000Z'),
  })
  const repoFiles = await readdir(repoCodex)
  const status = spawnSync('git', ['-C', repoDir, 'status', '--porcelain'], { encoding: 'utf-8' }).stdout.trim()
  check('Astra FINAL #3: git-ignored config.toml backup stays outside the dotfiles repo',
    r3.exitCode === 0 &&
    !repoFiles.some((f) => f.includes('.bak-')) &&
    !status.includes('.bak-'))
  // Fix round 11 (Astra CONFIRM10 #11, #12, #13):
  // #11: Unrelated server added to config.toml while confirmation prompt is open is preserved; conflicting edit refused
  const { home: h11, codexHome: ch11, env: e11 } = await newHome(false)
  await mkdir(ch11, { recursive: true })
  const cfg11 = join(ch11, 'config.toml')
  await writeFile(cfg11, 'model = "o3"\n')
  const r11 = await runSetupCodex([], {
    stdout: makeCaptureStream().stream,
    stderr: makeCaptureStream().stream,
    env: { ...e11, MEGALENS_TOKEN: TOKEN_A },
    home: h11,
    isTTY: true,
    tomlHelpers,
    promptOverride: {
      async askHidden() { throw new Error('unexpected') },
      async askPlain(prompt) {
        if (prompt.includes('Add MegaLens to Codex?')) {
          await writeFile(cfg11, 'model = "o3"\n\n[mcp_servers.second]\nurl = "https://second.example"\n')
          return 'y'
        }
        return 'n'
      },
    },
  })
  const after11 = await readFile(cfg11, 'utf-8')
  check('Astra CONFIRM10 #11 (codex): concurrent unrelated server added while prompt is open is preserved',
    r11.exitCode === 0 &&
    after11.includes('[mcp_servers.second]') &&
    after11.includes('[mcp_servers.megalens]') &&
    after11.includes(`Bearer ${TOKEN_A}`))

  const { home: h11c, codexHome: ch11c, env: e11c } = await newHome(false)
  await mkdir(ch11c, { recursive: true })
  const cfg11c = join(ch11c, 'config.toml')
  await writeFile(cfg11c, 'model = "o3"\n')
  const concurrentToml = `model = "o3"\n\n[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\nhttp_headers = { "Authorization" = "Bearer ${TOKEN_B}" }\n`
  const r11c = await runSetupCodex([], {
    stdout: makeCaptureStream().stream,
    stderr: makeCaptureStream().stream,
    env: { ...e11c, MEGALENS_TOKEN: TOKEN_A },
    home: h11c,
    isTTY: true,
    tomlHelpers,
    promptOverride: {
      async askHidden() { throw new Error('unexpected') },
      async askPlain(prompt) {
        if (prompt.includes('Add MegaLens to Codex?')) {
          await writeFile(cfg11c, concurrentToml)
          return 'y'
        }
        return 'n'
      },
    },
  })
  check('Astra CONFIRM10 #11 (codex): conflicting edit to [mcp_servers.megalens] while prompt is open exits 1 and leaves file untouched',
    r11c.exitCode === 1 && (await readFile(cfg11c, 'utf-8')) === concurrentToml)

  // #12: Codex entry with env_http_headers or bearer_token_env_var is treated as uneditable (never carries env creds across origins)
  for (const [label, extraToml] of [
    ['env_http_headers', 'env_http_headers = { "X-Proxy-Key" = "PROXY_KEY" }'],
    ['bearer_token_env_var', 'bearer_token_env_var = "OTHER_TOKEN"'],
  ]) {
    const { home: h12, codexHome: ch12, env: e12 } = await newHome(false)
    await mkdir(ch12, { recursive: true })
    const cfg12 = join(ch12, 'config.toml')
    const init12 = `[mcp_servers.megalens]\nurl = "https://other.example/mcp"\n${extraToml}\n`
    await writeFile(cfg12, init12)
    const o12 = makeCaptureStream()
    const r12 = await runSetupCodex(['--replace-token'], {
      stdout: o12.stream,
      stderr: makeCaptureStream().stream,
      env: { ...e12, MEGALENS_TOKEN: TOKEN_B },
      home: h12,
      isTTY: true,
      tomlHelpers,
      promptOverride: makePromptScript(['n']).promptOverride,
    })
    check(`Astra CONFIRM10 #12 (codex): ${label} marked uneditable and left untouched`,
      r12.exitCode === 0 && (await readFile(cfg12, 'utf-8')) === init12 && o12.text().includes('cannot edit safely'))
  }

  // #13: setup codex accepts onboarding token with verified label "codex", rejects "claude-code" and "github-action"
  const { validateEditorToken } = await import('../bin/setup-shared.mjs')
  const makeLabelFetch = (label) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ valid: true, is_pro: false, is_payg: true, plan_code: 'payg', label }),
  })
  const { home: h13ok, codexHome: ch13ok, env: e13ok } = await newHome(false)
  const r13ok = await rawRunSetupCodex([], {
    stdout: makeCaptureStream().stream,
    stderr: makeCaptureStream().stream,
    env: { ...e13ok, MEGALENS_TOKEN: TOKEN_A },
    home: h13ok,
    isTTY: true,
    tomlHelpers,
    promptOverride: makePromptScript(['y', 'n']).promptOverride,
    validateToken: (tok, opts) => validateEditorToken(tok, { ...opts, fetchImpl: makeLabelFetch('codex') }),
  })
  check('Astra CONFIRM10 #13 (codex): accepts onboarding token with verified label "codex"',
    r13ok.exitCode === 0 && (await readFile(join(ch13ok, 'config.toml'), 'utf-8')).includes(`Bearer ${TOKEN_A}`))

  const { home: h13bad, codexHome: ch13bad, env: e13bad } = await newHome(false)
  const r13bad = await rawRunSetupCodex([], {
    stdout: makeCaptureStream().stream,
    stderr: makeCaptureStream().stream,
    env: { ...e13bad, MEGALENS_TOKEN: TOKEN_A },
    home: h13bad,
    isTTY: true,
    tomlHelpers,
    promptOverride: makePromptScript(['y', 'n']).promptOverride,
    validateToken: (tok, opts) => validateEditorToken(tok, { ...opts, fetchImpl: makeLabelFetch('claude-code') }),
  })
  const exists13bad = await readFile(join(ch13bad, 'config.toml'), 'utf-8').then(() => true, () => false)
  check('Astra CONFIRM10 #13 (codex): rejects mismatched tool label "claude-code" with exit 1 and zero writes',
    r13bad.exitCode === 1 && !exists13bad)

  // Fix round 12 (Astra CONFIRM11 #11 concurrent edit during backup & #12 headers_helper/oauth):
  const { home: h12b, codexHome: ch12b, env: e12b } = await newHome(false)
  await mkdir(ch12b, { recursive: true })
  const cfg12b = join(ch12b, 'config.toml')
  await writeFile(cfg12b, 'model = "o3"\n')
  const shimDir12 = join(h12b, 'git-shim')
  await mkdir(shimDir12, { recursive: true })
  const countFile12 = join(h12b, 'git-count')
  const concurrentBackupToml = 'model = "o3"\n\n[mcp_servers.second]\nurl = "https://second.example"\n'
  await writeFile(join(shimDir12, 'git'), [
    `#!${process.execPath}`,
    "import { readFileSync, writeFileSync } from 'node:fs'",
    `const countFile = ${JSON.stringify(countFile12)}`,
    `const cfgPath = ${JSON.stringify(cfg12b)}`,
    `const payload = ${JSON.stringify(concurrentBackupToml)}`,
    'let n = 0',
    'try { n = Number(readFileSync(countFile, "utf-8").trim()) || 0 } catch {}',
    'n += 1',
    'writeFileSync(countFile, String(n))',
    'if (n === 2) writeFileSync(cfgPath, payload)',
    'process.stderr.write("fatal: not a git repository\\n")',
    'process.exit(128)',
    '',
  ].join('\n'), { mode: 0o755 })
  const r12b = await runSetupCodex([], {
    stdout: makeCaptureStream().stream,
    stderr: makeCaptureStream().stream,
    env: { ...e12b, PATH: `${shimDir12}:${e12b.PATH ?? ''}`, MEGALENS_TOKEN: TOKEN_A },
    home: h12b,
    isTTY: true,
    tomlHelpers,
    promptOverride: makePromptScript(['y', 'n']).promptOverride,
  })
  const after12b = await readFile(cfg12b, 'utf-8')
  check('Astra CONFIRM11 #11 (codex): second server saved during backup is preserved after recheck/re-merge',
    r12b.exitCode === 0 &&
    after12b.includes('[mcp_servers.second]') &&
    after12b.includes('[mcp_servers.megalens]') &&
    after12b.includes(`Bearer ${TOKEN_A}`))

  for (const [label, extraToml] of [
    ['headers_helper', 'headers_helper = "/usr/local/bin/proxy-headers.sh"'],
    ['oauth subtable', '[mcp_servers.megalens.oauth]\nclient_secret = "proxy-secret"'],
  ]) {
    const { home: h12h, codexHome: ch12h, env: e12h } = await newHome(false)
    await mkdir(ch12h, { recursive: true })
    const cfg12h = join(ch12h, 'config.toml')
    const init12h = `[mcp_servers.megalens]\nurl = "https://other.example/mcp"\n${extraToml}\n`
    await writeFile(cfg12h, init12h)
    const o12h = makeCaptureStream()
    const r12h = await runSetupCodex(['--replace-token'], {
      stdout: o12h.stream,
      stderr: makeCaptureStream().stream,
      env: { ...e12h, MEGALENS_TOKEN: TOKEN_B },
      home: h12h,
      isTTY: true,
      tomlHelpers,
      promptOverride: makePromptScript(['n']).promptOverride,
    })
    check(`Astra CONFIRM11 #12 (codex): ${label} marked uneditable and left untouched`,
      r12h.exitCode === 0 && (await readFile(cfg12h, 'utf-8')) === init12h && o12h.text().includes('cannot edit safely'))
  }
}

await rm(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
