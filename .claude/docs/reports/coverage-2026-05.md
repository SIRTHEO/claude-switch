# Test coverage audit — 2026-05-04

**Branch**: `experiment/per-terminal-isolation` @ `87b3966`
**Tooling**: `node --test --experimental-test-coverage --test-coverage-include='dist/src/**/*.js'`
**Tests**: 271 total / 266 pass / 5 skipped (Linux-only on macOS) / 0 fail
**Duration**: 633ms

## Headline

| Metric | Whole repo |
|---|---|
| **Line coverage** | **56.63%** |
| Branch coverage | 84.85% |
| Function coverage | 73.21% |

The headline line% is heavily dragged down by the TUI layer (`src/ui/*`) which is unit-tested only at smoke level. Excluding `src/ui/`, line coverage on logic modules is **78.4%** (computed from per-file numbers, weighted by lines).

## Per-module breakdown

### Excellent (≥ 90%) — 14 modules

| Module | Line% | Branch% | Funcs% | Notes |
|---|---|---|---|---|
| `aliases.ts` | 100 | 100 | 100 | |
| `apikey.ts` | 100 | 92.31 | 100 | |
| `atomic-write.ts` | 100 | 100 | 100 | |
| `completions.ts` | 100 | 100 | 100 | |
| `errors.ts` | 100 | 100 | 100 | |
| `fallback.ts` | 100 | 100 | 100 | |
| `fallback-env.ts` | 100 | 100 | 100 | |
| `paths.ts` | 100 | 100 | 100 | |
| `version.ts` | 100 | 100 | 100 | |
| `accounts.ts` | 98.85 | 93.75 | 100 | uncovered: lines 115-116 |
| `auto-fallback.ts` | 97.94 | 88.24 | 100 | uncovered: lines 32-33 (catch on malformed JSON read) |
| `lock.ts` | 96.77 | 80.77 | 100 | uncovered: 58-59, 74-75 (error branches) |
| `statusline-install.ts` | 96.08 | 89.29 | 75 | uncovered funcs: 1 |
| `token.ts` | 94.92 | 81.82 | 100 | uncovered: 30-32 |

### Good (80-90%) — 5 modules

| Module | Line% | Branch% | Funcs% | Notes |
|---|---|---|---|---|
| `keychain.ts` | 88.14 | **45.45** | 100 | low branch coverage; macOS-only paths skipped on non-darwin |
| `resolver.ts` | 88.18 | 75 | 100 | uncovered: 12-18, 30-31, 42-43, 105-106 |
| `active-sessions.ts` | 88.10 | 82.35 | 50 | uncovered funcs: half — likely not exercised on macOS test runner |
| `profiles.ts` | 87.55 | 87.76 | 100 | uncovered: 52-53 (path-traversal throw — unreachable post-regex), 74-75, 175-176, 178-179, 192-193, **216-236 (importProfileFromAccount internals)** |
| `setup.ts` | 84.00 | 69.05 | 100 | uncovered: 20-21, 82-84, 119-120, 128-130, 136-149 |

### Mediocre (60-80%) — 3 modules

| Module | Line% | Branch% | Funcs% | Risk |
|---|---|---|---|---|
| `usage.ts` | 69.92 | 77.36 | 64.71 | ⚠️ rate-limit handling and background refresh largely untested |
| `proxy.ts` | 63.64 | 100 | 50 | uncovered funcs include the env-merging codepath used by `profile use` |
| `ui/theme.ts` | 60.47 | 100 | 0 | rendering helpers never invoked from a test |

### **Below 60% — flagged per DoD**

