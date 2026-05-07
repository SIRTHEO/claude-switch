#!/usr/bin/env bash
# scripts/render-demo.sh
# Wrapper that builds a synthetic $HOME, renders the marketing GIF
# from scripts/demo.tape against it, and tears the synthetic env down.
#
# Why this exists rather than letting VHS run against your real $HOME:
#   recording the live dashboard would expose real account emails and
#   userIDs in the GIF that ships in README. The fixture keeps the
#   recording reproducible AND credential-free.
#
# Prereq: `vhs` must be on PATH (`brew install vhs`).

set -euo pipefail

if ! command -v vhs >/dev/null 2>&1; then
  echo "vhs not found. Install with:  brew install vhs" >&2
  exit 1
fi

# Build the synthetic $HOME — the fixture script prints its path.
DEMO_HOME=$(node scripts/demo-fixture.mjs)
export HOME="$DEMO_HOME"
trap 'rm -rf "$DEMO_HOME"' EXIT

# Make sure the dist build is fresh — VHS will execute `claude switch`
# which routes through bin/cli.ts → dist/bin/cli.js.
npm run build >/dev/null

# Ensure docs/images exists so VHS can land the output.
mkdir -p docs/images

# Render. Working directory is the project root so dist/bin/cli.js is
# resolvable via node_modules/.bin/claude (or however the user has
# installed claude-switch). For the demo we invoke our own dist
# directly to avoid needing a global install.
# CS_DEMO_ROOT is the project root, exposed so each .tape can resolve
# the local dist regardless of where VHS spawns its shell.
export CS_DEMO_ROOT="$PWD"
export CLAUDE_SWITCH_DEMO=1

# Keychain writes during the recording would trigger a macOS auth
# dialog (the demo HOME has placeholder tokens, so any switch/import
# tries to claim a Keychain entry from the `node` process) and the
# resulting "authorization was canceled" error would surface in the
# GIF itself. Force the JSON-only path during rendering — same flag
# the test suite uses for the same reason.
export CLAUDE_SWITCH_DISABLE_KEYCHAIN=1

# Override the OS username that profile status / Keychain helpers
# would otherwise read off the host system (`claudeKeychainAccount()`
# falls back to `os.userInfo().username`). Without this, the GIF
# would print the maintainer's real local username — a small but
# real privacy leak.
export USER=sirtheo

# Pick which storyboard(s) to render. Default = all three.
TAPES=("scripts/demo.tape" "scripts/demo-switch.tape" "scripts/demo-profiles.tape")
if [ $# -gt 0 ]; then
  TAPES=("$@")
fi

for tape in "${TAPES[@]}"; do
  echo
  echo "▶ rendering $tape"
  vhs "$tape"
done

echo
echo "✔ output → docs/images/"
ls -la docs/images/*.gif 2>/dev/null
