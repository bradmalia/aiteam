#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
ln -sfn "$ROOT/bin/aiteam-mcp" "$BIN_DIR/aiteam-mcp"

echo "Installed AITEAM MCP launcher: $BIN_DIR/aiteam-mcp"
echo
echo "Add this to ~/.codex/config.toml:"
echo
cat <<CFG
[mcp_servers.aiteam]
command = "$BIN_DIR/aiteam-mcp"
startup_timeout_sec = 10
tool_timeout_sec = 3600
CFG
echo
echo "Then append templates/AGENTS.aiteam.md to the target project's AGENTS.md and restart Codex."
