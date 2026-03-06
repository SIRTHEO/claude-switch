#!/usr/bin/env bash
# claude-switch installer
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${CLAUDE_SWITCH_INSTALL_DIR:-$HOME/bin}"

mkdir -p "$INSTALL_DIR"

# Symlink the wrapper script
ln -sf "$SCRIPT_DIR/claude-switch" "$INSTALL_DIR/claude"

echo "Installed claude-switch to $INSTALL_DIR/claude"
echo ""
echo "Make sure $INSTALL_DIR comes BEFORE the real claude binary in your PATH."
echo "Add this to your .zshrc (order matters — last export wins):"
echo ""
echo '  export PATH="$HOME/.local/bin:$PATH"'
echo '  export PATH="$HOME/bin:$PATH"'
