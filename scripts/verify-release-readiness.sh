#!/usr/bin/env bash
# verify-release-readiness.sh — pre-push smoke suite for claude-switch.
#
# Runs 5 checks and prints a GO / NO-GO summary.
# Exit 0 = GO (all checks passed), exit 1 = NO-GO (at least one failed).
#
# Usage:
#   bash scripts/verify-release-readiness.sh
#   npm run verify-release
#
# Note: knip (check 3) runs via npx — first run downloads it transiently.
# knip is intentionally NOT in devDependencies per project policy.
# This script is intended for local pre-release validation, not CI.

SCRIPT_NAME="verify-release-readiness"

# ── colour helpers ────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  RESET='\033[0m'
else
  GREEN=''
  RED=''
  RESET=''
fi

PASS="${GREEN}✓${RESET}"
FAIL="${RED}✗${RESET}"

FAILED=0
FAILED_NUMS=""
LOG_DIR="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR"' EXIT

# ── header ────────────────────────────────────────────────────────────────────

printf "\n%s — claude-switch\n" "$SCRIPT_NAME"
printf "========================================\n\n"

# ── check 1: build ────────────────────────────────────────────────────────────

printf "[1/5] %-28s" "build..."
if npm run build > "$LOG_DIR/1.log" 2>&1; then
  printf " ${PASS}\n"
else
  printf " ${FAIL}\n"
  FAILED=$((FAILED + 1))
  FAILED_NUMS="$FAILED_NUMS 1"
fi

# ── check 2: tests ────────────────────────────────────────────────────────────
#
# Build must have succeeded (check 1) for dist/ to exist.
# We run node --test directly (no rebuild) and capture the summary line.

