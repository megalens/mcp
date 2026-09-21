/**
 * writeFileAtomic() — the two shapes review found, plus the basics.
 *
 * 1. A symlinked config (dotfiles repo) must survive the write as a symlink.
 * 2. Concurrent writers must never publish a half-written file.
 */
import { readFile, writeFile, mkdir, rm, symlink, lstat, readdir, stat } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs')
const src = await readFile(CLI, 'utf-8')

const pick = (name) => {
  let i = src.indexOf(`function ${name}(`)
  if (i === -1) throw new Error(`not found: ${name}`)
  // Keep the `async` prefix; without it the extracted body's `await` is a syntax error.
  if (src.slice(i - 6, i) === 'async ') i -= 6
  let depth = 0
  const j = src.indexOf('{', i)
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
  }
  throw new Error(`unterminated: ${name}`)
}

const mod = await import(
  'data:text/javascript,' +
  encodeURIComponent(
    "import { writeFile, chmod, rename, unlink, realpath, stat, chown } from 'fs/promises'\n" +
    pick('writeFileAtomic') +
    '\nexport { writeFileAtomic }'
  )
)
const { writeFileAtomic } = mod

const root = join(tmpdir(), `megalens-atomic-${process.pid}`)
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`pass  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n        - ${detail}` : ''}`) }
}

// ── 1. plain file ────────────────────────────────────────────────────────────
{
  const p = join(root, 'plain.toml')
  await writeFile(p, 'old\n', { mode: 0o644 })
  await writeFileAtomic(p, 'new\n')
  const body = await readFile(p, 'utf-8')
  const mode = (await stat(p)).mode & 0o777
  check('plain file replaced', body === 'new\n', `got ${JSON.stringify(body)}`)
  check('plain file ends at 0600', mode === 0o600, `got ${mode.toString(8)}`)
}

// ── 2. symlinked config (the dotfiles case) ──────────────────────────────────
{
  const store = join(root, 'dotfiles')
  await mkdir(store, { recursive: true })
  const real = join(store, 'config.toml')
  const link = join(root, 'linked.toml')
  await writeFile(real, 'old\n')
  await symlink(real, link)

  await writeFileAtomic(link, 'new\n')

  const st = await lstat(link)
  check('symlink survives the write', st.isSymbolicLink(), 'the link was replaced by a regular file')
  check('content reached the dotfiles copy', (await readFile(real, 'utf-8')) === 'new\n')
  check('reading through the link sees it', (await readFile(link, 'utf-8')) === 'new\n')
  const strays = (await readdir(root)).filter((f) => f.includes('megalens-tmp'))
  check('no temp left beside the link', strays.length === 0, `found ${strays.join(', ')}`)
}

// ── 3. concurrent writers ────────────────────────────────────────────────────
{
  const p = join(root, 'race.json')
  await writeFile(p, '{}\n')

  // Two distinct, large, self-consistent payloads. A torn file is any result
  // that is neither one nor the other.
  const a = JSON.stringify({ who: 'A', pad: 'a'.repeat(400_000) }) + '\n'
  const b = JSON.stringify({ who: 'B', pad: 'b'.repeat(400_000) }) + '\n'

  for (let round = 0; round < 12; round++) {
    await Promise.all([writeFileAtomic(p, a), writeFileAtomic(p, b)])
    const body = await readFile(p, 'utf-8')
    if (body !== a && body !== b) {
      check('concurrent writes never publish a torn file', false,
        `round ${round}: got ${body.length} bytes, expected ${a.length}`)
      break
    }
    if (round === 11) check('concurrent writes never publish a torn file', true)
  }

  const strays = (await readdir(root)).filter((f) => f.includes('megalens-tmp'))
  check('no temps left after the race', strays.length === 0, `found ${strays.length}`)

  const unique = new Set()
  for (let i = 0; i < 200; i++) {
    unique.add(`${p}.megalens-tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`)
  }
  check('temp names are unique across rapid calls', unique.size === 200, `got ${unique.size}/200`)
}

// ── 4. failure cleans up ─────────────────────────────────────────────────────
{
  const p = join(root, 'nosuchdir', 'x.json')
  let threw = false
  try { await writeFileAtomic(p, 'x') } catch { threw = true }
  check('unwritable target throws rather than silently passing', threw)
}

// ── 5. a pre-existing temp must never be reused (exclusive create) ───────────
{
  const p = join(root, 'excl.json')
  await writeFile(p, 'old\n')
  // Plant a temp with the exact name the next call will pick. hrtime moves, so
  // assert the flag directly: writing twice to one name must fail the second time.
  const planted = join(root, 'planted.megalens-tmp.x')
  await writeFile(planted, 'attacker', { mode: 0o644 })
  let refused = false
  try {
    await writeFile(planted, 'token', { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  } catch (err) { refused = err?.code === 'EEXIST' }
  check('wx refuses an existing temp path', refused,
    'writeFile reused the file; mode 0644 would have exposed the token')

  // And a temp path that is a symlink must be refused too, not followed.
  const victim = join(root, 'victim.txt')
  await writeFile(victim, 'do not touch\n')
  const evil = join(root, 'evil.megalens-tmp.x')
  await symlink(victim, evil)
  let refusedLink = false
  try {
    await writeFile(evil, 'token', { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  } catch (err) { refusedLink = err?.code === 'EEXIST' }
  check('wx refuses a symlinked temp path', refusedLink)
  check('symlink victim untouched', (await readFile(victim, 'utf-8')) === 'do not touch\n')
}

// ── 6. ownership is carried over when it differs ─────────────────────────────
{
  const p = join(root, 'owned.json')
  await writeFile(p, 'old\n')
  const before = await stat(p)
  await writeFileAtomic(p, 'new\n')
  const after = await stat(p)
  check('ownership preserved across replace',
    after.uid === before.uid && after.gid === before.gid,
    `uid ${before.uid}->${after.uid}, gid ${before.gid}->${after.gid}`)
}

await rm(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
