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
  FINAL_MESSAGE,
  runSetupCodex,
} from '../bin/codex-setup.mjs'

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
    prompts.some((p) => p.prompt.includes(`Add this line to ${agentsPath} so Codex offers a MegaLens review at the right moments? (y/n)`)))
  check('fresh home writes config.toml with ?ide=codex and Bearer token',
    configText.includes('[mcp_servers.megalens]') &&
    configText.includes('url = "https://megalens.ai/api/mcp?ide=codex"') &&
    configText.includes(`http_headers = { "Authorization" = "Bearer ${TOKEN_A}" }`))
  check('fresh home sets 0600 on new config.toml', configMode === 0o600, `got ${configMode.toString(8)}`)
  check('fresh home creates AGENTS.md with exact line', agentsText.trim() === CODEX_AGENTS_LINE)
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
      if (!sentAgentsAnswer && outBuf.includes('so Codex offers a MegaLens review at the right moments? (y/n):')) {
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

  check('AGENTS.md without line appends exact line',
    afterFirst.includes('# Global rules') && afterFirst.includes(CODEX_AGENTS_LINE))
  check('AGENTS.md preserves mode 0644', modeAfter === 0o644, `got ${modeAfter.toString(8)}`)
  check('AGENTS.md backup created before edit', Boolean(agentsBackup))

  // Second run: AGENTS.md already has MegaLens line -> idempotent, no prompt, no second append
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
  const matches = afterSecond.split(CODEX_AGENTS_LINE).length - 1
  check('AGENTS.md with MegaLens line is idempotent (only 1 prompt for config, 1 line total)',
    afterSecond === afterFirst && matches === 1 && p2.prompts.length === 1)
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
    out.text().includes(CODEX_AGENTS_LINE) &&
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
    nextAgents.includes('\r\n') && !hasLoneLf(nextAgents) && nextAgents.includes(CODEX_AGENTS_LINE))
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
  check('P3-2 AGENTS.md with unrelated MegaLens notes still gets the offer and appends the line on y',
    res.exitCode === 0 &&
    prompts.some((p) => p.prompt.includes('AGENTS.md')) &&
    after.includes(unrelated.trimEnd()) &&
    after.includes(CODEX_AGENTS_LINE))
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
      if (!n2 && buf.includes('so Codex offers a MegaLens review at the right moments? (y/n):')) {
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
    afterAgents.startsWith(`${origAgents}\n${CODEX_AGENTS_LINE}`))

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

await rm(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
