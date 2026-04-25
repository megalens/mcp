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
| Codex CLI | `~/.codex/config.json` | Yes |
| Cursor | `~/.cursor/mcp.json` | Yes |
| Gemini CLI | `~/.gemini/settings.json` | Yes |
| VS Code (Copilot) | `.vscode/mcp.json` | Yes |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | Yes |

If no tool is detected, the wizard lets you pick one and creates the config file.

## Manual Setup

### Pro / PAYG users

```json
{
  "mcpServers": {
    "megalens": {
      "url": "https://megalens.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer ml_tok_your_token_here"
      }
    }
  }
}
```

### Free / BYOK users

```json
{
  "mcpServers": {
    "megalens": {
      "url": "https://megalens.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer ml_tok_your_token_here",
        "x-megalens-openrouter-key": "sk-or-v1-your-openrouter-key"
      }
    }
  }
}
```

> **Note:** VS Code uses `"servers"` instead of `"mcpServers"`. Codex CLI uses `"mcp": { "servers": { ... } }`. The setup wizard handles these differences automatically.

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