| Module | Line% | Funcs% | LOC | Why it matters |
|---|---|---|---|---|
| `find-claude.ts` | 50.00 | 0 | 21 | small file but resolves the actual `claude` binary; a wrong path here breaks every spawn |
| `update-check.ts` | 46.73 | 50 | 239 | network calls + version comparison + install-command detection; only the parser is well-covered, the I/O paths are not |
| **`switcher.ts`** | **42.58** | **66.67** | **301** | **Highest-risk gap.** Core legacy account-switching logic (`~/.claude.json` rewrite + Keychain swap). Largest module in the codebase that isn't UI, yet 58% of its lines and one third of its functions are untested. |
| `ui/theme.ts` | 60.47 | 0 | 46 | (counted twice — borderline) |
| `ui/add-account.ts` | 13.86 | 0 | 134 | TUI — Phase 5 |
| `ui/main-menu.ts` | **5.66** | 0 | 658 | TUI — Phase 5; biggest single file in the repo |
| `ui/remove-account.ts` | 16.05 | 0 | 100 | TUI — Phase 5 |
| `ui/select-account.ts` | 16.22 | 0 | 133 | TUI — Phase 5 |
| `ui/set-apikey.ts` | 10.14 | 0 | 95 | TUI — Phase 5 |
| `ui/setup-wizard.ts` | 3.97 | 0 | 195 | TUI — Phase 5 |

## Findings + recommendations

### F1 — `switcher.ts` is the single biggest non-UI risk

301 lines, 42.58% covered, 66.67% function coverage. This is the legacy `claude switch <account>` core logic — `~/.claude.json` mutation, Keychain swap, atomic write, alias resolution. A regression here means users silently swap the wrong account.

**Action (suggest as new task in Plans.md)**: write tests for `switcher.ts` paths covering at minimum:

- the rollback path when the Keychain write fails after the JSON has been touched
- alias-resolution corner cases (alias points to deleted account, alias loop)
- `--as <account>` temporary-switch + auto-restore on exit

### F2 — `update-check.ts` is undertested but low-stakes

Update flow is annoying-but-not-dangerous: a buggy update-check shows a wrong version banner, doesn't corrupt user state. Coverage gap is **acceptable** through 2.7.0; revisit if the npm publish provenance flow ever depends on it.

### F3 — `usage.ts` rate-limited path is the second-biggest risk

The "rateLimitedUntil" handling and background refresh logic are responsible for the entire `auto-engage` decision — and `auto-engage` is on the parking lot for 2.7.x. Before unparking it (Phase 4), bring `usage.ts` to ≥ 85%.

### F4 — `profiles.ts:importProfileFromAccount` is well-tested in unit but the macOS Keychain write path is masked

Lines 216-236 (the import logic itself) are uncovered in the line% tally. They ARE exercised by my real-machine smoke test from 3a.1a, but the unit test suite stops at the parsing layer and doesn't run `writeKeychainAt` (because that requires real macOS Keychain). The smoke report (`profiles-smoke-macos.md`) is the live evidence; consider this acceptable for shipping but document the trade-off.

### F5 — TUI is at 5-15% by design

`src/ui/*` interacts with `@clack/prompts` and a real TTY. Unit-testing it the way the rest of the codebase is tested would require heavy mocking. Phase 5's UX overhaul should bring at least smoke tests (e.g. via `node --test --experimental-vm-modules` + a fake stdin) but a 100% target is unrealistic and not worth chasing.

## Coverage targets for 2.7.0 release

| Module | Current | Target | Strategy |
|---|---|---|---|
| `switcher.ts` | 42.58 | **≥ 75** | F1 actions; net-new test file `test/switcher.test.ts` |
| `usage.ts` | 69.92 | ≥ 80 | F3 actions; cover rate-limit + background-refresh |
| `find-claude.ts` | 50 | ≥ 75 | trivial — add 2-3 tests for missing-binary and PATH-search paths |
| `update-check.ts` | 46.73 | (no target) | accepted — see F2 |
| `proxy.ts` | 63.64 | ≥ 75 | cover env-merge used by `profile use` |
| TUI | 5-15 | (no numeric target) | Phase 5 — smoke-level coverage of each menu screen |

Combined with the existing high-coverage logic modules, the realistic post-improvement headline is **~70% line / ~85% branch** without touching the TUI.

## Reproducibility

```bash
npm run build
node --test \
  --experimental-test-coverage \
  --test-coverage-include='dist/src/**/*.js' \
  dist/test/*.test.js
```

The coverage report appears between `start of coverage report` and `end of coverage report` markers in stderr. To get a JSON shape suitable for CI thresholding, swap to a future stable reporter or pipe through a parser; for now this is human-readable only.
