#!/usr/bin/env bash
# scripts/graph-query.sh
# Query the understand-anything knowledge graph for code context relevant
# to a /harness-work task. Output is a markdown briefing meant to be pasted
# into the harness-work prompt OR consumed via copy-to-clipboard.
#
# Depends on: jq, the understand-anything plugin (graph at
# .understand-anything/knowledge-graph.json).
#
# Usage:
#   scripts/graph-query.sh file <path>          # full info on a file node + immediate edges
#   scripts/graph-query.sh dependents <path>    # nodes that import / call into <path>
#   scripts/graph-query.sh dependencies <path>  # nodes <path> imports / calls
#   scripts/graph-query.sh task <id>            # extract task <id> from Plans.md + brief on
#                                                 all files mentioned in its 内容/DoD columns
#   scripts/graph-query.sh summary              # one-screen overview (layers, hotspots,
#                                                 staleness vs current HEAD)
#
# Exit codes:
#   0 ok, 1 graph missing (suggest /understand-anything:understand),
#   2 invalid args, 3 task not found, 4 file not found in graph.

set -euo pipefail

GRAPH=".understand-anything/knowledge-graph.json"
META=".understand-anything/meta.json"
PLANS="Plans.md"

if [[ ! -f "$GRAPH" ]]; then
  echo "❌ Knowledge graph not found at $GRAPH" >&2
  echo "Run: claude /understand-anything:understand" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq required. brew install jq" >&2
  exit 1
fi

cmd="${1:-}"; shift || true