printf "[2/5] %-28s" "test..."
CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 node --test dist/test/**/*.test.js dist/test/*.test.js \
  > "$LOG_DIR/2.log" 2>&1
TEST_EXIT=$?

# Match only the summary lines "ℹ pass N" and "ℹ fail N" (not "✖ failing tests:")
PASS_COUNT="$(grep -E '^. pass [0-9]' "$LOG_DIR/2.log" | awk '{print $3}' | head -1 || echo '?')"
FAIL_COUNT="$(grep -E '^. fail [0-9]' "$LOG_DIR/2.log" | awk '{print $3}' | head -1 || echo '?')"

# node --test may exit 0 even when individual tests fail in some Node versions;
# double-check the summary line.
if [ $TEST_EXIT -ne 0 ] || { [ -n "$FAIL_COUNT" ] && [ "$FAIL_COUNT" != "0" ]; }; then
  printf " ${FAIL}  (%s pass / %s fail)\n" "$PASS_COUNT" "$FAIL_COUNT"
  FAILED=$((FAILED + 1))
  FAILED_NUMS="$FAILED_NUMS 2"
else
  printf " ${PASS}  (%s pass / 0 fail)\n" "$PASS_COUNT"
fi

# ── check 3: knip dead code ───────────────────────────────────────────────────
#
# We check only "Unused files" and "Unused devDependencies" — these are the
# actionable blockers. "Unused exports/types" are expected for a library that
# exports many types for consumers.

printf "[3/5] %-28s" "knip dead code..."
npx --yes knip --reporter compact > "$LOG_DIR/3.log" 2>&1 || true

UNUSED_FILES="$(grep -E '^Unused files' "$LOG_DIR/3.log" || true)"
UNUSED_DEV="$(grep -E '^Unused devDependencies' "$LOG_DIR/3.log" || true)"

if [ -n "$UNUSED_FILES" ] || [ -n "$UNUSED_DEV" ]; then
  printf " ${FAIL}\n"
  FAILED=$((FAILED + 1))
  FAILED_NUMS="$FAILED_NUMS 3"
else
  printf " ${PASS}\n"
fi

# ── check 4: lint ─────────────────────────────────────────────────────────────
#
# Warnings are OK; errors (non-zero exit) block release.

printf "[4/5] %-28s" "lint..."
if npm run lint > "$LOG_DIR/4.log" 2>&1; then
  # Use biome's own summary line for warning count
  BIOME_WARN="$(grep -oE 'Found [0-9]+ warning' "$LOG_DIR/4.log" | grep -oE '[0-9]+' | head -1 || true)"
  if [ -n "$BIOME_WARN" ] && [ "$BIOME_WARN" != "0" ]; then
    printf " ${PASS}  (%s warning(s))\n" "$BIOME_WARN"
  else
    printf " ${PASS}\n"
  fi
else
  printf " ${FAIL}\n"
  FAILED=$((FAILED + 1))
  FAILED_NUMS="$FAILED_NUMS 4"
fi

# ── check 5: conventional commits ─────────────────────────────────────────────
#
# Reuses the same regex as .github/workflows/commitlint.yml (Phase 17.2).
# Base: latest vX.Y.Z tag; if no tag exists, validates all reachable commits.

printf "[5/5] %-28s" "conventional commits..."
BASE_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -n "$BASE_TAG" ]; then
  RANGE="${BASE_TAG}..HEAD"
else
  RANGE="HEAD"
fi

BAD="$(git log "$RANGE" --format='%s' 2>/dev/null | \
  grep -vE '^(feat|fix|chore|docs|refactor|test|perf|build|ci|revert)(\([^)]+\))?(!)?:' || true)"

if [ -n "$BAD" ]; then
  printf " ${FAIL}\n"
  FAILED=$((FAILED + 1))
  FAILED_NUMS="$FAILED_NUMS 5"
else
  printf " ${PASS}\n"
fi

# ── summary ───────────────────────────────────────────────────────────────────

printf "\n"

if [ "$FAILED" -eq 0 ]; then
  printf "${GREEN}🟢 GO — ready to push to main${RESET}\n"

  # Informative bump info (best-effort, not a formal check)
  CURRENT_VER="$(node -p "require('./package.json').version" 2>/dev/null || true)"

  # Check for Release-As footer in commit range
  # git log outputs "HASH\nBODY\n\n" per commit when using --format='%h%n%B'
  # We grab the hash of the commit that contains the Release-As footer.
  RELEASE_AS_COMMIT="$(git log "$RANGE" --format='%h %B' 2>/dev/null | \
    awk '/Release-As:/{found=1; print hash; exit} /^[0-9a-f]{7} /{hash=$1}' || true)"
  RELEASE_AS="$(git log "$RANGE" --format='%B' 2>/dev/null | \
    grep -i '^Release-As:' | head -1 | sed 's/Release-As: *//i' | tr -d '\r' || true)"

  if [ -n "$RELEASE_AS" ]; then
    printf "   Bump: %s → %s (Release-As footer in %s)\n" \
      "$CURRENT_VER" "$RELEASE_AS" "$RELEASE_AS_COMMIT"
  else
    HAS_BREAKING="$(git log "$RANGE" --format='%s' 2>/dev/null | \
      grep -E '^(feat|fix)(\([^)]+\))?!:' || true)"
    HAS_FEAT="$(git log "$RANGE" --format='%s' 2>/dev/null | \
      grep -E '^feat(\([^)]+\))?:' || true)"
    HAS_FIX="$(git log "$RANGE" --format='%s' 2>/dev/null | \
      grep -E '^fix(\([^)]+\))?:' || true)"

    if [ -n "$HAS_BREAKING" ]; then
      BUMP_TYPE="major"
    elif [ -n "$HAS_FEAT" ]; then
      BUMP_TYPE="minor"
    elif [ -n "$HAS_FIX" ]; then
      BUMP_TYPE="patch"
    else
      BUMP_TYPE="none (chore/docs/refactor only)"
    fi
    printf "   Bump: %s → %s (heuristic — add Release-As footer to fix)\n" \
      "$CURRENT_VER" "$BUMP_TYPE"
  fi

  AHEAD="$(git log "origin/main..HEAD" --oneline 2>/dev/null | wc -l | tr -d ' ' || echo '?')"
  printf "   Commits ahead origin/main: %s\n" "$AHEAD"
  printf "\n"
  exit 0
fi

# NO-GO: print details for each failed check
printf "${RED}🔴 NO-GO — %s check(s) failed${RESET}\n\n" "$FAILED"

for NUM in $FAILED_NUMS; do
  case "$NUM" in
    1)
      printf "── [1/5] build ──────────────────────────────\n"
      tail -30 "$LOG_DIR/1.log"
      printf "\n"
      ;;
    2)
      printf "── [2/5] test ───────────────────────────────\n"
      grep -E '^. (fail|pass|skip|todo)' "$LOG_DIR/2.log" || true
      printf "\nFailed tests:\n"
      grep -E 'FAIL|not ok' "$LOG_DIR/2.log" | head -20 || true
      printf "\n"
      ;;
    3)
      printf "── [3/5] knip dead code ─────────────────────\n"
      [ -n "$UNUSED_FILES" ] && printf "  %s\n" "$UNUSED_FILES"
      [ -n "$UNUSED_DEV" ] && printf "  %s\n" "$UNUSED_DEV"
      printf "\n"
      ;;
    4)
      printf "── [4/5] lint ───────────────────────────────\n"
      tail -30 "$LOG_DIR/4.log"
      printf "\n"
      ;;
    5)
      printf "── [5/5] conventional commits ───────────────\n"
      printf "Base: %s\nNon-conventional messages:\n" "$BASE_TAG"
      printf "%s" "$BAD" | sed 's/^/  /'
      printf "\n"
      ;;
  esac
done

exit 1
