/**
 * Browser sign-in for MegaLens CLIs (RFC 8628 style device authorization).
 *
 * KEEP IN SYNC: this file is copied word for word to packages/engine-v2/src/device-login.mjs
 * (two npm packages, no shared dependency). test/device-login.test.ts fails if they differ.
 *
 * 1. POST {base}/api/device/start -> device_code (secret, kept in memory only) + user code.
 * 2. Show the user code, open {base}/device?code=XXXX-XXXX in the browser (the user code is not a
 *    secret; the URL is built from OUR base, never from a server-sent URL).
 * 3. Poll POST {base}/api/device/token with the device_code in the body until approved, denied
 *    or expired.
 * 4. After approval the server names the approving account BEFORE making a token. The caller's
 *    confirmAccount(account) decides: yes -> one more poll with confirm=true returns the token
 *    once, in the body, to the caller in memory; no -> a cancel poll, and nothing is created.
 * 5. The token must carry exactly the label for this client (editor: default, Action:
 *    github-action). Anything else is refused before the caller can save it.
 *
 * Never prints, logs or passes the token as an argument. Errors are masked before printing. The
 * browser opener gets only the few environment variables it needs (an allowlist).
 */
import { spawn } from 'node:child_process'
import { hostname } from 'node:os'

export const DEFAULT_API_BASE = 'https://megalens.ai'

/** The only label each client may receive. Mirrors device_auth_label in SQL. */
export const EXPECTED_LABEL = { 'megalens-mcp': 'editor:', 'megalens-review': 'github-action' }

/** Editor tokens are per-installation (`editor:<12-hex>`); Action tokens are `github-action`. */
export function isExpectedLabel(client, label) {
  if (typeof label !== 'string') return false
  if (client === 'megalens-mcp') return /^editor:[0-9a-f]{12}$/.test(label)
  if (client === 'megalens-review') return label === 'github-action'
  return false
}

export class DeviceLoginError extends Error {
  constructor(message, code = 'failed') {
    super(message)
    this.code = code
  }
}

/**
 * The one issuer (Astra FIX 4, cross-issuer): sign-in always talks to production. There is no
 * override (the old MEGALENS_API_BASE is gone and ignored), so a token from a staging or test
 * server can never be issued here and then written into an editor or a repository secret. Tests
 * route this origin to a local fake server from outside the package (test/helpers/route-production.mjs).
 */
export const API_BASE = DEFAULT_API_BASE

/** Only the hostname's safe characters, as a hint for the approve page. Never anything else. */
export function deviceNameHint() {
  try {
    return hostname().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || null
  } catch {
    return null
  }
}

/**
 * Should we try to open a browser here? Not over SSH without a display, not when asked not to.
 * The URL and code are printed either way, so the user can open it on any device.
 */
export function canOpenBrowser(env = process.env, platform = process.platform) {
  if (env.MEGALENS_NO_BROWSER === '1') return false
  if (platform === 'darwin' || platform === 'win32') return !(env.SSH_CONNECTION || env.SSH_TTY)
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}

/**
 * The only variables the system opener (xdg-open, open, rundll32) and the browser it starts get
 * (Astra FIX 15 #16): where programs are, the user's home, the desktop session, the locale, and
 * BROWSER. Enumerated one by one; no prefix rule (`XDG_*` let `XDG_API_TOKEN` through), except the
 * standard locale categories `LC_*`, matched by exact name.
 */
const BROWSER_ENV_EXACT = new Set([
  'PATH', 'HOME', 'LANG', 'LANGUAGE', 'BROWSER',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY',
  'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
  // Windows: the opener cannot start without these.
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
])

/**
 * The environment the browser opener gets: ONLY the variables above (Astra FIX 12 #16). A denylist
 * missed SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL; an allowlist cannot miss what it never passes.
 */
export function browserEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    if (BROWSER_ENV_EXACT.has(k.toUpperCase())) out[k] = v
  }
  return out
}

/** Open a URL with the system opener. Best effort, never throws, never waits. */
export function openBrowser(url, platform = process.platform, env = process.env) {
  // Only our own https/http URL with a user code in it: nothing a shell could read as syntax,
  // and no shell is used anyway.
  if (!/^https:\/\/megalens\.ai\/device\?code=[A-Z]{4}-[A-Z]{4}$/.test(url)) return false
  try {
    const [cmd, args] =
      platform === 'darwin' ? ['open', [url]]
      : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]]
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false, env: browserEnv(env) })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