# Common helper: prints the file node header line + summary + tags + complexity
print_file_node() {
  local node_id="$1"
  jq -r --arg id "$node_id" '
    .nodes[]
    | select(.id == $id)
    | "## " + .name + "  `" + (.filePath // "?") + "`",
      "",
      "- **Type**: " + .type,
      "- **Complexity**: " + (.complexity // "?"),
      "- **Tags**: " + ((.tags // []) | join(", ")),
      "",
      "**Summary**: " + (.summary // "(no summary)"),
      ""
  ' "$GRAPH"
}

# Helper: list edges of a given direction from/to a node
print_edges() {
  local node_id="$1"
  local direction="$2"  # "from" or "to"
  local label="$3"

  local jq_filter
  if [[ "$direction" == "from" ]]; then
    jq_filter='.edges[] | select(.source == $id) | "- [" + .type + "] → `" + .target + "`"'
  else
    jq_filter='.edges[] | select(.target == $id) | "- [" + .type + "] ← `" + .source + "`"'
  fi

  local edges
  edges=$(jq -r --arg id "$node_id" "$jq_filter" "$GRAPH")

  if [[ -z "$edges" ]]; then
    echo "_(none)_"
  else
    echo "$edges"
  fi
  echo ""
}

case "$cmd" in
  file)
    path="${1:-}"
    if [[ -z "$path" ]]; then echo "Usage: $0 file <path>" >&2; exit 2; fi
    # Try common id prefixes
    node_id=""
    for prefix in file config document service pipeline schema resource endpoint; do
      candidate="$prefix:$path"
      if jq -e --arg id "$candidate" '.nodes | map(select(.id == $id)) | length > 0' "$GRAPH" >/dev/null 2>&1 \
         && [[ "$(jq -r --arg id "$candidate" '.nodes | map(select(.id == $id)) | length' "$GRAPH")" != "0" ]]; then
        node_id="$candidate"
        break
      fi
    done
    if [[ -z "$node_id" ]]; then
      echo "❌ No node found for path: $path" >&2
      echo "Try: $0 summary  → see what's in the graph" >&2
      exit 4
    fi
    print_file_node "$node_id"
    echo "### Outgoing edges (this file → others)"
    print_edges "$node_id" "from" "out"
    echo "### Incoming edges (others → this file)"
    print_edges "$node_id" "to" "in"
    ;;

  dependents)
    path="${1:-}"
    if [[ -z "$path" ]]; then echo "Usage: $0 dependents <path>" >&2; exit 2; fi
    # Match any node id ending with :path (covers all prefix flavors)
    jq -r --arg path "$path" '
      .edges[]
      | select(.target | endswith(":" + $path))
      | "- [" + .type + "] " + .source
    ' "$GRAPH" | sort -u
    ;;

  dependencies)
    path="${1:-}"
    if [[ -z "$path" ]]; then echo "Usage: $0 dependencies <path>" >&2; exit 2; fi
    jq -r --arg path "$path" '
      .edges[]
      | select(.source | endswith(":" + $path))
      | "- [" + .type + "] " + .target
    ' "$GRAPH" | sort -u
    ;;

  task)
    task_id="${1:-}"
    if [[ -z "$task_id" ]]; then echo "Usage: $0 task <id>" >&2; exit 2; fi
    if [[ ! -f "$PLANS" ]]; then
      echo "❌ $PLANS not found" >&2
      exit 3
    fi
    # Extract the task row from Plans.md (matches "| <id> | ... |")
    row=$(grep -E "^\| ${task_id} \|" "$PLANS" || true)
    if [[ -z "$row" ]]; then
      echo "❌ Task $task_id not found in $PLANS" >&2
      exit 3
    fi
    echo "# Briefing for task $task_id"
    echo ""
    echo "## Task row (from Plans.md)"
    echo ""
    echo "$row" | fold -s -w 110
    echo ""
    # Extract paths matching src/, test/, docs/, scripts/, .github/, bin/
    paths=$(echo "$row" \
      | grep -oE '(src|test|docs|scripts|bin|\.github)/[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs|md|sh|yml|json)' \
      | sort -u || true)
    if [[ -z "$paths" ]]; then
      echo "## Files mentioned in task"
      echo ""
      echo "_(no source paths found in task content — graph briefing skipped)_"
      echo ""
      echo "Hint: try \`$0 file <path>\` manually for files you intend to touch."
      exit 0
    fi
    echo "## Files mentioned + graph context"
    echo ""
    while IFS= read -r p; do
      echo "---"
      echo ""
      # Find the node id for this path
      node_id=""
      for prefix in file config document service pipeline schema resource endpoint; do
        candidate="$prefix:$p"
        cnt=$(jq -r --arg id "$candidate" '.nodes | map(select(.id == $id)) | length' "$GRAPH")
        if [[ "$cnt" != "0" ]]; then node_id="$candidate"; break; fi
      done
      if [[ -z "$node_id" ]]; then
        echo "## $p"
        echo ""
        echo "_(file not in graph — likely new or excluded by .understandignore)_"
        echo ""
        continue
      fi
      print_file_node "$node_id"
      echo "### Dependents (who calls/imports this)"
      print_edges "$node_id" "to" "in"
    done <<< "$paths"
    ;;

  summary)
    # Quick overview + staleness check
    if [[ -f "$META" ]]; then
      meta_commit=$(jq -r '.gitCommitHash' "$META")
      analyzed_at=$(jq -r '.lastAnalyzedAt' "$META")
      head_commit=$(git rev-parse HEAD 2>/dev/null || echo "?")
      echo "# Knowledge graph summary"
      echo ""
      echo "- **Analyzed at**: $analyzed_at"
      echo "- **Graph commit**: \`$meta_commit\`"
      echo "- **HEAD commit**:  \`$head_commit\`"
      if [[ "$meta_commit" != "$head_commit" ]]; then
        echo "- **Status**: ⚠️  STALE — graph predates current HEAD."
        echo "  Files changed since the graph was built:"
        echo ""
        git diff "$meta_commit"..HEAD --name-only 2>/dev/null | sed 's/^/  - /' || echo "  (cannot diff)"
        echo ""
        echo "  Run: \`npm run graph:refresh\` to update."
      else
        echo "- **Status**: ✅ fresh"
      fi
      echo ""
    fi
    jq -r '
      "## Counts",
      "",
      "- Total nodes: \(.nodes | length)",
      "- Total edges: \(.edges | length)",
      "",
      "## Node types",
      "",
      (.nodes | group_by(.type) | map("- \(.[0].type): \(length)") | join("\n")),
      "",
      "## Edge types",
      "",
      (.edges | group_by(.type) | map("- \(.[0].type): \(length)") | join("\n")),
      "",
      "## Layers",
      "",
      (.layers | map("- **\(.name)** (\(.nodeIds | length) nodes) — \(.description // "")") | join("\n")),
      ""
    ' "$GRAPH"
    ;;

  *)
    cat <<EOF
Usage: $0 <subcommand> [args]

Subcommands:
  file <path>          Full info on a file node (summary, complexity, edges)
  dependents <path>    Who imports / calls into <path>
  dependencies <path>  What <path> imports / calls
  task <id>            Brief on every file mentioned in task <id> of Plans.md
  summary              Overview + staleness check vs current HEAD

Examples:
  $0 file src/profiles.ts
  $0 dependents src/keychain.ts
  $0 task 13.4
  $0 summary
EOF
    exit 2
    ;;
esac
