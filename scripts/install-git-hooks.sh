#!/usr/bin/env sh
# Install project git hooks into .git/hooks/.
# Idempotent: safe to run multiple times.
set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/scripts/git-hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

install_hook() {
  name="$1"
  src="$HOOKS_SRC/$name"
  dst="$HOOKS_DST/$name"

  if [ ! -f "$src" ]; then
    echo "[install-hooks] warning: $src not found, skipping"
    return
  fi

  cp "$src" "$dst"
  chmod +x "$dst"
  echo "[install-hooks] installed $name -> $dst"
}

install_hook pre-commit
install_hook pre-push

echo "[install-hooks] done. Verify with: ls -la .git/hooks/pre-commit .git/hooks/pre-push"
