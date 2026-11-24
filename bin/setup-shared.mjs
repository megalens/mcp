import { readFile, writeFile, mkdir, chmod, rename, unlink, realpath, stat, lstat, chown, access, open, link } from 'node:fs/promises'
import { constants, statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { MEGALENS_REVIEW_LINE, MEGALENS_REVIEW_LINE_V1, DECISION_LINE, DECISION_LINE_V1, DECISION_LINE_V2 } from './review-guidance.mjs'

export const API_BASE = 'https://megalens.ai'
export const VALIDATE_URL = `${API_BASE}/api/mcp/validate`

export { MEGALENS_REVIEW_LINE, DECISION_LINE, DECISION_LINE_V1 }

export const MEGALENS_INSTRUCTION_LINES = [MEGALENS_REVIEW_LINE, DECISION_LINE]
export const REMOVABLE_INSTRUCTION_LINES = [MEGALENS_REVIEW_LINE, DECISION_LINE, MEGALENS_REVIEW_LINE_V1, DECISION_LINE_V1, DECISION_LINE_V2]

export const TOKEN_REGEX = /^ml_tok_[0-9a-f]{32}$/i
export const MASKED_TOKEN = 'ml_tok_****'

const OLD_LINE_PATTERN = /after you change code.*offer a MegaLens review/i
const OFFER_REVIEW_PATTERN = /offer a MegaLens review/i
const DECISION_V1_PATTERN = /when the user is making a decision that is hard to undo.*MegaLens/i
const DECISION_V1_SPAN_PATTERN =
  /when the user is making a decision that is hard to undo.*MegaLens(?:\s+reviews?)?(?:\s+once for that task[^.!?\n]*[.!?]?)?(?:\s*Do not offer it for small questions or routine edits[.!?]?)?/i
const DECISION_V2_PATTERN = /before you or the user settle a decision.*MegaLens/i
const DECISION_CONTINUATION_PATTERN = /once for that task|small questions or routine edits|hard to undo/i
const BULLET_QUOTE_WS_ONLY = /^[\s\-*+>"'`“”‘’•]*$/
const BULLET_QUOTE_WS_PUNCT_ONLY = /^[\s\-*+>"'`“”‘’•.,;:!?]*$/
const V1_LEADING_PREFIX_PATTERN = /^(\s*(?:(?:[-*+>]\s+)|["'`“‘])*)/

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function normalizeLineForMatch(raw, idx) {
  const noCr = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  const noBom = idx === 0 && noCr.startsWith('\uFEFF') ? noCr.slice(1) : noCr
  return noBom.trim()
}

function isV1DecisionLine(trimmed) {
  return trimmed === DECISION_LINE_V1 || DECISION_V1_PATTERN.test(trimmed)
}

function isV2DecisionLine(trimmed) {
  return trimmed.includes(DECISION_LINE) || DECISION_V2_PATTERN.test(trimmed)
}

function isCodeReviewLine(trimmed) {
  return (
    trimmed.includes(MEGALENS_REVIEW_LINE) ||
    OLD_LINE_PATTERN.test(trimmed) ||
    (
      OFFER_REVIEW_PATTERN.test(trimmed) &&
      !isV1DecisionLine(trimmed) &&
      !isV2DecisionLine(trimmed) &&
      !DECISION_CONTINUATION_PATTERN.test(trimmed)
    )
  )
}

export function hasMegaLensReviewLine(text) {
  return text
    .split('\n')
    .some((raw, idx) => isCodeReviewLine(normalizeLineForMatch(raw, idx)))
}

export function hasMegaLensDecisionLine(text) {
  return text
    .split('\n')
    .some((raw, idx) => isV2DecisionLine(normalizeLineForMatch(raw, idx)))
}

export function hasMegaLensDecisionV1Line(text) {
  return text
    .split('\n')
    .some((raw, idx) => isV1DecisionLine(normalizeLineForMatch(raw, idx)))
}

export function getMissingInstructionLines(text) {
  const missing = []
  if (!hasMegaLensReviewLine(text)) missing.push(MEGALENS_REVIEW_LINE)
  if (!hasMegaLensDecisionLine(text)) missing.push(DECISION_LINE)
  return missing
}

export function maskTokenSecrets(text, extraToken = '') {
  let out = String(text ?? '')
  if (extraToken) {
    out = out.split(extraToken).join(MASKED_TOKEN)
  }
  return out
    .replace(/ml_tok_[0-9a-f]+/gi, MASKED_TOKEN)
    .replace(/(Bearer\s+)(?!ml_tok_\*{4})([^\s"']+)/gi, '$1****')
}

export function maskCliArg(arg) {
  const masked = maskTokenSecrets(arg)
  if (/^--token=/i.test(masked) && !/^--token=ml_tok_\*{4}$/i.test(masked)) {
    return '--token=****'
  }
  return masked
}

export function formatInvalidSetupArgError(subcommand, arg) {
  if (arg.startsWith('-')) {
    return `Unknown option for setup ${subcommand}: ${maskCliArg(arg)}`
  }
  return `Unexpected argument for setup ${subcommand}.`
}

export async function getReadOnlyReason(filePath) {
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

export function makeTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-')
}

export function isYes(answer) {
  const normalized = String(answer ?? '').trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

export class ConcurrentModificationError extends Error {
  constructor(filePath) {
    super(`${filePath} changed on disk before it could be saved`)
    this.name = 'ConcurrentModificationError'
    this.code = 'ECONCURRENT'
    this.filePath = filePath
  }
}

async function readVersionFromTarget(filePath) {
  let fh
  try {
    fh = await open(filePath, 'r')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      const lst = await lstat(filePath).catch(() => null)
      if (lst?.isSymbolicLink()) {
        return { exists: true, target: null, buf: null, unreadable: 'dangling symlink (target does not exist)', version: null }
      }
      return { exists: false, target: null, buf: null, unreadable: null, version: { exists: false, target: null } }
    }
    throw err
  }
  try {
    const target = await realpath(filePath)
    const st = await fh.stat({ bigint: true })
    const buf = await fh.readFile()
    const sha256 = createHash('sha256').update(buf).digest('hex')
    return {
      exists: true,
      target,
      buf,
      unreadable: null,
      version: {
        exists: true,
        target,
        dev: st.dev,
        ino: st.ino,
        size: st.size,
        mtimeNs: st.mtimeNs,
        ctimeNs: st.ctimeNs,
        sha256,
      },
    }
  } finally {
    await fh.close()
  }
}

export function fileVersionsMatch(a, b) {
  if (!a || !b) return false
  if (a.exists !== b.exists) return false
  if (!a.exists) return true
  return (
    a.target === b.target &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.sha256 === b.sha256
  )
}

export async function verifyFileVersion(filePath, expectedVersion) {
  if (!expectedVersion) return true
  try {
    const current = await readVersionFromTarget(filePath)
    if (current.unreadable) return false
    return fileVersionsMatch(current.version, expectedVersion)
  } catch {
    return false
  }
}

export async function readOptionalFile(filePath) {
  try {
    const res = await readVersionFromTarget(filePath)
    if (res.unreadable) {
      return { exists: res.exists, content: '', unreadable: res.unreadable, version: null }
    }
    if (!res.exists) {
      return { exists: false, content: '', unreadable: null, version: res.version }
    }
    const content = utf8FatalDecoder.decode(res.buf)
    return { exists: true, content, unreadable: null, version: res.version }
  } catch (err) {
    if (err?.code === 'ENOENT') {
      const lst = await lstat(filePath).catch(() => null)
      if (lst?.isSymbolicLink()) {
        return { exists: true, content: '', unreadable: 'dangling symlink (target does not exist)', version: null }
      }
      return { exists: false, content: '', unreadable: null, version: { exists: false, target: null } }
    }
    return { exists: true, content: '', unreadable: String(err?.message ?? err), version: null }
  }
}

/**
 * Is there a repository's `.git` at this path? 'yes' (a folder with a HEAD file, or a `gitdir:`
 * file for worktrees and submodules), 'no' (nothing there, or an empty `.git` folder, which git
 * ignores too), or 'unknown' when it cannot be read (Astra FIX 15 #1).
 */
export function gitDirAt(p) {
  let st
  try {
    st = statSync(p)
  } catch (err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'no' : 'unknown'
  }
  try {
    if (st.isDirectory()) {
      try {
        statSync(join(p, 'HEAD'))
        return 'yes'
      } catch (err) {
        return err?.code === 'ENOENT' ? 'no' : 'unknown'
      }
    }
    if (st.isFile()) return readFileSync(p, 'utf-8').slice(0, 8) === 'gitdir: ' ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
  return 'unknown'
}

/** The worst answer for this folder and every folder above it: 'yes' beats 'unknown' beats 'no'. */
export function gitAncestor(dir) {
  let seen = 'no'
  for (let d = dir; ; ) {
    const here = gitDirAt(join(d, '.git'))
    if (here === 'yes') return 'yes'
    if (here === 'unknown') seen = 'unknown'
    const up = dirname(d)
    if (up === d) return seen
    d = up
  }
}

const GIT_CHECK_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
])
export function gitCheckEnv(env0 = process.env) {
  const env = {}
  for (const [k, v] of Object.entries(env0)) if (typeof v === 'string' && GIT_CHECK_ENV.has(k.toUpperCase())) env[k] = v
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  env.LANGUAGE = 'C'
  return env
}

/**
 * Could git commit a file written at `path`? 'yes' (inside a work tree, not ignored), 'no' (git
 * says not in a repo AND no `.git` above, or ignored), or 'unknown' (cannot prove safe).
 */
export function gitTrackable(path, env0 = process.env) {
  const env = gitCheckEnv(env0)
  let dir = dirname(path)
  for (;;) {
    try {
      statSync(dir)
      break
    } catch (err) {
      if (err?.code !== 'ENOENT') return 'unknown'
      const up = dirname(dir)
      if (up === dir) return 'unknown'
      dir = up
    }
  }
  const scan = env.GIT_DIR || env.GIT_WORK_TREE ? 'unknown' : gitAncestor(dir)
  const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' })
  if (top.error) return scan === 'no' ? 'no' : 'unknown'
  if (top.status !== 0) {
    if (/not a git repository/i.test(top.stderr ?? '') && scan === 'no') return 'no'
    return 'unknown'
  }
  const ignored = spawnSync('git', ['-C', dir, 'check-ignore', '-q', path], { env, stdio: 'ignore' })
  if (ignored.status === 0) return 'no'
  if (ignored.status === 1) return 'yes'
  return 'unknown'
}

/**
 * Where a write to `path` really lands, or null when that cannot be known (dangling link, loop,
 * permission error).
 */
export async function realLocation(path) {
  try {
    return await realpath(path)
  } catch (err) {
    if (err?.code !== 'ENOENT') return null
  }
  let missing = []
  let cur = path
  for (;;) {
    try {
      await lstat(cur)
      return null
    } catch (err) {
      if (err?.code !== 'ENOENT') return null
    }
    missing = [basename(cur), ...missing]
    const up = dirname(cur)
    if (up === cur) return null
    cur = up
    try {
      return join(await realpath(cur), ...missing)
    } catch (err) {
      if (err?.code !== 'ENOENT') return null
    }
  }
}

function externalBackupDirs(env = process.env, home = homedir(), platform = process.platform) {
  const dirs = []
  if (platform === 'win32') {
    dirs.push(join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'megalens', 'backups'))
  } else {
    dirs.push(join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'megalens', 'backups'))
  }
  const uidTag = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
  dirs.push(join(tmpdir(), `megalens-backups-${uidTag}`))
  return dirs
}

/**
 * Save a backup of `targetPath` before modifying it.
 *
 * Security (Astra FINAL #3): a sibling `.bak-<timestamp>` inside a git repository would become an
 * untracked committable file even when `targetPath` itself is git-ignored, exposing the entire
 * prior config (and other services' credentials). We therefore check `gitTrackable` on the ACTUAL
 * backup path before copying any bytes. Whenever the sibling path is inside a git repo (or cannot
 * be proven outside one), the backup is stored in a private 0700 directory outside the worktree
 * (verified with `gitTrackable === 'no'`). If no safe backup directory can be verified, no backup
 * is created rather than writing secrets into a repository.
 *
 * Also writes atomically with `flag: 'wx'` and the target mode from creation (never briefly 0644).
 */
export async function backupExistingFile(
  targetPath,
  timestamp = makeTimestamp(),
  { mode, env = process.env, home = homedir(), platform = process.platform, log } = {},
) {
  const existingStat = await stat(targetPath)
  const targetMode = mode ?? (existingStat.mode & 0o777)
  const siblingPath = `${targetPath}.bak-${timestamp}`
  let backupPath = null

  if (gitTrackable(siblingPath, env) === 'no') {
    backupPath = siblingPath
  } else {
    const pathHash = createHash('sha256').update(targetPath).digest('hex').slice(0, 8)
    const fileName = `${basename(targetPath)}.${pathHash}.bak-${timestamp}`
    for (const dir of externalBackupDirs(env, home, platform)) {
      const candidate = join(dir, fileName)
      if (gitTrackable(candidate, env) !== 'no') continue
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await chmod(dir, 0o700).catch(() => {})
        const dirReal = await realpath(dir).catch(() => null)
        if (!dirReal || gitTrackable(join(dirReal, fileName), env) !== 'no') continue
        const dirStat = await stat(dirReal)
        if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) continue
        backupPath = join(dirReal, fileName)
        break
      } catch {
        // try next fallback dir
      }
    }
  }

  if (!backupPath) {
    if (typeof log === 'function') {
      log(`  ! Skipped backup of ${targetPath}: could not find a backup folder outside git.`)
    }
    return null
  }

  const content = await readFile(targetPath)
  let writtenPath = backupPath
  try {
    await writeFile(writtenPath, content, { mode: targetMode, flag: 'wx' })
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err
    writtenPath = `${backupPath}.${process.pid}.${process.hrtime.bigint().toString(36)}`
    await writeFile(writtenPath, content, { mode: targetMode, flag: 'wx' })
  }
  await chmod(writtenPath, targetMode).catch(() => {})
  return writtenPath
}

export async function writeFileAtomicPreservingMode(
  filePath,
  contents,
  { defaultMode, preserveMode = true, log, expectedVersion } = {},
) {
  const lst = await lstat(filePath).catch(() => null)
  let target
  try {
    target = await realpath(filePath)
  } catch {
    if (lst?.isSymbolicLink()) {
      throw new Error(`Refusing to write to dangling symlink: ${filePath}`)
    }
    target = filePath
  }
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
    if (expectedVersion) {
      const unchanged = await verifyFileVersion(filePath, expectedVersion)
      if (!unchanged) {
        throw new ConcurrentModificationError(filePath)
      }
      if (!expectedVersion.exists) {
        try {
          await link(tmp, target)
          await unlink(tmp).catch(() => {})
          return
        } catch (linkErr) {
          if (linkErr?.code === 'EEXIST') {
            throw new ConcurrentModificationError(filePath)
          }
          if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(linkErr?.code)) {
            throw linkErr
          }
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

export class UserAbortError extends Error {
  constructor() {
    super('Aborted by user')
    this.name = 'UserAbortError'
    this.exitCode = 130
  }
}

export async function discardPendingStdin(stdin) {
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

export function createPrompter(stdin, stdout) {
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

/**
 * Verify a manually supplied token with MegaLens and require a verified Editor credential
 * (Astra FINAL #9, CONFIRM10 #13). Accepts `default` and (for tool-specific installers like
 * `setup claude-code`, `setup antigravity`, `setup codex`) the matching onboarding tool label.
 * Never accepts a GitHub Action token (`github-action`), another tool's label, an unlabeled
 * token, an invalid token, or an unreachable validation server.
 */
export async function validateEditorToken(
  token,
  { fetchImpl = globalThis.fetch, allowedLabels = ['default'] } = {},
) {
  let res
  let data = null
  try {
    res = await fetchImpl(`${VALIDATE_URL}?include_label=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    data = await res.json().catch(() => null)
  } catch (err) {
    return { ok: false, reason: 'network', error: String(err?.message ?? 'connection failed') }
  }
  if (!res.ok || data?.valid !== true) {
    return { ok: false, reason: 'invalid', error: typeof data?.error === 'string' ? data.error : `HTTP ${res.status}` }
  }
  const label = typeof data.label === 'string' ? data.label : null
  if (!label || !allowedLabels.includes(label)) {
    return { ok: false, reason: 'wrong_label', label, allowedLabels }
  }
  return {
    ok: true,
    isPro: !!data.is_pro,
    isPayg: !!data.is_payg,
    planCode: data.plan_code ?? 'free',
    label,
  }
}

export async function resolveToken({
  env,
  prompter,
  errLog,
  validateToken = validateEditorToken,
  allowedLabels = ['default'],
}) {
  const envToken = typeof env.MEGALENS_TOKEN === 'string' ? env.MEGALENS_TOKEN.trim() : ''
  let token = envToken
  if (!token) {
    try {
      token = await prompter.askHidden('  Enter your MegaLens token (ml_tok_...): ')
    } catch (err) {
      return { token: null, exitCode: err?.exitCode === 130 ? 130 : 1 }
    }
  }

  if (!TOKEN_REGEX.test(token)) {
    errLog('  Invalid token format. Expected ml_tok_ followed by 32 hex characters.')
    errLog('  Get your token at https://megalens.ai/app/settings/mcp\n')
    return { token: null, exitCode: 1 }
  }

  const check = await validateToken(token, { allowedLabels })
  if (!check?.ok) {
    if (check?.reason === 'wrong_label') {
      if (check.label === 'github-action') {
        errLog('  This is a GitHub Action token, not an Editor token. It cannot be installed in an editor.')
      } else {
        const expected = allowedLabels.map((l) => `"${l}"`).join(' or ')
        errLog(`  This token is not a verified Editor token (expected label ${expected}). It cannot be installed here.`)
      }
      errLog('  Get your Editor token at https://megalens.ai/app/settings/mcp or run: npx megalens-mcp setup\n')
    } else if (check?.reason === 'network') {
      errLog(`  Could not verify token with MegaLens (${maskTokenSecrets(check.error ?? 'connection failed')}). Nothing was written.\n`)
    } else {
      errLog(`  Token validation failed: ${maskTokenSecrets(check?.error ?? 'invalid token')}. Nothing was written.`)
      errLog('  Get your Editor token at https://megalens.ai/app/settings/mcp\n')
    }
    return { token: null, exitCode: 1 }
  }

  return { token, exitCode: 0 }
}

export function parseUrlOrigin(value) {
  if (typeof value !== 'string') return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/**
 * Canonical JSON serialisation with sorted object keys for structural equality checks
 * (concurrent-edit detection in host setup, Astra CONFIRM10 #11).
 */
export function stableJson(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v) ?? 'null').join(',')}]`
  const keys = Object.keys(value).sort()
  const parts = []
  for (const k of keys) {
    const v = stableJson(value[k])
    if (v !== undefined) parts.push(`${JSON.stringify(k)}:${v}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * Non-credential UI/behaviour fields safe to keep when repointing an existing `megalens` entry
 * from another origin (or a non-URL/stdio entry) to MegaLens. Everything else — static headers,
 * Claude Code's `headersHelper`, `oauth`, `auth*`, `env`, `command`/`args`, stale URL fields,
 * and any future host credential helper — is dropped on an origin change so credentials meant
 * for another host can never be sent to MegaLens (Astra CONFIRM10 #12, CONFIRM11 #12).
 */
const CROSS_ORIGIN_SAFE_FIELDS = new Set([
  'disabled',
  'enabled',
  'disabledTools',
  'enabledTools',
  'autoApprove',
  'alwaysAllow',
  'timeout',
])

/**
 * Merge a MegaLens MCP server entry into `existing[mapKey].megalens` while preserving
 * user-configured non-credential fields (`disabled`, etc.) and other servers.
 *
 * Security (Astra CONFIRM10 #12, CONFIRM11 #12): extra custom headers AND host-specific fields
 * (such as Claude Code's `headersHelper`, `oauth`, `auth*`, `env`, etc.) are preserved ONLY when
 * every existing endpoint URL field (`url`, `httpUrl`, `serverUrl`, `sseUrl`, `baseUrl`) on
 * `prevEntry` parses to the exact same origin as the target MegaLens endpoint. If the origin
 * changed, was absent, was invalid, or mixed multiple origins, old headers and every non-allowlisted
 * field (including `headersHelper`) are dropped so credentials meant for another host (e.g. a
 * proxy API key or dynamic header helper) are never sent to MegaLens. Stale alternate URL keys
 * not set by `entry` and case-variant `authorization` headers are also cleared.
 */
export function mergeMcpServerEntry(existing, mapKey, entry, { defaultFields = {} } = {}) {
  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  const base = isObj(existing) ? existing : {}
  const prevMap = isObj(base[mapKey]) ? base[mapKey] : {}
  const prevEntry = isObj(prevMap.megalens) ? prevMap.megalens : {}
  const prevHeaders = isObj(prevEntry.headers) ? prevEntry.headers : {}

  const urlKeys = ['url', 'httpUrl', 'serverUrl', 'sseUrl', 'baseUrl']
  const entryOrigins = urlKeys
    .filter((k) => entry[k] !== undefined)
    .map((k) => parseUrlOrigin(entry[k]))
  const targetOrigin = entryOrigins.length === 1 ? entryOrigins[0] : null

  const prevUrls = urlKeys
    .filter((k) => prevEntry[k] !== undefined)
    .map((k) => prevEntry[k])
  const sameOrigin =
    targetOrigin !== null &&
    prevUrls.length > 0 &&
    prevUrls.every((u) => parseUrlOrigin(u) === targetOrigin)

  const keptHeaders = {}
  const nextPrevEntry = {}
  if (sameOrigin) {
    for (const [k, v] of Object.entries(prevHeaders)) {
      if (k.toLowerCase() === 'authorization') continue
      keptHeaders[k] = v
    }
    for (const [k, v] of Object.entries(prevEntry)) {
      if (urlKeys.includes(k) && !(k in entry)) continue
      nextPrevEntry[k] = v
    }
  } else {
    for (const [k, v] of Object.entries(prevEntry)) {
      if (CROSS_ORIGIN_SAFE_FIELDS.has(k)) {
        nextPrevEntry[k] = v
      }
    }
  }

  return {
    ...base,
    [mapKey]: {
      ...prevMap,
      megalens: {
        ...defaultFields,
        ...nextPrevEntry,
        ...entry,
        headers: {
          ...keptHeaders,
          ...(isObj(entry.headers) ? entry.headers : {}),
        },
      },
    },
  }
}

export function removeExactInstructionLines(content, exactLines = REMOVABLE_INSTRUCTION_LINES) {
  const targets = Array.isArray(exactLines) ? exactLines : [exactLines]
  const targetSet = new Set(targets)
  const lines = content.split('\n')
  const kept = []
  let removedCount = 0
  let removedBom = false
  const removedSet = new Set()

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const noCr = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const hasBom = i === 0 && noCr.startsWith('\uFEFF')
    const normalized = hasBom ? noCr.slice(1) : noCr
    if (targetSet.has(normalized)) {
      removedCount++
      removedSet.add(normalized)
      if (hasBom) removedBom = true
      continue
    }
    kept.push(raw)
  }

  if (removedCount === 0) {
    return { found: false, nextContent: content, removedCount: 0, removedLines: [] }
  }

  let nextContent = kept.join('\n')
  if (removedBom && nextContent.length > 0 && !nextContent.startsWith('\uFEFF')) {
    nextContent = `\uFEFF${nextContent}`
  }
  const removedLines = targets.filter((t) => removedSet.has(t))
  return { found: true, nextContent, removedCount, removedLines }
}

export const removeExactInstructionLine = removeExactInstructionLines

function joinAfterCut(prefix, suffix) {
  if (!suffix.trim()) {
    return prefix.replace(/[ \t]+$/, '')
  }
  if (!prefix.trim() || (/[ \t]$/.test(prefix) && /^[ \t]/.test(suffix))) {
    return `${prefix}${suffix.replace(/^[ \t]+/, '')}`
  }
  return `${prefix}${suffix}`
}

export function planInstructionLineUpdates(content, { exists = true, platform = process.platform } = {}) {
  const defaultEol = platform === 'win32' ? '\r\n' : '\n'
  const eol = exists && content.length > 0
    ? (content.includes('\r\n') ? '\r\n' : '\n')
    : defaultEol

  if (!exists || content.length === 0) {
    const addLines = [...MEGALENS_INSTRUCTION_LINES]
    return {
      hasChanges: true,
      addLines,
      replacements: [],
      removals: [],
      nextContent: `${addLines.join(eol)}${eol}`,
    }
  }

  const hasV2 = hasMegaLensDecisionLine(content)
  const updatedLines = new Set(MEGALENS_INSTRUCTION_LINES.filter(line => content.includes(line)))
  const upgrades = [[MEGALENS_REVIEW_LINE_V1, MEGALENS_REVIEW_LINE], [DECISION_LINE_V2, DECISION_LINE]]

  const lines = content.split('\n')
  const nextLines = []
  const replacements = []
  const removals = []
  let replacedFirstV1 = false
  let removedBom = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const hadCr = raw.endsWith('\r')
    const noCr = hadCr ? raw.slice(0, -1) : raw
    const hasBom = i === 0 && noCr.startsWith('\uFEFF')
    let noBom = hasBom ? noCr.slice(1) : noCr

    let upgraded = false
    for (const [oldLine, nextLine] of upgrades) {
      while (noBom.includes(oldLine)) {
        upgraded = true
        const start = noBom.indexOf(oldLine)
        const prefix = noBom.slice(0, start)
        const suffix = noBom.slice(start + oldLine.length)
        if (!updatedLines.has(nextLine)) {
          updatedLines.add(nextLine)
          replacements.push({ from: oldLine, to: nextLine })
          noBom = `${prefix}${nextLine}${suffix}`
        } else {
          removals.push(oldLine)
          noBom = joinAfterCut(prefix, suffix)
        }
      }
    }
    if (upgraded && BULLET_QUOTE_WS_PUNCT_ONLY.test(noBom)) {
      if (hasBom) removedBom = true
      continue
    }

    const trimmed = noBom.trim()
    const exactIdx = noBom.indexOf(DECISION_LINE_V1)
    if (exactIdx !== -1) {
      if (!hasV2 && !replacedFirstV1) {
        replacedFirstV1 = true
        const updated =
          noBom.slice(0, exactIdx) +
          DECISION_LINE +
          noBom.slice(exactIdx + DECISION_LINE_V1.length)
        nextLines.push(`${hasBom ? '\uFEFF' : ''}${updated}${hadCr ? '\r' : ''}`)
        replacements.push({ from: DECISION_LINE_V1, to: DECISION_LINE })
      } else {
        let remainder = noBom
        while (remainder.includes(DECISION_LINE_V1)) {
          const idx = remainder.indexOf(DECISION_LINE_V1)
          remainder = joinAfterCut(
            remainder.slice(0, idx),
            remainder.slice(idx + DECISION_LINE_V1.length),
          )
        }
        removals.push(DECISION_LINE_V1)
        if (BULLET_QUOTE_WS_ONLY.test(remainder)) {
          if (hasBom) removedBom = true
        } else {
          nextLines.push(`${hasBom ? '\uFEFF' : ''}${remainder}${hadCr ? '\r' : ''}`)
        }
      }
      continue
    }

    if (isV1DecisionLine(trimmed)) {
      if (!hasV2 && !replacedFirstV1) {
        replacedFirstV1 = true
        const prefix = (noBom.match(V1_LEADING_PREFIX_PATTERN) || ['', ''])[1]
        nextLines.push(`${hasBom ? '\uFEFF' : ''}${prefix}${DECISION_LINE}${hadCr ? '\r' : ''}`)
        replacements.push({ from: trimmed, to: DECISION_LINE })
        continue
      }

      const spanMatch = noBom.match(DECISION_V1_SPAN_PATTERN)
      if (spanMatch) {
        const idx = spanMatch.index ?? 0
        const remainder = joinAfterCut(
          noBom.slice(0, idx),
          noBom.slice(idx + spanMatch[0].length),
        )
        if (BULLET_QUOTE_WS_PUNCT_ONLY.test(remainder)) {
          if (hasBom) removedBom = true
          removals.push(trimmed)
          continue
        }
      }
    }

    nextLines.push(upgraded ? `${hasBom ? '\uFEFF' : ''}${noBom}${hadCr ? '\r' : ''}` : raw)
  }

  let intermediate = nextLines.join('\n')
  if (removedBom && intermediate.length > 0 && !intermediate.startsWith('\uFEFF')) {
    intermediate = `\uFEFF${intermediate}`
  }

  const addLines = []
  if (!hasMegaLensReviewLine(intermediate)) addLines.push(MEGALENS_REVIEW_LINE)
  if (!hasMegaLensDecisionLine(intermediate)) addLines.push(DECISION_LINE)

  const hasChanges = addLines.length > 0 || replacements.length > 0 || removals.length > 0
  let nextContent = intermediate
  if (addLines.length > 0) {
    const base = !intermediate
      ? ''
      : (intermediate.endsWith('\n') ? intermediate : `${intermediate}${eol}`)
    nextContent = `${base}${addLines.join(eol)}${eol}`
  }

  return {
    hasChanges,
    addLines,
    replacements,
    removals,
    nextContent,
  }
}

export async function runAppendInstructionLines({
  filePath,
  promptText,
  dryRun = false,
  prompter,
  platform = process.platform,
  timestamp,
  log,
  errLog,
  written,
  dryRunNotes,
}) {
  const fileLabel = basename(filePath)
  const read = await readOptionalFile(filePath)
  if (read.unreadable) {
    errLog(`  ! ${filePath} could not be read: ${read.unreadable}`)
    errLog(`    Leaving ${fileLabel} untouched.`)
    return { exitCode: 0 }
  }

  const plan = planInstructionLineUpdates(read.content, { exists: read.exists, platform })

  if (!plan.hasChanges) {
    log(`  ${filePath} already has the MegaLens lines. Leaving it unchanged.\n`)
    return { exitCode: 0 }
  }

  const readOnlyReason = read.exists ? await getReadOnlyReason(filePath) : null
  if (readOnlyReason) {
    log(`  ! ${filePath} is read-only (${readOnlyReason}).`)
    log(`    Refusing to replace it; leaving ${fileLabel} unchanged.\n`)
    return { exitCode: 0 }
  }

  if (plan.replacements.length === 0 && plan.removals.length === 0) {
    const plural = plan.addLines.length > 1
    log(`  Proposed ${fileLabel} ${plural ? 'lines' : 'line'} (${filePath}):`)
    for (const line of plan.addLines) {
      log(`    ${line}`)
    }
  } else {
    const totalChanges = plan.addLines.length + plan.replacements.length + plan.removals.length
    log(`  Proposed ${fileLabel} ${totalChanges > 1 ? 'changes' : 'change'} (${filePath}):`)
    for (const line of plan.addLines) {
      log(`    Add this line: ${line}`)
    }
    for (const rep of plan.replacements) {
      log(`    Update this line: ${rep.from} -> ${rep.to}`)
    }
    for (const rem of plan.removals) {
      log(`    Remove outdated line: ${rem}`)
    }
  }
  log('')

  const resolvedPrompt = typeof promptText === 'function' ? promptText(plan) : promptText
  let answer
  try {
    answer = await prompter.askPlain(resolvedPrompt)
  } catch (err) {
    if (err?.exitCode === 130) {
      return { exitCode: 130 }
    }
    throw err
  }

  if (!isYes(answer)) {
    log(`  Skipped ${filePath}.\n`)
    return { exitCode: 0 }
  }

  if (dryRun) {
    dryRunNotes.push(`${filePath} (would ${read.exists ? 'update' : 'create'})`)
    log(`  [dry-run] Would write ${filePath}\n`)
    return { exitCode: 0 }
  }

  try {
    // Re-read before writing AND recheck version after backup and before rename so concurrent
    // edits while the prompt or backup is running are never silently erased.
    const MAX_WRITE_ATTEMPTS = 3
    let backedUp = false
    let saved = false
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const latestRead = await readOptionalFile(filePath)
      if (latestRead.unreadable) {
        errLog(`  ! ${filePath} could not be read: ${latestRead.unreadable}`)
        return { exitCode: 1 }
      }
      let writePlan = plan
      let writeExists = read.exists
      if (attempt > 0 || latestRead.exists !== read.exists || latestRead.content !== read.content) {
        if (read.exists && !latestRead.exists) {
          errLog(`  ! ${filePath} was removed while waiting for confirmation. Leaving it untouched.`)
          return { exitCode: 1 }
        }
        const latestReadOnly = latestRead.exists ? await getReadOnlyReason(filePath) : null
        if (latestReadOnly) {
          errLog(`  ! ${filePath} became read-only (${latestReadOnly}) while waiting for confirmation. Leaving ${fileLabel} untouched.`)
          return { exitCode: 1 }
        }
        writePlan = planInstructionLineUpdates(latestRead.content, { exists: latestRead.exists, platform })
        writeExists = latestRead.exists
        if (!writePlan.hasChanges) {
          log(`  ${filePath} already has the MegaLens lines. Leaving it unchanged.\n`)
          return { exitCode: 0 }
        }
      }
      const target = await realpath(filePath).catch(() => filePath)
      if (writeExists && !backedUp) {
        await backupExistingFile(target, timestamp)
        backedUp = true
        if (!(await verifyFileVersion(filePath, latestRead.version))) {
          continue
        }
      }
      try {
        await writeFileAtomicPreservingMode(filePath, writePlan.nextContent, {
          defaultMode: 0o644,
          preserveMode: true,
          log,
          expectedVersion: latestRead.version,
        })
        saved = true
        break
      } catch (writeErr) {
        if (writeErr?.code === 'ECONCURRENT') {
          continue
        }
        throw writeErr
      }
    }
    if (!saved) {
      errLog(`  ! ${filePath} kept changing while saving; leaving it untouched.`)
      return { exitCode: 1 }
    }
    written.push(filePath)
    log(`  Wrote ${filePath}\n`)
    return { exitCode: 0 }
  } catch (err) {
    errLog(`  ! Failed to write ${filePath}: ${err?.message ?? err}`)
    return { exitCode: 1 }
  }
}

export const runAppendInstructionLine = runAppendInstructionLines

export async function runRemoveInstructionLine({
  filePath,
  hostName,
  lines = REMOVABLE_INSTRUCTION_LINES,
  dryRun = false,
  isTTY,
  prompter,
  timestamp,
  log,
  errLog,
}) {
  const fileLabel = basename(filePath)
  const targetLines = Array.isArray(lines) ? lines : [lines]

  if (!isTTY) {
    log(`\n  MegaLens ${hostName} Setup --remove-line (non-interactive mode: nothing was written)\n`)
    log(`  Remove ${targetLines.length > 1 ? 'these exact lines' : 'this exact line'} from ${filePath}:\n`)
    for (const l of targetLines) {
      log(`    ${l}`)
    }
    log('')
    return { exitCode: 0, written: [], dryRun }
  }

  log(`\n  MegaLens ${hostName} Setup (--remove-line)\n`)
  if (dryRun) {
    log('  [dry-run] No files will be modified.\n')
  }

  const read = await readOptionalFile(filePath)
  if (read.unreadable) {
    errLog(`  ! ${filePath} could not be read: ${read.unreadable}`)
    errLog(`    Leaving ${fileLabel} untouched.`)
    return { exitCode: 0, written: [], dryRun }
  }

  if (!read.exists) {
    log(`  ${filePath} does not exist. Nothing to remove.\n`)
    return { exitCode: 0, written: [], dryRun }
  }

  const removal = removeExactInstructionLines(read.content, targetLines)
  if (!removal.found) {
    log(`  MegaLens lines not found in ${filePath}. Leaving it unchanged.\n`)
    return { exitCode: 0, written: [], dryRun }
  }

  const readOnlyReason = await getReadOnlyReason(filePath)
  if (readOnlyReason) {
    log(`  ! ${filePath} is read-only (${readOnlyReason}).`)
    log(`    Refusing to replace it; leaving ${fileLabel} unchanged.\n`)
    return { exitCode: 0, written: [], dryRun }
  }

  const plural = removal.removedLines.length > 1
  log(`  Will remove from ${filePath}:`)
  for (const removedLine of removal.removedLines) {
    log(`    - ${removedLine}`)
  }
  log('')

  let answer
  try {
    answer = await prompter.askPlain(`  Remove MegaLens ${plural ? 'lines' : 'line'} from ${filePath}? (y/N): `)
  } catch (err) {
    if (err?.exitCode === 130) {
      return { exitCode: 130, written: [], dryRun }
    }
    throw err
  }

  if (!isYes(answer)) {
    log(`  Skipped ${filePath}. Nothing was written.\n`)
    return { exitCode: 0, written: [], dryRun }
  }

  if (dryRun) {
    log(`  [dry-run] Would write ${filePath}\n`)
    return { exitCode: 0, written: [], dryRun }
  }

  try {
    const MAX_WRITE_ATTEMPTS = 3
    let backedUp = false
    let saved = false
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const latestRead = await readOptionalFile(filePath)
      if (latestRead.unreadable) {
        errLog(`  ! ${filePath} could not be read: ${latestRead.unreadable}`)
        return { exitCode: 1, written: [], dryRun }
      }
      if (!latestRead.exists) {
        log(`  ${filePath} no longer exists. Nothing to remove.\n`)
        return { exitCode: 0, written: [], dryRun }
      }
      const latestReadOnly = await getReadOnlyReason(filePath)
      if (latestReadOnly) {
        errLog(`  ! ${filePath} became read-only (${latestReadOnly}) while waiting for confirmation. Leaving ${fileLabel} untouched.`)
        return { exitCode: 1, written: [], dryRun }
      }
      const latestRemoval = removeExactInstructionLines(latestRead.content, targetLines)
      if (!latestRemoval.found) {
        log(`  MegaLens lines not found in ${filePath}. Leaving it unchanged.\n`)
        return { exitCode: 0, written: [], dryRun }
      }
      const target = await realpath(filePath).catch(() => filePath)
      if (!backedUp) {
        await backupExistingFile(target, timestamp)
        backedUp = true
        if (!(await verifyFileVersion(filePath, latestRead.version))) {
          continue
        }
      }
      try {
        await writeFileAtomicPreservingMode(filePath, latestRemoval.nextContent, {
          defaultMode: 0o644,
          preserveMode: true,
          log,
          expectedVersion: latestRead.version,
        })
        saved = true
        break
      } catch (writeErr) {
        if (writeErr?.code === 'ECONCURRENT') {
          continue
        }
        throw writeErr
      }
    }
    if (!saved) {
      errLog(`  ! ${filePath} kept changing while saving; leaving it untouched.`)
      return { exitCode: 1, written: [], dryRun }
    }
    log(`  Removed MegaLens ${plural ? 'lines' : 'line'} from ${filePath}.\n`)
    return { exitCode: 0, written: [filePath], dryRun }
  } catch (err) {
    errLog(`  ! Failed to write ${filePath}: ${err?.message ?? err}`)
    return { exitCode: 1, written: [], dryRun }
  }
}

/**
 * A (Y/n) or (y/N) answer. Empty takes the default; only y/yes is yes; n, no, and anything
 * mistyped is no. (The setup wizard used to skip a tool only on exactly "n", so "no" meant yes.)
 */
export function answerIsYes(answer, defaultYes) {
  const a = String(answer ?? '').trim().toLowerCase()
  if (a === '') return defaultYes
  return a === 'y' || a === 'yes'
}

/**
 * Read one line from a terminal without echoing it. Raw mode only: no readline interface is
 * attached to the output, so nothing typed or pasted is ever written back (Astra FIX 17 #6: the
 * old reader created a readline on stdout, which echoed the pasted token). Prints the prompt and,
 * at the end, one newline. Ctrl+C exits.
 */
export function readHiddenLine({ input = process.stdin, output = process.stdout, prompt = '', exit = (c) => process.exit(c) } = {}) {
  return new Promise((resolve) => {
    const wasRaw = !!input.isRaw
    // Echo off BEFORE the prompt appears: a paste that arrives the moment the prompt shows must
    // never be echoed by the terminal (found when the pty test ran under load).
    input.setRawMode(true)
    output.write(prompt)
    if (typeof input.resume === 'function') input.resume()
    let buf = ''
    const done = (value) => {
      input.removeListener('data', onData)
      input.setRawMode(wasRaw)
      if (typeof input.pause === 'function') input.pause()
      output.write('\n')
      resolve(value)
    }
    const onData = (chunk) => {
      const text = String(chunk)
      for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c === '\n' || c === '\r') return done(buf.trim())
        if (c === '\u0003') {
          input.setRawMode(wasRaw)
          output.write('\n')
          return exit(130)
        }
        if (c === '\u001b') return // an escape sequence (arrow keys): ignore the rest of this chunk
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1)
        else if (c >= ' ') buf += c
      }
    }
    input.on('data', onData)
  })
}
