# Knowledge graph integration

Workflow that bridges the [understand-anything](https://github.com/Lum1104/Understand-Anything) plugin and the [claude-code-harness](https://github.com/claude-code-harness/claude-code-harness) `/harness-*` skills for this repo.

The two plugins are independent — there is **no automatic handoff between them**. This page documents the manual workflow + helper scripts (`npm run graph:*`) that make the integration ergonomic for claude-switch contributors.

## Why integrate

`/harness-work N.M` has a built-in step ("タスク背景確認") that uses `git grep` / `Glob` to guess the impact radius of a task. That heuristic misses indirect dependencies, fan-in/fan-out, and cross-layer edges. The understand-anything knowledge graph has all of that — AST-parsed, deduplicated, with explicit edge types (`imports`, `calls`, `tested_by`, `configures`, `depends_on`).

Feeding the graph's output into harness-work's prompt gives the worker a much more accurate picture before it starts editing files.

## Setup

One-time per checkout:

```bash
# Install the understand-anything plugin (Claude Code marketplace)
/plugin marketplace add Lum1104/Understand-Anything
/plugin install understand-anything

# Build the plugin's core package (only first time)
cd ~/.claude/plugins/cache/understand-anything/understand-anything/2.7.0
pnpm install --frozen-lockfile
pnpm --filter @understand-anything/core build

# Back to the repo. Generate the initial knowledge graph.
cd /path/to/claude-switch
claude /understand-anything:understand
```

The repo already ships:

- `.understand-anything/.understandignore` — claude-switch-tuned exclusions (drop `dist/`, `.claude/`, `.harness*/`, `CLAUDE.md`, `Plans.md`, demo assets; keep `src/`, `test/`, `bin/`, `scripts/`, `docs/`, `.github/workflows/`)
- `.understand-anything/config.json` — `autoUpdate: true`, English output
- `.gitignore` entry — keeps `.understand-anything/` local

## Daily workflow

### Before starting a `/harness-work N.M` task

```bash
npm run graph:status        # is the graph fresh vs HEAD?
npm run graph:task -- N.M   # extract files mentioned in the task + their context
```

The output of `graph:task` is a markdown briefing that you paste into the `/harness-work` invocation (or into your scratch buffer while reasoning). It includes:

- The Plans.md row for `N.M`
- For each source path mentioned in 内容/DoD: the file's graph node (summary, complexity, tags) + dependents (who imports / calls it)

This replaces the harness-work step 1.5 inferred impact radius with the real graph data.

### Quick lookups during implementation

```bash
npm run graph:file -- src/profiles.ts          # what does this file do? what does it touch?
npm run graph:dependents -- src/keychain.ts    # who depends on this file?
```

Use these when:
- Deciding whether a refactor breaks downstream callers
- Sanity-checking what the worker is about to edit
- Reviewing a teammate's PR — "is this change scoped or does it ripple?"

### After landing a commit

The graph is **a snapshot in time**. Once you commit, it predates HEAD. Three options:

1. **Manual incremental update** (default, fast):
   ```bash
   npm run graph:status        # confirms stale + lists changed files
   claude /understand-anything:understand   # incremental — only changed files re-analyzed
   ```
2. **Manual headless update** (experimental — depends on `claude --headless` working in your env):
   ```bash
   npm run graph:refresh       # tries headless rebuild via `claude --headless`
   ```
3. **Just live with staleness** until you actually need fresh data. Step (1) takes ~1-3 min for small diffs.

There is **no auto-rebuild on commit** by default. We considered a `post-commit` git hook but rejected it — a stale graph rarely blocks work, while a slow hook does. Hot path: ergonomics > freshness.

## Script reference

All scripts live in `scripts/` and are also wired to `npm run`:

| Script | npm alias | Purpose |
|---|---|---|
| `scripts/graph-query.sh summary` | `npm run graph:summary` | Overview: layers, node/edge counts, staleness check |
| `scripts/graph-query.sh file <path>` | `npm run graph:file -- <path>` | Full node info + immediate edges for a file |
| `scripts/graph-query.sh dependents <path>` | `npm run graph:dependents -- <path>` | Who imports / calls into `<path>` |
| `scripts/graph-query.sh dependencies <path>` | _(direct)_ | What `<path>` imports / calls |
| `scripts/graph-query.sh task <id>` | `npm run graph:task -- <id>` | Plans.md row + graph context for every file mentioned |
| `scripts/graph-refresh.sh` | `npm run graph:status` | Staleness check + instructions |
| `scripts/graph-refresh.sh --force` | `npm run graph:refresh` | Try headless rebuild via `claude --headless` |

Dependencies: `jq` (`brew install jq` or distro equivalent). The understand-anything plugin itself isn't required to use the scripts — they only read `.understand-anything/knowledge-graph.json`. You only need the plugin when you want to **regenerate** that file.

## Caveats

1. **LLM-generated summaries can be inaccurate.** The knowledge graph's `summary` and `tags` fields come from an LLM analyzing each file. Spot-checked against the actual source before relying on a claim — example: the v2.7.0 graph for this repo says `src/keychain.ts` supports "libsecret on Linux, wincred on Windows" which is **wrong** (claude-switch only uses macOS Keychain; Linux/Windows store tokens in `.claude.json`). When the graph contradicts the code, trust the code.

2. **Edge inversions on `tested_by`**. The merge script flips `test → production` edges to `production → test` (matches the schema), but the underlying LLM analysis still sees the import in the test file. If you see a missing `tested_by` edge, check whether the test file actually imports the production module (production never imports its tests).

3. **`fingerprints.json` not generated.** Tree-sitter native modules were skipped during `pnpm install` (security policy on the user's machine). Incremental updates therefore use `git diff lastHash..HEAD --name-only` as the change detection fallback, not the more precise AST fingerprinting. To enable the fingerprint path:
   ```bash
   cd ~/.claude/plugins/cache/understand-anything/understand-anything/2.7.0
   pnpm approve-builds
   pnpm install --frozen-lockfile
   claude /understand-anything:understand --full
   ```

4. **Graph is gitignored.** Lives in `.understand-anything/` (local-only). Two developers on the same repo each maintain their own copy. The committed bits are this doc, the scripts, the `npm run` wiring, and `.understand-anything/.understandignore` / `config.json` (which we **do** want to gitignore — they're per-machine concerns even if hand-curated; copy to the repo root if you ever want to share them).

   Wait — actually `.understand-anything/` IS gitignored. The `.understandignore` and `config.json` are NOT shared via git. If you want to share them with the team, create symlinks from `.understand-anything-shared/` (tracked) to `.understand-anything/` and document the setup. For claude-switch we currently don't bother — the defaults are fine.

## When NOT to use this

- **Tiny PR / typo fix / docs-only change** — skip. Graph context adds noise, not signal.
- **Working on code you wrote 5 minutes ago** — your in-head model is more up-to-date than the graph.
- **Active session already deep into a feature** — the conversation context already has everything the graph would tell you.

Use it when arriving cold to an area, reviewing external contributions, or planning a refactor that touches a high-fan-in file.
