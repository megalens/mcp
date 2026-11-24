# megalens-mcp

MegaLens is a second reviewer for your code. It reads your change and the code around it and tells you
what could break. Use it alongside your current reviewer.

Works with Claude Code, Codex CLI, Cursor, Gemini CLI and Lovable, and with any tool that supports
OAuth MCP connectors, such as ChatGPT and Claude.ai. GitHub Copilot is coming soon.

3 reviews free, no card. Applies to Standard reviews.

## Quick Start

```bash
npx megalens-mcp setup
```

The setup wizard:
1. Detects installed tools and asks which to set up
2. Opens megalens.ai in your browser: sign in, check the code matches your terminal, click Approve
   (over SSH or without a browser it prints the link; open it on any device)
3. Writes the new editor token straight into each tool's config. You never see or copy it.

After you approve, the terminal shows the account you approved with and asks you to confirm it
before any token is made. Setup never reads or reuses a token already in a config: every run
makes a new editor token through the browser, and every tool you choose gets it. If you keep a tool
that already has MegaLens, setup will not replace your editor token (that tool may be using it):
if the browser approval would replace it, setup stops before anything is created or revoked. A
config file inside a git repository (and not ignored there) is only written if you say yes.

`npx megalens-mcp setup --manual` keeps the old way: paste a token from
[MCP Setup](https://megalens.ai/app/settings/mcp). The token is not shown while you paste it.


## Supported Tools

| Tool | Status | Config File | Auto-detected |
|------|--------|-------------|---------------|
| Claude Code | Supported | `~/.claude.json` | Yes |
| Codex CLI | Supported | `~/.codex/config.toml` | Yes |
| Cursor | Supported | `~/.cursor/mcp.json` | Yes |
| Gemini CLI | Supported | `~/.gemini/settings.json` | Yes |
| Lovable | Supported | None (a form in Lovable) | No, see below |
| ChatGPT, Claude.ai and other OAuth connectors | Any tool that supports OAuth MCP connectors | None (a connector in the app) | No, see below |
| GitHub Copilot (VS Code) | **Coming soon**, not supported yet | Your VS Code user `mcp.json` (Linux `~/.config/Code/User/mcp.json`, macOS `~/Library/Application Support/Code/User/mcp.json`, Windows `%APPDATA%\Code\User\mcp.json`) | Only if that file already exists. Never the project's `.vscode/mcp.json`: that file is often committed, and the token would go with it |

If no tool is detected, the wizard lets you pick one and creates the config file. The wizard can also
write configs for Windsurf and Grok Build. Those are not supported or tested.

**Lovable** needs no config file and no wizard. Paste the server URL and your token into Lovable's
MCP connector form. Steps: [megalens.ai/integrations/lovable](https://megalens.ai/integrations/lovable)

**ChatGPT, Claude.ai and other OAuth connectors** need no token and no wizard. Add
`https://megalens.ai/api/mcp` as a connector, then sign in to MegaLens and approve. Steps:
[megalens.ai/integrations/oauth-connectors](https://megalens.ai/integrations/oauth-connectors)

## Manual Setup

The tools use two config languages and three different top-level keys, which is why the wizard
exists.

**Keep the `?ide=` on each URL.** It tells MegaLens which tool the review came from. It does not
change how your review runs: it is the same whichever tool you call it from.

### Claude Code

Run this once. The `--scope user` flag makes MegaLens available in every project:

```bash
claude mcp add --transport http --scope user megalens "https://megalens.ai/api/mcp?ide=claude-code" \
  --header "Authorization: Bearer ml_tok_your_token_here"
```

Or in `.mcp.json` (project) / `~/.claude.json` (user):

```json
{
  "mcpServers": {
    "megalens": {
      "type": "http",
      "url": "https://megalens.ai/api/mcp?ide=claude-code",
      "headers": {
        "Authorization": "Bearer ml_tok_your_token_here"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` or `.cursor/mcp.json`. **No `type` field.** Cursor does not use one.

`npx megalens-mcp setup` writes only `~/.cursor/mcp.json`. It never writes a project `.cursor/mcp.json` (those are often committed). If one in the current folder or above has a MegaLens entry, setup will not replace your editor token, so that project keeps working. Before any replace, setup also asks in the terminal (default no).

The entry:

```json
{
  "mcpServers": {
    "megalens": {
      "url": "https://megalens.ai/api/mcp?ide=cursor",
      "headers": {
        "Authorization": "Bearer ml_tok_your_token_here"
      }
    }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json`. Gemini CLI uses `httpUrl`, not `url`:

```json
{
  "mcpServers": {
    "megalens": {
      "httpUrl": "https://megalens.ai/api/mcp?ide=gemini-cli",
      "headers": {
        "Authorization": "Bearer ml_tok_your_token_here"
      }
    }
  }
}
```

### GitHub Copilot in VS Code (coming soon, not supported yet)

GitHub Copilot is coming soon. If you want to try it early, use your VS Code **user** `mcp.json` (see the table above), not the project's `.vscode/mcp.json`, which is often committed with the project. **The top-level key
is `servers`, not `mcpServers`.** A config written for Claude Code or Cursor will not be read here:

```json
{
  "servers": {
    "megalens": {
      "type": "http",
      "url": "https://megalens.ai/api/mcp?ide=copilot",
      "headers": {
        "Authorization": "Bearer ml_tok_your_token_here"
      }
    }
  }
}
```

### Codex

`~/.codex/config.toml` or `.codex/config.toml`. **TOML, not JSON:**

```toml
[mcp_servers.megalens]
url = "https://megalens.ai/api/mcp?ide=codex"
http_headers = { "Authorization" = "Bearer ml_tok_your_token_here" }
```

### Paying for reviews

3 reviews free, no card. Applies to Standard reviews. After that, a review uses credits.

- Plans give you credits every month: Plus $19 a month for 20 credits, Pro $69 for 80, Max $199 for 250.
- Pay as you go: $1.25 a credit, from $5 (4 credits), no extra fee. Credits you buy never expire.
- A Standard review uses 1 credit and a Deep review uses 8. Reviews from this connector use 1 to 3
  credits, depending on the size of what you send.

See [current pricing](https://megalens.ai/pricing).

## Commands

| Command | Description |
|---------|-------------|
| `megalens-mcp setup` | Browser sign-in; the token goes straight into your tools' configs |
| `megalens-mcp setup --manual` | Same, but you paste a token |
| `megalens-mcp setup codex` | Interactive Codex setup (`config.toml` + `AGENTS.md`) |
| `megalens-mcp setup claude-code` | Interactive Claude Code setup (writes `~/.claude.json` directly + `CLAUDE.md`) |
| `megalens-mcp setup antigravity` | Interactive Antigravity setup (writes `~/.gemini/config/mcp_config.json` directly + `GEMINI.md`), alias `setup agy` |
| `megalens-mcp validate` | Test your token connectivity |
| `megalens-mcp config` | Show current config status |

### `setup codex`

Usage:

```bash
npx megalens-mcp setup codex [--replace-token] [--remove-line] [--dry-run] [-h|--help]
```

- Uses `$CODEX_HOME` if set, otherwise `~/.codex`.
- Reads `MEGALENS_TOKEN` from the environment or prompts for your token without echoing it.
- `--replace-token`: updates `http_headers` in an existing `[mcp_servers.megalens]` table.
- `--remove-line`: removes the MegaLens review lines from `$CODEX_HOME/AGENTS.md` after confirmation, saving a `.bak-*` backup first.
- `--dry-run`: previews changes without modifying any files.

What it writes:

- `$CODEX_HOME/config.toml`: adds `[mcp_servers.megalens]` with `url = "https://megalens.ai/api/mcp?ide=codex"` and `http_headers = { "Authorization" = "Bearer <token>" }` (or updates `http_headers` with `--replace-token`). Writes atomically with `0600` permissions (tightening existing `config.toml` files to `0600` when the token is written) and saves a `.bak-*` backup before editing an existing file.
- After you say yes, setup adds or updates the MegaLens lines in `$CODEX_HOME/AGENTS.md`. They limit MegaLens review offers to one per task and skip them for MegaLens fix prompts or requests to just fix it. The agent waits for your yes before running a review it offered.
  Saves a `.bak-*` backup before editing an existing file. If `$CODEX_HOME/AGENTS.override.md` exists, prints a note that Codex may prefer it.

Consent:

- Interactive TTY only (`--yes` is not supported). When run without a TTY, it writes nothing and prints manual setup steps.
- Shows a masked preview before each file change and requires an explicit `y` at separate confirmation prompts (`y/n` for `config.toml`, `y/N` for `AGENTS.md`). Pending stdin type-ahead is discarded before each prompt, and `Ctrl-C` aborts the run with exit code `130`.

### `setup claude-code`

Usage:

```bash
npx megalens-mcp setup claude-code [--remove-line] [--dry-run] [-h|--help]
```

- Uses `$CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`, for `CLAUDE.md`, and `$CLAUDE_CONFIG_DIR/.claude.json` (or `~/.claude.json`) for the MCP config.
- Reads `MEGALENS_TOKEN` from the environment or prompts for your verified Editor token (`default` label) without echoing it.
- Writes the private JSON config directly (atomic, mode `0600`, preserving existing settings and servers; never passes the token in child-process arguments). Backups of files inside git repositories are stored outside the repository.
- Asks separately (default No) before appending the missing MegaLens review lines to `$CLAUDE_CONFIG_DIR/CLAUDE.md` (or `~/.claude/CLAUDE.md`), saving a `.bak-*` backup and preserving line endings and permissions. Use `--remove-line` to remove those lines later.

### `setup antigravity` (alias `setup agy`)

Usage:

```bash
npx megalens-mcp setup antigravity [--remove-line] [--dry-run] [-h|--help]
npx megalens-mcp setup agy [--remove-line] [--dry-run] [-h|--help]
```

- Reads `MEGALENS_TOKEN` from the environment or prompts for your verified Editor token (`default` label) without echoing it.
- Checks `~/.gemini/config/mcp_config.json`. If that file is invalid JSON, leaves everything for Antigravity untouched and says so.
- Writes `~/.gemini/config/mcp_config.json` directly (atomic, mode `0600`, preserving existing settings and servers; never passes the token in child-process arguments). Backups of files inside git repositories are stored outside the repository.
- Asks separately (default No) before appending the missing MegaLens review lines to `~/.gemini/GEMINI.md`, saving a `.bak-*` backup and preserving line endings and permissions. Gemini CLI also reads `~/.gemini/GEMINI.md`, so those lines affect Gemini CLI too. Use `--remove-line` to remove those lines later.

## How It Works

You ask for a review. MegaLens reads the change and related files with read-only tools and returns one
findings list. Each finding says what is wrong, how it would fail, and where.

MegaLens reports; it does not change your code. Your own tool stays the one that decides what to do
next. Results vary from run to run, so use MegaLens alongside your current reviewer.

## Requirements

- Node.js 18+ (only for the setup wizard; manual setup needs nothing)
- A MegaLens account: [megalens.ai](https://megalens.ai). 3 reviews free, no card

## Links

- [Dashboard](https://megalens.ai/app)
- [MCP Settings](https://megalens.ai/app/settings/mcp)
- [Integrations](https://megalens.ai/integrations)
