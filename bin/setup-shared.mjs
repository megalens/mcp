import { readFile, writeFile, copyFile, mkdir, chmod, rename, unlink, realpath, stat, lstat, chown, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createInterface } from 'node:readline'

export const MEGALENS_REVIEW_LINE =
  'After you change code that handles money, sign-in, user data or database migrations, and before the user commits it, offer a MegaLens review and wait for a yes before running it.'

export const DECISION_LINE =
  'Before you or the user settle a decision that is hard to undo (choosing a database or data model, adding sign-in or payments, picking a major library or architecture), starting a new project, or doing deep research, offer a MegaLens review once for that task and wait for a yes before running it. Do not offer it for small questions or routine edits.'

export const DECISION_LINE_V1 =
  'When the user is making a decision that is hard to undo (a data model, architecture, security, a major dependency), starting a new project, or asking for deep research, offer a MegaLens review once for that task and wait for a yes before running it. Do not offer it for small questions or routine edits.'

export const MEGALENS_INSTRUCTION_LINES = [MEGALENS_REVIEW_LINE, DECISION_LINE]
export const REMOVABLE_INSTRUCTION_LINES = [MEGALENS_REVIEW_LINE, DECISION_LINE, DECISION_LINE_V1]

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
  return trimmed === DECISION_LINE || DECISION_V2_PATTERN.test(trimmed)
}

function isCodeReviewLine(trimmed) {
  return (
    trimmed === MEGALENS_REVIEW_LINE ||
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

export async function readOptionalFile(filePath) {
  try {
    const buf = await readFile(filePath)
    const content = utf8FatalDecoder.decode(buf)
    return { exists: true, content, unreadable: null }
  } catch (err) {
    if (err?.code === 'ENOENT') {
      const lst = await lstat(filePath).catch(() => null)
      if (lst?.isSymbolicLink()) {
        return { exists: true, content: '', unreadable: 'dangling symlink (target does not exist)' }
      }
      return { exists: false, content: '', unreadable: null }
    }
    return { exists: true, content: '', unreadable: String(err?.message ?? err) }
  }
}

export async function backupExistingFile(targetPath, timestamp) {
  const backupPath = `${targetPath}.bak-${timestamp}`
  const existingStat = await stat(targetPath)
  await copyFile(targetPath, backupPath)
  await chmod(backupPath, existingStat.mode & 0o777).catch(() => {})
  return backupPath
}

export async function writeFileAtomicPreservingMode(filePath, contents, { defaultMode, preserveMode = true, log }) {
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

export async function resolveToken({ env, prompter, errLog }) {
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

  return { token, exitCode: 0 }
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
    const noBom = hasBom ? noCr.slice(1) : noCr
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

    nextLines.push(raw)
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
    const target = await realpath(filePath).catch(() => filePath)
    if (read.exists) {
      await backupExistingFile(target, timestamp)
    }
    await writeFileAtomicPreservingMode(filePath, plan.nextContent, {
      defaultMode: 0o644,
      preserveMode: true,
      log,
    })
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
    const target = await realpath(filePath).catch(() => filePath)
    await backupExistingFile(target, timestamp)
    await writeFileAtomicPreservingMode(filePath, removal.nextContent, {
      defaultMode: 0o644,
      preserveMode: true,
      log,
    })
    log(`  Removed MegaLens ${plural ? 'lines' : 'line'} from ${filePath}.\n`)
    return { exitCode: 0, written: [filePath], dryRun }
  } catch (err) {
    errLog(`  ! Failed to write ${filePath}: ${err?.message ?? err}`)
    return { exitCode: 1, written: [], dryRun }
  }
}
