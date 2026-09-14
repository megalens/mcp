# megalens-mcp

Multi-engine code review inside your IDE. MegaLens reviews your code through specialist debate engines and delivers a judge-verified verdict — all from your existing AI tool.

## Quick Start

```bash
npx megalens-mcp setup
```

The setup wizard:
1. Asks for your MegaLens token ([get one here](https://megalens.ai/app/settings/mcp))
2. Optionally asks for your OpenRouter API key (free-tier BYOK users)
3. Detects installed tools automatically
4. Writes the correct config for each tool

## Supported Tools

| Tool | Config File | Auto-detected |
|------|-------------|---------------|
| Claude Code | `~/.claude.json` | Yes |
| Codex CLI | `~/.codex/config.toml` | Yes |
| Cursor | `~/.cursor/mcp.json` | Yes |
| Gemini CLI | `~/.gemini/settings.json` | Yes |
| VS Code (Copilot) | `.vscode/mcp.json` | Yes |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | Yes |

If no tool is detected, the wizard lets you pick one and creates the config file.

## Manual Setup

Every example below was checked against each vendor's own documentation, not copied from
elsewhere. The differences between them are real — two config languages and three top-level keys —
which is why the wizard exists.

**Note the `?ide=` on each URL.** MegaLens picks engines by skipping your own tool's model — in
Claude Code it brings GPT, Gemini and DeepSeek instead of Claude — and it can only do that if it
knows which tool is calling. Measured across 94 real runs before this was added: **75 arrived
unidentified**, so the feature could not work for them.

### Claude Code

```bash
claude mcp add --transport http megalens "https://megalens.ai/api/mcp?ide=claude-code" \
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

`~/.cursor/mcp.json` or `.cursor/mcp.json`. **No `type` field** — Cursor does not use one:

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

### VS Code / Copilot

`.vscode/mcp.json`. **The top-level key is `servers`, not `mcpServers`** — a config written for
Claude Code or Cursor will not be read here:

```json
{
  "servers": {
    "megalens": {
      "type": "http",
      "url": "https://megalens.ai/api/mcp?ide=copilot"
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

Add one more header alongside `Authorization`, in whichever shape your tool uses above:

```
"x-megalens-openrouter-key": "sk-or-v1-your-openrouter-key"
```

## Commands

| Command | Description |
|---------|-------------|
| `megalens-mcp setup` | Interactive setup — detect tools, write config |
| `megalens-mcp validate` | Test your token connectivity |
| `megalens-mcp config` | Show current config status |

## How It Works

MegaLens detects which AI tool is calling it and adjusts the engine lineup:

- **Claude Code?** MegaLens skips Claude, brings in GPT, Gemini, and DeepSeek
- **Codex CLI?** MegaLens skips GPT, brings in Claude, Gemini, and DeepSeek
- **Cursor?** MegaLens skips your active Cursor model, reviews with independent engines

3 genuinely different viewpoints. No duplicate API calls.

## Requirements

- Node.js 18+
- MegaLens account — [megalens.ai](https://megalens.ai)

## Links

- [Dashboard](https://megalens.ai/app)
- [MCP Settings](https://megalens.ai/app/settings/mcp)
- [Integrations](https://megalens.ai/integrations)
