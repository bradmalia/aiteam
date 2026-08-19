#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
ln -sfn "$ROOT/bin/aiteam-mcp" "$BIN_DIR/aiteam-mcp"
ln -sfn "$ROOT/bin/aiteam-watch" "$BIN_DIR/aiteam-watch"

echo "Installed AITEAM MCP launcher: $BIN_DIR/aiteam-mcp"
echo "Installed AITEAM dashboard launcher: $BIN_DIR/aiteam-watch"
echo
echo "Add this to ~/.codex/config.toml:"
echo
cat <<CFG
[mcp_servers.aiteam]
command = "$BIN_DIR/aiteam-mcp"
env_vars = [
  "AITEAM_CODEX_BIN",
  "AITEAM_CODEX_PREFIX_ARGS_JSON",
  "AITEAM_CODEX_HOME",
  "AITEAM_CODEX_MODEL",
  "AITEAM_CODEX_PROVIDER",
  "AITEAM_CODEX_PROVIDER_NAME",
  "AITEAM_CODEX_BASE_URL",
  "AITEAM_CODEX_WIRE_API",
  "AITEAM_CODEX_REQUIRES_OPENAI_AUTH",
  "AITEAM_CODEX_CONTEXT_WINDOW",
  "AITEAM_CODEX_AUTO_COMPACT_LIMIT",
  "AITEAM_COORDINATOR_READ_ONLY",
]
startup_timeout_sec = 10
tool_timeout_sec = 7200
CFG
echo
echo "Then append templates/AGENTS.aiteam.md to the target project's AGENTS.md and restart Codex."
