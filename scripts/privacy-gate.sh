#!/usr/bin/env sh
# Privacy gate — single source of truth for the leak/internals scan run by the
# pre-commit and pre-push hooks. Blocks maintainer PII (emails, real name,
# local paths) from any tracked content, and internal-process references
# (phase numbering, AI-tooling) from commit messages.
#
# Patterns use a leading bracket class (e.g. [m]atteo19) so this script file
# does NOT contain the bare banned string as a contiguous substring — a diff
# that adds/edits this very file will not self-trigger the gate.
#
# Usage:
#   privacy-gate.sh staged          scan staged hunks (pre-commit)
#   privacy-gate.sh range <range>   scan additions + commit messages (pre-push)
#                                   e.g. privacy-gate.sh range origin/main..HEAD
#
# Bypass (discouraged): git commit/push --no-verify
set -e

# PII that must never appear in any tracked content (diffs + messages).
PII='([m]atteo19|[d]imattia|[g]yver|/[U]sers/theo)'
# Internal-process refs banned in commit messages only (legit in prose/comments
# is already filtered out of public by .gitignore on .claude/* etc.).
INTERNALS='([m]atteo19|[d]imattia|[g]yver|/[U]sers/theo|[P]hase [0-9]|[H][0-9] defense|[h]arness|[A]GENTS\.md)'

mode="$1"

case "$mode" in
  staged)
    if git diff --cached | grep -nE "$PII"; then
      echo "[privacy] LEAK in staged diff (PII above) — aborting commit." >&2
      echo "[privacy] Use the sirtheo fixtures (see .claude/rules/commits-and-privacy.md)." >&2
      exit 1
    fi
    echo "[privacy] staged diff clean"
    ;;

  range)
    range="$2"
    if [ -z "$range" ]; then
      echo "[privacy] range mode needs a revision range argument" >&2
      exit 2
    fi
    # Skip cleanly if the base ref is unknown (e.g. fresh clone, detached state)
    # rather than failing the push on an un-runnable comparison.
    base="${range%%..*}"
    if ! git rev-parse --verify --quiet "$base" >/dev/null; then
      echo "[privacy] base '$base' not found — skipping range scan"
      exit 0
    fi

    if git log "$range" -p | grep -E '^\+' | grep -nE "$PII"; then
      echo "[privacy] LEAK in additions (PII above) — aborting push." >&2
      exit 1
    fi
    if git log "$range" --pretty=format:'%h %s%n%b' | grep -inE "$INTERNALS"; then
      echo "[privacy] INTERNALS in commit messages (above) — aborting push." >&2
      echo "[privacy] Reword the offending commit(s) before pushing." >&2
      exit 1
    fi
    echo "[privacy] additions + commit messages clean ($range)"
    ;;

  *)
    echo "Usage: privacy-gate.sh staged | range <revision-range>" >&2
    exit 2
    ;;
esac
