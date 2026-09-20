#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"

# Install dashboard launcher
ln -sfn "$ROOT/bin/aiteam-watch" "$BIN_DIR/aiteam-watch"
ln -sfn "$ROOT/bin/aiteam-install" "$BIN_DIR/aiteam-install"

echo "Installed AITeam dashboard launcher: $BIN_DIR/aiteam-watch"
echo "Installed AITeam project installer:  $BIN_DIR/aiteam-install"
echo ""
echo "To install the AITeam Skill into any repository, run:"
echo "  aiteam-install /path/to/target-repo"
echo ""
echo "Or in the current directory:"
echo "  aiteam-install"
echo ""