async function postJson(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    // A server that never answers must not hang the CLI past its own expiry.
    signal: AbortSignal.timeout(30_000),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status, data }
}

/** The account name as the server sent it, made safe to print: no control characters, bounded. */
function cleanAccount(v) {
  if (typeof v !== 'string') return null
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 200)
  return s || null
}

/**
 * Run the sign-in. Returns { token, label, replaced, account }. Throws DeviceLoginError (message
 * safe to print).
 *
 * @param {object} o
 * @param {'megalens-mcp'|'megalens-review'} o.client
 * @param {string} [o.repo]  owner/repo, shown on the approve page (Action setup only)
 * @param {(line: string) => void} o.log
 * @param {(account: string, info: { replaces: boolean }) => Promise<boolean|null>} o.confirmAccount
 *   asked once, after approval and before any token exists: is this the account you meant? null
 *   (no answer, input ended) cancels the request like a no. `replaces`: the approval would revoke
 *   the account's current token of this kind.
 * @param {boolean} [o.allowReplace]  false: when the approval would replace the current token (or
 *   the server does not say that it would not), cancel before anything is created or revoked.
 */
export async function deviceLogin({
  client,
  repo = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = (s) => process.stderr.write(s + '\n'),
  open = openBrowser,
  sleep = sleepMs,
  now = () => Date.now(),
  platform = process.platform,
  confirmAccount,
  allowReplace = true,
} = {}) {
  const expectedLabel = EXPECTED_LABEL[client]
  if (!expectedLabel) throw new DeviceLoginError('Unknown client.', 'config')
  if (typeof confirmAccount !== 'function') throw new DeviceLoginError('No account confirmation step.', 'config')
  const base = API_BASE
  let start
  try {
    start = await postJson(fetchImpl, `${base}/api/device/start`, { client, device_name: deviceNameHint(), repo })
  } catch {
    throw new DeviceLoginError(`Could not reach ${base}. Check your connection and try again.`, 'network')
  }
  if (start.status === 404) throw new DeviceLoginError('Browser sign-in is not available yet. Use --manual to paste a token instead.', 'unavailable')
  if (start.status === 429) throw new DeviceLoginError('Too many sign-ins from this network. Wait 10 minutes and try again.', 'rate_limited')
  const s = start.data ?? {}
  if (start.status !== 200 || typeof s.device_code !== 'string' || typeof s.user_code !== 'string' || !/^[A-Z]{4}-[A-Z]{4}$/.test(s.user_code)) {
    throw new DeviceLoginError('MegaLens could not start the sign-in. Try again, or use --manual.', 'failed')
  }
  const deviceCode = s.device_code
  const expiresAt = now() + Math.min(Math.max(Number(s.expires_in) || 600, 60), 900) * 1000
  let interval = Math.min(Math.max(Number(s.interval) || 3, 1), 30)

  const url = `${base}/device?code=${s.user_code}`
  log('')
  log(`  Your code: ${s.user_code}`)
  const opened = canOpenBrowser(env, platform) && open(url, platform, env)
  log(opened ? `  Opening ${url}` : `  Open this page on any device: ${url}`)
  log('  Sign in, check the code matches, and click Approve.')
  if (opened) log(`  If the browser did not open, go to ${url} yourself.`)
  log('  Waiting for approval (expires in 10 minutes, Ctrl+C to stop)...')

  const mayHaveReplaced =
    client === 'megalens-review'
      ? ' Your previous GitHub Action token may already have been replaced, so run npx megalens-review init --replace-secret to finish.'
      : ' Your previous editor token may already have been replaced, so run setup again to update your tools.'
  let confirmed = null // the account the user said yes to
  let confirmedReplaces = false
  let confirmAttempts = 0
  const endErr = (msg, code) => new DeviceLoginError(confirmed && confirmedReplaces ? `${msg}${mayHaveReplaced}` : msg, code)
  while (now() < expiresAt) {
    if (!confirmed) await sleep(interval * 1000)
    let poll
    try {
      if (confirmed) confirmAttempts++
      poll = await postJson(fetchImpl, `${base}/api/device/token`, confirmed ? { device_code: deviceCode, confirm: true } : { device_code: deviceCode })
    } catch {
      if (confirmed) await sleep(interval * 1000)
      continue // a network blip: keep polling until expiry
    }
    const d = poll.data ?? {}
    if (poll.status === 200 && typeof d.access_token === 'string' && /^ml_tok_[0-9a-f]{32}$/i.test(d.access_token)) {
      // Never hand over a token the user did not confirm, or one with the wrong (or no) label.
      if (!confirmed) throw new DeviceLoginError('MegaLens sent a token before you confirmed the account, so nothing was saved. Run the command again.', 'unconfirmed')
      if (!isExpectedLabel(client, d.label)) {
        if (d.replaced === true) confirmedReplaces = true
        throw endErr('MegaLens returned the wrong kind of token, so nothing was saved. Run the command again.', 'wrong_label')
      }
      return { token: d.access_token, label: d.label, replaced: d.replaced === true, account: cleanAccount(d.account) ?? confirmed }
    }
    switch (d.error) {
      case 'confirm_account': {
        const account = cleanAccount(d.account)
        if (!account) throw new DeviceLoginError('MegaLens did not say which account approved, so nothing was saved. Run the command again.', 'failed')
        if (confirmed) continue
        if (d.label !== undefined && d.label !== null && !isExpectedLabel(client, d.label)) {
          await postJson(fetchImpl, `${base}/api/device/token`, { device_code: deviceCode, cancel: true }).catch(() => {})
          throw new DeviceLoginError('MegaLens offered the wrong kind of token, so nothing was created. Run the command again.', 'wrong_label')
        }
        // The server says at this step whether redeeming would revoke the current token. When
        // the caller cannot allow that, only an explicit "no replace" goes on (Astra FIX 15 #15).
        const replaces = d.replaces === true
        if (!allowReplace && d.replaces !== false) {
          await postJson(fetchImpl, `${base}/api/device/token`, { device_code: deviceCode, cancel: true }).catch(() => {})
          throw new DeviceLoginError('Nothing was created or revoked: approving would replace your current token, and you chose to keep a tool that may use it.', 'would_replace')
        }
        let answer = null
        try {
          answer = await confirmAccount(account, { replaces })
        } catch {
          answer = null
        }
        if (answer === true) {
          confirmed = account
          confirmedReplaces = replaces
          continue
        }
        await postJson(fetchImpl, `${base}/api/device/token`, { device_code: deviceCode, cancel: true }).catch(() => {})
        if (answer === false) {
          throw new DeviceLoginError(`Nothing was created: you said ${account} is not your account. Sign out of it in the browser and run the command again.`, 'wrong_account')
        }
        // No answer (input ended): never a yes (Astra FIX 12 #8).
        throw new DeviceLoginError('No answer to the account question, so nothing was created. Run the command again in a terminal.', 'no_answer')
      }
      case 'authorization_pending':
        continue
      case 'slow_down':
        interval = Math.min(interval + 5, 30)
        if (confirmed) await sleep(interval * 1000)
        continue
      case 'access_denied':
        throw endErr(confirmed && confirmedReplaces ? 'The sign-in failed. Run the command again.' : 'The sign-in was denied in the browser. Nothing was changed.', 'denied')
      case 'expired_token':
        throw endErr('The sign-in expired. Run the command again.', 'expired')
      case 'conflict':
        if (confirmAttempts > 1 && confirmedReplaces) throw endErr('The sign-in failed. Run the command again.', 'conflict')
        throw new DeviceLoginError('Your MegaLens tokens changed while you were signing in, so nothing was replaced. Run the command again.', 'conflict')
      case 'too_many_tokens':
        throw new DeviceLoginError('You have reached the maximum number of active editor tokens (50). Revoke unused ones in MCP Setup and try again.', 'too_many_tokens')
      default:
        if (poll.status >= 500) {
          if (confirmed) await sleep(interval * 1000)
          continue
        }
        throw endErr('The sign-in failed. Run the command again.', 'failed')
    }
  }
  throw endErr('The sign-in expired. Run the command again.', 'expired')
}
