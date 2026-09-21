/**
 * Every TOML shape the two reviewers raised, run through the real
 * stripTomlTable() + the append the installer performs.
 */
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs')

const src = await readFile(CLI, 'utf-8')
// Pull the three functions out of the CLI without running its main().
const pick = (name) => {
  const i = src.indexOf(`function ${name}(`)
  if (i === -1) throw new Error(`not found: ${name}`)
  let depth = 0, j = src.indexOf('{', i)
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
  }
  throw new Error(`unterminated: ${name}`)
}
const mod = await import(
  'data:text/javascript,' +
  encodeURIComponent(
    [pick('scanTomlLine'), pick('tomlHeaderPath'), pick('stripTomlTable')].join('\n') +
    '\nexport { stripTomlTable, tomlHeaderPath }'
  )
)
const { stripTomlTable } = mod

const NEW_BLOCK =
  '\n[mcp_servers.megalens]\nurl = "https://megalens.ai/api/mcp?ide=codex"\n' +
  'http_headers = { "Authorization" = "Bearer ml_tok_NEW" }\n'

const apply = (text) => {
  const without = stripTomlTable(text, 'mcp_servers.megalens')
  if (without === null) return { bailed: true }
  return { bailed: false, result: without.replace(/\s+$/, '') + '\n' + NEW_BLOCK }
}

const OLD = '[mcp_servers.megalens]\nurl = "u"\nhttp_headers = { "Authorization" = "Bearer ml_tok_OLD" }\n'

const cases = [
  ['plain block, rotation',            OLD,                                         { gone: 'ml_tok_OLD', has: 'ml_tok_NEW', blocks: 1 }],
  ['block at EOF, no trailing NL',     'model = "x"\n' + OLD.trimEnd(),             { gone: 'ml_tok_OLD', has: 'ml_tok_NEW', blocks: 1, keep: ['model = "x"'] }],
  ['block followed by another table',  OLD + '\n[other]\nk = 1\n',                  { gone: 'ml_tok_OLD', blocks: 1, keep: ['[other]', 'k = 1'] }],
  ['HEADER WITH TRAILING COMMENT',     '[mcp_servers.megalens] # remote\nurl = "u"\n', { blocks: 1, keep: [] }],
  ['spaced header',                    '[ mcp_servers.megalens ]\nurl = "u"\n',     { blocks: 1 }],
  ['quoted key header',                '[mcp_servers."megalens"]\nurl = "u"\n',     { blocks: 1 }],
  ['array-of-tables [[...]]',          '[[mcp_servers.megalens]]\nurl = "u"\n',     { blocks: 1, noArray: true }],
  ['MULTILINE STRING WITH FAKE HEADER',
    'instructions = """\nExample:\n[mcp_servers.megalens]\nKeep this example.\n"""\nmodel = "keep-me"\n',
    // 2 = the fake one preserved inside the string (correct) + the real appended block.
    { keep: ['Keep this example.', 'model = "keep-me"', 'instructions = """'], blocks: 2 }],
  ['MULTILINE ARRAY INSIDE OUR TABLE',
    '[mcp_servers.megalens]\nnested = [\n  [1, 2],\n]\nurl = "u"\n\n[after]\nz = 9\n',
    { gone: '[1, 2]', keep: ['[after]', 'z = 9'], blocks: 1 }],
  ['commented-out header',             '# [mcp_servers.megalens]\nmodel = "x"\n',   { keep: ['# [mcp_servers.megalens]', 'model = "x"'], blocks: 1 }],
  ['neighbours megalens2 / megalensx',
    '[mcp_servers.megalens2]\nu = 1\n\n[mcp_servers.megalensx]\nu = 2\n',
    { keep: ['[mcp_servers.megalens2]', '[mcp_servers.megalensx]'], blocks: 1 }],
  ['sub-table removed',                OLD + '[mcp_servers.megalens.env]\nA = "1"\n\n[keep]\nq = 1\n', { gone: 'A = "1"', keep: ['[keep]'], blocks: 1 }],
  ['table declared twice',             OLD + '\n' + OLD,                            { gone: 'ml_tok_OLD', blocks: 1 }],
  ['CRLF file',                        OLD.replace(/\n/g, '\r\n'),                  { gone: 'ml_tok_OLD', blocks: 1 }],
  ['empty file',                       '',                                          { has: 'ml_tok_NEW', blocks: 1 }],
  ['UNTERMINATED string (must bail)',  'x = """\nnever closed\n',                   { bail: true }],
  ['UNTERMINATED array (must bail)',   'x = [\n1,\n',                               { bail: true }],
]

let pass = 0, fail = 0
for (const [name, input, want] of cases) {
  const got = apply(input)
  const problems = []

  if (want.bail) {
    if (!got.bailed) problems.push('expected bail-out, wrote the file instead')
  } else {
    if (got.bailed) problems.push('bailed out unexpectedly')
    else {
      const r = got.result
      const blocks = (r.match(/^\s*\[\[?mcp_servers\.megalens\]\]?/gm) || []).length
      if (want.blocks !== undefined && blocks !== want.blocks) problems.push(`megalens headers = ${blocks}, want ${want.blocks}`)
      if (want.noArray && /\[\[mcp_servers\.megalens\]\]/.test(r)) problems.push('array-of-tables header survived')
      if (want.gone && r.includes(want.gone)) problems.push(`should have removed ${JSON.stringify(want.gone)}`)
      if (want.has && !r.includes(want.has)) problems.push(`missing ${JSON.stringify(want.has)}`)
      for (const k of want.keep || []) if (!r.includes(k)) problems.push(`lost user content ${JSON.stringify(k)}`)
      // structural sanity: every multi-line string delimiter still paired
      const triples = (r.match(/"""/g) || []).length
      if (triples % 2 !== 0) problems.push('left an unterminated """ string')
    }
  }

  if (problems.length) { fail++; console.log(`FAIL  ${name}`); for (const p of problems) console.log(`        - ${p}`) }
  else { pass++; console.log(`pass  ${name}`) }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
