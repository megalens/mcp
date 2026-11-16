# megalens-mcp

Code review from a panel of AI models, inside the AI tool you already use. MegaLens selects up to four
AI models from different companies (such as Anthropic, OpenAI and Google) to review your code, and reports where they agree and where they
disagree. On Free, MegaLens selects two reviewing models.

Works with Claude Code, Codex CLI, Cursor, Gemini CLI and Lovable, and with any tool that supports
OAuth MCP connectors, such as ChatGPT and Claude.ai. GitHub Copilot is coming soon.

Your first review is free, with no card.

## Quick Start

```bash
npx megalens-mcp setup
```

The setup wizard:
1. Asks for your MegaLens token ([get one here](https://megalens.ai/app/settings/mcp))
2. Detects installed tools automatically
3. Writes the correct config for each tool

The wizard does not ask for an OpenRouter key. To use your own key, add one header by hand: see
[Adding your own OpenRouter key](#adding-your-own-openrouter-key-free--byok).

## Supported Tools

| Tool | Status | Config File | Auto-detected |
|------|--------|-------------|---------------|
| Claude Code | Supported | `~/.claude.json` | Yes |
| Codex CLI | Supported | `~/.codex/config.toml` | Yes |
| Cursor | Supported | `~/.cursor/mcp.json` | Yes |
| Gemini CLI | Supported | `~/.gemini/settings.json` | Yes |
| Lovable | Supported | None (a form in Lovable) | No, see below |
| ChatGPT, Claude.ai and other OAuth connectors | Any tool that supports OAuth MCP connectors | None (a connector in the app) | No, see below |
| GitHub Copilot (VS Code) | **Coming soon**, not supported yet | `.vscode/mcp.json` | Only if that file already exists in the folder you run the wizard from |

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
change which models review your code: the panel is the same whichever tool you call it from.

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

`~/.cursor/mcp.json` or `.cursor/mcp.json`. **No `type` field.** Cursor does not use one:

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

GitHub Copilot is coming soon. If you want to try it early: `.vscode/mcp.json`. **The top-level key
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

### Adding your own OpenRouter key (free / BYOK)

Add one more header alongside `Authorization`, in whichever shape your tool uses above. The key
needs credit on it. You pay OpenRouter directly; MegaLens is not part of that bill.

```
"x-megalens-openrouter-key": "sk-or-v1-your-openrouter-key"
```

In Codex TOML:

```toml
http_headers = { "Authorization" = "Bearer ml_tok_your_token_here", "x-megalens-openrouter-key" = "sk-or-v1-your-openrouter-key" }
```

With Claude Code's command, add `--header "x-megalens-openrouter-key: sk-or-v1-your-openrouter-key"`.

If you skip the key, use pay as you go credits instead. See [current pricing](https://megalens.ai/pricing)
for the rate and how reviews are counted, including plans with AI usage included.

## Commands

| Command | Description |
|---------|-------------|
| `megalens-mcp setup` | Interactive setup: detect tools, write config |
| `megalens-mcp setup codex` | Interactive Codex setup (`config.toml` + `AGENTS.md`) |
| `megalens-mcp setup claude-code` | Interactive Claude Code setup (`claude mcp add` + `CLAUDE.md`) |
| `megalens-mcp setup antigravity` | Interactive Antigravity setup (`agy mcp add` + `GEMINI.md`), alias `setup agy` |
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
- `$CODEX_HOME/AGENTS.md`: adds any missing MegaLens instruction line and updates an older version of the second line in place (after the same yes):
  - `After you change code that handles money, sign-in, user data or database migrations, and before the user commits it, offer a MegaLens review and wait for a yes before running it.`
  - `Before you or the user settle a decision that is hard to undo (choosing a database or data model, adding sign-in or payments, picking a major library or architecture), starting a new project, or doing deep research, offer a MegaLens review once for that task and wait for a yes before running it. Do not offer it for small questions or routine edits.`
  Saves a `.bak-*` backup before editing an existing file. If `$CODEX_HOME/AGENTS.override.md` exists, prints a note that Codex may prefer it.

Consent:

- Interactive TTY only (`--yes` is not supported). When run without a TTY, it writes nothing and prints manual setup steps.
- Shows a masked preview before each file change and requires an explicit `y` at separate confirmation prompts (`y/n` for `config.toml`, `y/N` for `AGENTS.md`). Pending stdin type-ahead is discarded before each prompt, and `Ctrl-C` aborts the run with exit code `130`.

### `setup claude-code`

Usage:

```bash
npx megalens-mcp setup claude-code [--remove-line] [--dry-run] [-h|--help]
```

- Uses `$CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`, for `CLAUDE.md`.
- Reads `MEGALENS_TOKEN` from the environment or prompts for your token without echoing it.
- Shows the masked `claude mcp add --scope user --transport http megalens "https://megalens.ai/api/mcp?ide=claude-code" --header "Authorization: Bearer ..."` command and runs `claude` only after you type `y` (default No). If `megalens` already exists (`claude mcp get megalens`), asks separately whether to replace it (`claude mcp remove --scope user megalens` then `add`).
- If `claude` is not on `PATH`, writes nothing and prints the manual command and setup link (`https://megalens.ai/integrations/claude-code`).
- Asks separately (default No) before appending the missing MegaLens review lines to `$CLAUDE_CONFIG_DIR/CLAUDE.md` (or `~/.claude/CLAUDE.md`), saving a `.bak-*` backup and preserving line endings and permissions. Use `--remove-line` to remove those lines later.

### `setup antigravity` (alias `setup agy`)

Usage:

```bash
npx megalens-mcp setup antigravity [--remove-line] [--dry-run] [-h|--help]
npx megalens-mcp setup agy [--remove-line] [--dry-run] [-h|--help]
```

- Reads `MEGALENS_TOKEN` from the environment or prompts for your token without echoing it.
- Checks `~/.gemini/config/mcp_config.json` (read-only). If that file is invalid JSON, it leaves everything for Antigravity untouched and says so. If `megalens` is already configured, asks separately whether to replace it (`agy mcp remove megalens` then `add`, default No).
- Shows the masked `agy mcp add --header "Authorization: Bearer ..." megalens "https://megalens.ai/api/mcp?ide=antigravity"` command and runs `agy` only after you type `y` (default No). If `agy` is not on `PATH`, writes nothing and prints the manual command and setup link (`https://megalens.ai/integrations/antigravity`).
- Asks separately (default No) before appending the missing MegaLens review lines to `~/.gemini/GEMINI.md`, saving a `.bak-*` backup and preserving line endings and permissions. Gemini CLI also reads `~/.gemini/GEMINI.md`, so those lines affect Gemini CLI too. Use `--remove-line` to remove those lines later.

## How It Works

MegaLens selects up to four AI models from different companies to review your code. They review it
separately. A final check reviews their findings, and you get back where they agreed and where they
disagreed. Each result names the models that actually took part.

If you send your own assessment with the request, the answer also says what the panel found that
yours did not.

The panel is the same whichever tool you call it from. MegaLens reports; it does not change your
code. Your own tool stays the one that decides what to do next.

> **Our private recipe.** What stays private: how we choose the models and what each one is asked to do,
> the numbers that tune each check, and the prompts. That recipe came from months of measured runs and
> changes as models change. Our results, rules and mistakes are public:
> [megalens.ai/research/ai-code-review-false-positives](https://megalens.ai/research/ai-code-review-false-positives)

## Requirements

- Node.js 18+ (only for the setup wizard; manual setup needs nothing)
- A MegaLens account: [megalens.ai](https://megalens.ai). Your first review is free, with no card

## Links

- [Dashboard](https://megalens.ai/app)
- [MCP Settings](https://megalens.ai/app/settings/mcp)
- [Integrations](https://megalens.ai/integrations)
