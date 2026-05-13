#!/usr/bin/env bash
# scripts/graph-refresh.sh
# Refresh the understand-anything knowledge graph after recent code changes.
#
# The refresh itself runs through Claude Code's skill system — we cannot
# fork it as a child process here. This script's job is to (a) detect
# whether the graph is stale, (b) if so, print the exact next steps so
# the user kicks off the refresh in their interactive session, and (c)
# fall back to a manual full rebuild via `claude --headless` when
# available.
#
# Usage:
#   scripts/graph-refresh.sh           # status check + instructions
#   scripts/graph-refresh.sh --force   # try headless rebuild via claude CLI
#                                        (requires `claude --headless` to work
#                                         non-interactively and the plugin
#                                         already built in the cache)

set -euo pipefail

GRAPH=".understand-anything/knowledge-graph.json"
META=".understand-anything/meta.json"

if [[ ! -f "$GRAPH" || ! -f "$META" ]]; then
  echo "❌ No graph found at $GRAPH"
  echo ""
  echo "First-time setup — run inside an interactive Claude Code session:"
  echo ""
  echo "    /understand-anything:understand"
  echo ""
  exit 1
fi

meta_commit=$(jq -r '.gitCommitHash' "$META")
head_commit=$(git rev-parse HEAD 2>/dev/null || echo "?")

if [[ "$meta_commit" == "$head_commit" ]]; then
  echo "✅ Graph is fresh (matches HEAD: $head_commit)"
  echo "   Last analyzed: $(jq -r '.lastAnalyzedAt' "$META")"
  exit 0
fi

changed_count=$(git diff "$meta_commit"..HEAD --name-only 2>/dev/null | wc -l | tr -d ' ')
echo "⚠️  Graph is stale"
echo ""
echo "    Graph commit: $meta_commit"
echo "    HEAD commit:  $head_commit"
echo "    Files changed since graph build: $changed_count"
echo ""

if [[ "${1:-}" == "--force" ]]; then
  if command -v claude >/dev/null 2>&1; then
    echo "→ Attempting headless rebuild via claude CLI..."
    # Caveat: `claude --headless` semantics may vary across versions.
    # If this fails the user gets a clear error and falls back to the
    # interactive instructions printed below.
    if claude --print "/understand-anything:understand" 2>&1 | tail -20; then
      echo ""
      echo "✅ Headless rebuild dispatched. Check .understand-anything/meta.json"
      echo "   for the new gitCommitHash to confirm completion."
      exit 0
    else
      echo ""
      echo "❌ Headless rebuild failed — falling back to manual instructions."
    fi
  else
    echo "❌ \`claude\` binary not on PATH — cannot run headless rebuild."
  fi
fi

echo "To update the graph, run inside an interactive Claude Code session:"
echo ""
echo "    /understand-anything:understand"
echo ""
echo "Tip: the analysis is incremental — only the $changed_count changed files"
echo "are re-analyzed, not all 150. Takes ~1-3 minutes for small diffs."
