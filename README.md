# megalens-mcp

Code review from a panel of AI models, inside the AI tool you already use. MegaLens sends your code
to models from different companies, usually two, and reports where they agree and where they disagree.

Your first review is free, with no card.

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
| VS Code (Copilot) | `.vscode/mcp.json` | Yes. **Coming soon:** the wizard can write the config, but this integration is not supported yet |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | Yes. Not yet verified end to end |

If no tool is detected, the wizard lets you pick one and creates the config file.

**Lovable** needs no config file and no wizard. Paste the server URL and your token into Lovable's
MCP connector form. Steps: [megalens.ai/integrations/lovable](https://megalens.ai/integrations/lovable)

## Manual Setup

The tools use two config languages and three different top-level keys, which is why the wizard
exists.

**Keep the `?ide=` on each URL.** It tells MegaLens which tool the review came from. It does not
change which models review your code: the panel is the same whichever tool you call it from.

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

### VS Code / Copilot (coming soon, not yet supported)

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

MegaLens sends your code to a panel of AI models from different companies, usually two. They review
it separately. Their findings are then compared and reviewed once more, and you get back where they
agreed and where they disagreed.

If you send your own assessment with the request, the answer also says what the panel found that
yours did not.

The panel is the same whichever tool you call it from. MegaLens reports; it does not change your
code. Your own tool stays the one that decides what to do next.

## Requirements

- Node.js 18+
- A MegaLens account: [megalens.ai](https://megalens.ai). Your first review is free, with no card

## Links

- [Dashboard](https://megalens.ai/app)
- [MCP Settings](https://megalens.ai/app/settings/mcp)
- [Integrations](https://megalens.ai/integrations)
