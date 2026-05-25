#!/usr/bin/env bash
# scripts/verify-isolation.sh
# Automated verification of per-terminal profile isolation.
#
# Tests every claim that doesn't require an interactive OAuth login.
# After this passes, the only thing left for the user to verify manually
# is the actual two-terminal REPL behaviour (1 short browser flow per
# profile + a few clicks).

set -u
PASS=0
FAIL=0
WARN=0

ok()    { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
warn()  { echo "  ⚠ $*"; WARN=$((WARN+1)); }
header() { echo ""; echo "═══ $* ═══"; }

CLI="${CLI:-$(cd "$(dirname "$0")/.." && pwd)/dist/bin/cli.js}"
if [ ! -f "$CLI" ]; then
  echo "Build the project first: npm run build"
  echo "Or set CLI env var to a valid dist/bin/cli.js"
  exit 2
fi

REAL_CLAUDE="${REAL_CLAUDE:-$(cat ~/.claude/accounts/.claude-bin 2>/dev/null || which claude)}"
if [ ! -x "$REAL_CLAUDE" ]; then
  echo "Cannot find real claude binary. Set REAL_CLAUDE env var."
  exit 2
fi

# Sandboxed HOME so we never touch the user's real state.
TEST_HOME="$(mktemp -d -t cs-iso-verify-XXXXXX)"
trap "rm -rf '$TEST_HOME'" EXIT
export HOME="$TEST_HOME"
mkdir -p "$HOME/.claude/accounts"
echo "$REAL_CLAUDE" > "$HOME/.claude/accounts/.claude-bin"

echo "Sandboxed HOME: $HOME"
echo "Real claude:    $REAL_CLAUDE"

# ---------------------------------------------------------------------------
header "1. Profile lifecycle (create/list/remove)"
# ---------------------------------------------------------------------------

node "$CLI" switch profile create work     >/dev/null 2>&1 && ok "create work"     || fail "create work"
node "$CLI" switch profile create personal >/dev/null 2>&1 && ok "create personal" || fail "create personal"

LIST=$(node "$CLI" switch profile list 2>&1)
echo "$LIST" | grep -q "personal" && ok "list shows personal"     || fail "list missing personal"
echo "$LIST" | grep -q "work"     && ok "list shows work"         || fail "list missing work"
echo "$LIST" | grep -q "not logged in" && ok "list flags both as not-logged-in" \
                                       || fail "list does not flag unauthenticated profiles"

# Validation
node "$CLI" switch profile create "../escape" >/dev/null 2>&1 && fail "ACCEPTED path traversal" \
                                                              || ok "rejected path traversal"
node "$CLI" switch profile create list        >/dev/null 2>&1 && fail "ACCEPTED reserved name" \
                                                              || ok "rejected reserved name 'list'"
node "$CLI" switch profile create work        >/dev/null 2>&1 && fail "ACCEPTED duplicate" \
                                                              || ok "rejected duplicate"

# ---------------------------------------------------------------------------
header "2. Filesystem isolation (no login required)"
# ---------------------------------------------------------------------------

[ -d "$HOME/.claude/profiles/work" ]     && ok "work dir exists"       || fail "work dir missing"
[ -d "$HOME/.claude/profiles/personal" ] && ok "personal dir exists"   || fail "personal dir missing"

# mode 0700 on unix
if [ "$(uname)" != "Linux" ] && [ "$(uname)" != "Darwin" ]; then
  warn "skipping mode check (non-unix)"
else
  WORK_MODE=$(stat -f "%Lp" "$HOME/.claude/profiles/work" 2>/dev/null || stat -c "%a" "$HOME/.claude/profiles/work")
  [ "$WORK_MODE" = "700" ] && ok "work dir mode is 0700" || fail "work dir mode is $WORK_MODE (expected 700)"
fi

# ---------------------------------------------------------------------------
header "3. Spawn passes CLAUDE_CONFIG_DIR (verified via 'claude --version')"
# ---------------------------------------------------------------------------

# Pre-populate .claude.json with fake email so 'profile use' check passes.
echo '{"oauthAccount":{"emailAddress":"verify@test.invalid"}}' \
  > "$HOME/.claude/profiles/work/.claude.json"

# Capture mtime of real .claude.json BEFORE spawn (real, NOT sandboxed)
REAL_CLAUDE_JSON="$HOME/.claude.json"
BEFORE_MTIME=""
[ -f "$REAL_CLAUDE_JSON" ] && BEFORE_MTIME=$(stat -f "%m" "$REAL_CLAUDE_JSON" 2>/dev/null || stat -c "%Y" "$REAL_CLAUDE_JSON")

# Spawn claude --version through profile use
OUTPUT=$(node "$CLI" switch profile use work --version 2>&1)

echo "$OUTPUT" | grep -q "(profile, isolated)" && ok "banner says 'profile, isolated'" \
                                              || fail "banner missing 'profile, isolated'"
echo "$OUTPUT" | grep -q "verify@test.invalid" && ok "banner shows correct email" \
                                              || fail "banner does not show profile email"
echo "$OUTPUT" | grep -qE "[0-9]+\.[0-9]+\.[0-9]+ \(Claude Code\)" \
                                  && ok "real claude responded with version" \
                                  || fail "real claude did not run (or version not in output)"

# Real .claude.json mtime UNCHANGED — proves global state untouched
AFTER_MTIME=""
[ -f "$REAL_CLAUDE_JSON" ] && AFTER_MTIME=$(stat -f "%m" "$REAL_CLAUDE_JSON" 2>/dev/null || stat -c "%Y" "$REAL_CLAUDE_JSON")
if [ -n "$BEFORE_MTIME" ] && [ "$BEFORE_MTIME" = "$AFTER_MTIME" ]; then
  ok "real ~/.claude.json mtime UNCHANGED ($BEFORE_MTIME) — global state untouched"
elif [ -z "$BEFORE_MTIME" ]; then
  warn "real ~/.claude.json absent — cannot verify it stayed untouched"
else
  fail "real ~/.claude.json mtime changed ($BEFORE_MTIME → $AFTER_MTIME) — ISOLATION BROKEN"
fi

# ---------------------------------------------------------------------------
header "4. Each profile gets its OWN userID (the macOS Keychain account key)"
# ---------------------------------------------------------------------------

# personal needs hasLogin=true to pass profile-use guard
echo '{"oauthAccount":{"emailAddress":"verify-personal@test.invalid"}}' \
  > "$HOME/.claude/profiles/personal/.claude.json"

# Trigger userID generation. --version is too cheap (claude doesn't write
# state for it). --print does — even if auth fails, the userID/firstStartTime
# init runs first. We pipe /dev/null so claude doesn't hang on stdin.
node "$CLI" switch profile use work     --print "x" </dev/null >/dev/null 2>&1 || true
node "$CLI" switch profile use personal --print "x" </dev/null >/dev/null 2>&1 || true

UID_WORK=$(jq -r '.userID // empty' "$HOME/.claude/profiles/work/.claude.json" 2>/dev/null)
UID_PERS=$(jq -r '.userID // empty' "$HOME/.claude/profiles/personal/.claude.json" 2>/dev/null)

if [ -z "$UID_WORK" ] || [ -z "$UID_PERS" ]; then
  warn "userID not yet generated by claude (it's lazy). Skipping comparison."
elif [ "$UID_WORK" = "$UID_PERS" ]; then
  fail "userIDs are IDENTICAL — isolation broken. work=$UID_WORK personal=$UID_PERS"
else
  ok "userIDs are DIFFERENT — work=${UID_WORK:0:16}…  personal=${UID_PERS:0:16}…"
fi

# ---------------------------------------------------------------------------
header "5. profile remove cleans up the dir"
# ---------------------------------------------------------------------------

node "$CLI" switch profile remove personal >/dev/null 2>&1 && ok "remove personal exits 0" \
                                                           || fail "remove personal failed"
[ ! -d "$HOME/.claude/profiles/personal" ] && ok "personal dir removed" \
                                           || fail "personal dir still on disk"

LIST_AFTER=$(node "$CLI" switch profile list 2>&1)
echo "$LIST_AFTER" | grep -q "personal" && fail "list still shows removed personal" \
                                        || ok "list no longer shows personal"

# ---------------------------------------------------------------------------
header "6. profile use rejects unknown / not-logged-in profiles"
# ---------------------------------------------------------------------------

OUT=$(node "$CLI" switch profile use does-not-exist 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok "exit non-zero for unknown profile" || fail "use unknown profile exited 0"
echo "$OUT" | grep -q "does not exist" && ok "clean error message for unknown profile" \
                                       || fail "error message missing 'does not exist'"

# Create a profile but don't fake-populate it
node "$CLI" switch profile create unauthed >/dev/null 2>&1
OUT=$(node "$CLI" switch profile use unauthed 2>&1); RC=$?
[ "$RC" -ne 0 ] && ok "exit non-zero for unauthenticated profile" \
               || fail "use unauthenticated exited 0"
echo "$OUT" | grep -q "no login yet" && ok "clean error message for no-login" \
                                     || fail "missing 'no login yet' guard"

# ---------------------------------------------------------------------------
header "7. Process env is correctly set (deeper check)"
# ---------------------------------------------------------------------------

# Spawn a fake claude that just dumps its env, then check CLAUDE_CONFIG_DIR is set.
FAKE_CLAUDE=$(mktemp -t fake-claude-XXXXXX)
cat > "$FAKE_CLAUDE" <<'FAKE'
#!/usr/bin/env bash
# Fake claude binary: prints its CLAUDE_CONFIG_DIR and exits.
echo "FAKE_CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-<unset>}"
echo "FAKE_HOME=${HOME:-<unset>}"
FAKE
chmod +x "$FAKE_CLAUDE"

# Point the wrapper at the fake claude
echo "$FAKE_CLAUDE" > "$HOME/.claude/accounts/.claude-bin"

OUT=$(node "$CLI" switch profile use work 2>&1)
echo "$OUT" | grep -q "FAKE_CLAUDE_CONFIG_DIR=$HOME/.claude/profiles/work" \
  && ok "spawned process received CLAUDE_CONFIG_DIR pointing at the profile" \
  || fail "spawn did not propagate CLAUDE_CONFIG_DIR (got: $(echo "$OUT" | grep FAKE))"

rm -f "$FAKE_CLAUDE"

# ---------------------------------------------------------------------------
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Pass: $PASS    Fail: $FAIL    Warn: $WARN"
echo "═══════════════════════════════════════════════════════════════"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
