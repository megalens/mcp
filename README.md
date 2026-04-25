# megalens-mcp

Multi-engine code analysis inside your IDE. MegaLens runs your code through specialist debate engines and delivers a judge-verified verdict — all from your existing AI tool.

## Quick Start

```bash
npm install -g megalens-mcp
megalens-mcp setup
```

The setup wizard:
1. Asks for your MegaLens token (get one at [megalens.ai/app/settings/mcp](https://megalens.ai/app/settings/mcp))
2. Detects installed tools (Claude Code, Codex)
3. Writes the config automatically

## Manual Setup

### Claude Code

Add to `~/.claude.json` or `.mcp.json`:

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

Or via CLI:

```bash
claude mcp add megalens --url https://megalens.ai/api/mcp --header "Authorization: Bearer ml_tok_your_token_here"
```

### Codex

Add to your Codex project config:

```json
{
  "mcp": {
    "servers": {
      "megalens": {
        "url": "https://megalens.ai/api/mcp",
        "headers": {
          "Authorization": "Bearer ml_tok_your_token_here"
        }
      }
    }
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `megalens-mcp setup` | Interactive setup wizard |
| `megalens-mcp validate` | Test your token connectivity |
| `megalens-mcp config` | Show current config status |

## How It Works

MegaLens automatically detects which AI tool is calling it:

- **Claude Code user?** MegaLens skips Claude and brings in GPT, Gemini, and DeepSeek
- **Codex user?** MegaLens skips GPT and brings in Claude, Gemini, and DeepSeek

3 genuinely different viewpoints. Zero duplicate API calls. No credits wasted.

## Requirements

- Node.js 18+
- MegaLens account with Pro subscription or Pay-as-you-go balance — [megalens.ai](https://megalens.ai)

## Links

- [Dashboard](https://megalens.ai/app)
- [MCP Settings](https://megalens.ai/app/settings/mcp)
- [Documentation](https://megalens.ai/extensions/mcp)
