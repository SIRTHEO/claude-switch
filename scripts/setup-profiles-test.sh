#!/usr/bin/env bash
# scripts/setup-profiles-test.sh
# One-shot setup for testing per-terminal profile isolation with the
# user's REAL accounts (no fake data, no browser re-login on macOS —
# we re-use the _keychain snapshots saved by the legacy `claude switch`
# flow).
#
# After this script finishes, you have:
#   - an `claude-exp` alias pointing at the experimental build
#   - a profile per saved account, each pre-authenticated
#
# To use:  open 2 terminals, in each run:
#   claude-exp switch profile use <name>
# and Claude Code will be running independently in each.

set -e

CLI_DIR="/Users/example/personal/claude-switch"
CLI_JS="$CLI_DIR/dist/bin/cli.js"

if [ ! -f "$CLI_JS" ]; then
  echo "Building experimental CLI…"
  ( cd "$CLI_DIR" && npm run build >/dev/null )
fi

# 1. Surface what we have
echo ""
echo "═══ Saved accounts you can import ═══"
node "$CLI_JS" switch list

echo ""
echo "═══ Importing each into an isolated profile ═══"
echo "(macOS will prompt for Keychain consent — click ‘Always Allow’ to skip future prompts.)"
echo ""

# 2. Import every saved account, deriving the profile name from the email
#    local-part. Skip accounts that already have a profile.
ACCOUNTS=$(node "$CLI_JS" switch list 2>&1 | sed -nE 's/^\s*\*?\s*([A-Za-z0-9._+@-]+)\s*\(active\)?.*$/\1/p; s/^\s+([A-Za-z0-9._+@-]+@[A-Za-z0-9._-]+).*$/\1/p' | sort -u)

if [ -z "$ACCOUNTS" ]; then
  echo "No saved accounts found. Nothing to import."
  exit 0
fi

while IFS= read -r email; do
  [ -z "$email" ] && continue
  # Skip lines that aren't actually emails (paranoid filter)
  echo "$email" | grep -q "@" || continue
  echo "→ importing $email …"
  if node "$CLI_JS" switch profile import "$email" 2>&1; then
    echo "  ✓ done"
  else
    echo "  (already exists or errored — moving on)"
  fi
  echo ""
done <<< "$ACCOUNTS"

# 3. Tell the user what to do next
echo "═══ Profiles after import ═══"
node "$CLI_JS" switch profile list

cat <<EOF

═══ How to test ═══

  Add this alias to your shell (one terminal is enough):

      alias claude-exp='node $CLI_JS'

  Then open TWO terminals.

  In terminal A:
      claude-exp switch profile use <profile1>      # say "tech"

  In terminal B:
      claude-exp switch profile use <profile2>      # say "sirtheo_sirtheo"

  Each spawns its own claude REPL, fully isolated. Ask them different
  things. Quotas, sessions, history, projects — all separate.

  When you want to inspect:
      claude-exp switch profile list
      claude-exp switch profile status <name>

  When you want to cleanup a profile:
      claude-exp switch profile remove <name>

  Don't forget: switching profiles requires exiting and re-launching claude.
  You cannot swap accounts mid-session in a running REPL — that's a Claude
  Code limitation, not ours.

EOF
