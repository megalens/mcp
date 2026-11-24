# megalens-mcp changelog

## 0.3.14

Setup text tells the assistant to offer a MegaLens review at most once per task and to skip the offer after a MegaLens fix prompt.

## 0.3.12 (not published yet)

- **Browser sign-in (`npx megalens-mcp setup`).** RFC 8628-style device authorization against `megalens.ai/device` so users no longer copy-paste tokens. Each setup run mints a per-installation editor token (`editor:<12-hex>`) that never revokes existing editors on other machines, shows the approving account for explicit terminal confirmation before minting, and falls back to `--manual` token paste when desired.
- **Safer direct host setup (`setup claude-code`, `setup antigravity`, `setup codex`).** Writes private configs atomically with mode `0600` (re-reading and verifying file versions after backup before writing), stores backups outside git repositories, validates token labels against `/api/mcp/validate`, drops cross-origin headers / `headersHelper`, scans Antigravity and `CLAUDE_CONFIG_DIR` configs, and handles JSONC/TOML edge cases cleanly.

## 0.3.11

- Updated package README for credits pricing (first 3 Standard reviews free, $5 minimum PAYG top-up).
