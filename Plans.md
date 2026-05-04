---
_harness_template: "Plans.md.template"
_harness_version: "4.3.3"
---

# claude-switch Plans.md

> **Project**: claude-switch
> **Branch**: experiment/per-terminal-isolation
> **Last updated**: 2026-05-04
> **Updated by**: Claude Code

Roadmap to a clean **2.7.0 "Profiles"** release. Six phases, gated. Phase 0 must clear before any user-facing work; Phase 5 is the merge gate.

---

## Phase 0: Tech debt + branch hygiene

Branch must be green and committable.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 0.1 | Fix `auto-fallback.test.ts` for new `engageEnabled` / `engageThreshold` fields | `npm test` green; defaults + invariant covered | - | cc:完了 |
| 0.2 | Decide scope: ship `auto-engage` in 2.7.0 OR split into 2.7.1 | Decision recorded in EXPERIMENT.md or new `.claude/docs/design/` doc; Plans.md reflects choice | 0.1 | cc:TODO |
| 0.3 | Commit pending edits (`bin/cli.ts`, `src/auto-fallback.ts`) into proper conventional commits | `git status` clean; one `feat:` per logical change | 0.2 | cc:TODO |
| 0.4 | TypeScript strictness audit | `tsc --noEmit` green with `noUncheckedIndexedAccess` enabled (or documented opt-out per-file) | 0.3 | cc:TODO |
| 0.5 | Coverage audit (`node --experimental-test-coverage` or `c8`) | Report committed under `.claude/docs/reports/coverage-2026-05.md`; modules <60% line coverage flagged | 0.3 | cc:TODO |

---

## Phase 1: CI/CD reliability

Last 2 main runs failed (Windows test + deprecation warnings). Must be green before release.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 1.1 | Fix Windows CI failure in `active-sessions.test.ts` | `null` check precedes platform check in `src/active-sessions.ts`; test passes on Windows in CI | 0.3 | cc:完了 |
| 1.2 | Bump `actions/checkout` and `actions/setup-node` to versions running on Node 24 | Deprecation warning gone from CI logs | - | cc:TODO |
| 1.3 | Run profile E2E scripts (`scripts/setup-profiles-test.sh`, `scripts/verify-isolation.sh`) on macOS runner in CI | New job in `ci.yml`, only on macos-latest, only when relevant paths change (`src/profiles.ts`, `src/keychain.ts`, `bin/cli.ts`) | 1.1 | cc:TODO |
| 1.4 | Add `tsc --noEmit` step to CI (typecheck without build) | CI fails on type errors before tests run | 1.1 | cc:TODO |
| 1.5 | Add lint step (eslint or biome) | Lint config in repo; CI runs it; existing violations either fixed or grandfathered | 1.4 | cc:TODO |
| 1.6 | Fail-fast strategy review on matrix | Either keep `fail-fast: true` (default) or document why we want full matrix to run | 1.1 | cc:TODO |
| 1.7 | Coverage upload to PR comments (codecov or actions/summary) | Coverage diff visible on PRs touching `src/` | 0.5 | cc:TODO |

---

## Phase 2: Release tooling + docs

release-please works but the changelog format and the README story can be sharper before 2.7.0.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 2.1 | Audit `release-please-config.json` sections | Sections reflect actual commit types used; `ux`/`ui` consolidated; CHANGELOG sample reviewed | - | cc:TODO |
| 2.2 | CHANGELOG.md format review | Past 5 entries audited for clarity; conventions documented in `CONTRIBUTING.md` | 2.1 | cc:TODO |
| 2.3 | README structure pass | TOC, Quickstart in <60s, "Profiles" section drafted (filled in Phase 4), FAQ pruned | - | cc:TODO |
| 2.4 | Add npm install/version badges to README | Badges render correctly; version auto-updates | 2.3 | cc:TODO |
| 2.5 | `claude switch --help` text matches README claims | Top-level help + per-subcommand help reviewed for accuracy and brevity | 2.3 | cc:TODO |
| 2.6 | `npm publish --provenance` already on; verify SLSA attestation visible on npmjs.com | Past releases checked; documented | - | cc:TODO |
| 2.7 | Pre-release dry run: `release-please --dry-run` from current branch state | Output matches expected 2.7.0 shape | 0.3, 4.5 | cc:TODO |

---

## Phase 3: Per-terminal isolation — finish the job (profiles)

Primitives shipped (eef0f0c, 55c041a, 5b1514d, a0f2659). Remaining: real verification, edge cases, UX integration.

### 3a — Verification (must pass before UX work)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 3a.1 | Real macOS smoke: full `create → login → use → status → list → remove` cycle on real machine | Transcript + screenshots in `.claude/docs/reports/profiles-smoke-macos.md`; Keychain entries verified created and deleted | 0.3 | cc:TODO |
| 3a.2 | Regression: legacy `claude switch <account>` still works after profile operations | Default Keychain entry intact; covered in same report | 3a.1 | cc:TODO |
| 3a.3 | Audit `src/keychain.ts` profile codepaths for orphan-entry leaks | `security find-generic-password -s "Claude Code-credentials"` shows clean state after `profile remove`; documented | 3a.1 | cc:TODO |
| 3a.4 | Linux behaviour spike (Docker container) | Findings in `.claude/docs/reports/profiles-linux.md`: tokens land in `<profile>/.claude.json`, no Keychain assumption; edge cases listed | 3a.1 | cc:TODO |
| 3a.5 | Concurrency: two terminals on the same profile | Documented behaviour (lock contention, last-writer-wins, etc.) | 3a.1 | cc:TODO |
| 3a.6 | Sub-process inheritance (MCP servers) | Verify spawned MCP processes inherit `CLAUDE_CONFIG_DIR`; documented | 3a.1 | cc:TODO |

### 3b — UX integration

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 3b.1 | TUI Profiles submenu in `src/ui/main-menu.ts` | "Profiles" entry; create/use/list/remove/login reachable from menu | 3a.1, 3a.2 | cc:TODO |
| 3b.2 | `claude switch help` lists profile subcommands | Help text updated; tested via integration test | 3b.1 | cc:TODO |
| 3b.3 | Statusline shows active profile | If `CLAUDE_CONFIG_DIR` ≠ default, statusline displays profile name | 3b.1 | cc:TODO |
| 3b.4 | `claude switch profile status` UX review | Output shows: profile name, account email, token validity, Keychain entry, last used | 3b.1 | cc:TODO |
| 3b.5 | Error messages: profile-already-exists, profile-not-found, login-required | Reviewed for clarity; tested | 3b.1 | cc:TODO |

---

## Phase 4: API key fallback verification + improvements

`auto-fallback` (auto-revert + auto-engage) is the second high-risk subsystem. Verify before exposing in TUI.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 4.1 | Map fallback decision tree | Diagram in `.claude/docs/design/fallback-state-machine.md` covering: manual on/off, auto-revert (cached usage drops below threshold), auto-engage (usage crosses engageThreshold), interaction with profiles | - | cc:TODO |
| 4.2 | Coverage gap analysis on `src/auto-fallback.ts`, `src/fallback.ts`, `src/apikey.ts` | Per-function coverage report; missing edge cases listed | 0.5, 4.1 | cc:TODO |
| 4.3 | Fill auto-engage tests | Tests for: triggers when 5h crosses 95%, triggers when 7d crosses 95%, no-op when no API key saved, no-op when already engaged, persists state | 4.2 | cc:TODO |
| 4.4 | Hysteresis test: auto-engage at 95% → auto-revert at 80% → no flapping | Simulated usage trace; verified single transition each direction | 4.3 | cc:TODO |
| 4.5 | TUI exposure: settings menu for thresholds | New menu entry "Auto-fallback settings"; reads/writes `.auto-fallback.json` via `setAutoFallbackConfig`; validates invariant | 4.3, 3b.1 | cc:TODO |
| 4.6 | Statusline: show when fallback is auto-engaged vs manual | Visual difference (icon/color) between manual and auto modes | 4.5 | cc:TODO |
| 4.7 | Per-profile fallback config? Decide and document | Either: shared global config (current), or per-profile `.auto-fallback.json`. Decision in `.claude/docs/design/` | 4.1, 3a.1 | cc:TODO |

---

## Phase 5: TUI / UX overhaul

`src/ui/main-menu.ts` is 658 lines. UX has grown organically. Audit + refactor before exposing more features.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 5.1 | UX audit: walk through every menu path on macOS, log friction | Notes in `.claude/docs/reports/tui-audit-2026-05.md` per menu screen | - | cc:TODO |
| 5.2 | Split `main-menu.ts` into per-screen modules | Each menu screen <200 lines; shared helpers extracted | 5.1 | cc:TODO |
| 5.3 | Loading states: long ops show a spinner (e.g. `keychain` writes, `usage` fetches) | All ops >200ms have feedback | 5.2 | cc:TODO |
| 5.4 | Error rendering consistency | All errors go through one helper; format: title, cause, next step | 5.2 | cc:TODO |
| 5.5 | Color theme: review `src/ui/theme.ts` for accessibility (contrast, no-color env) | Theme respects `NO_COLOR=1`; verified in Linux ssh + Windows Terminal | 5.2 | cc:TODO |
| 5.6 | Keyboard shortcuts: documented and consistent | All menus use same nav keys; cheatsheet added to README | 5.2 | cc:TODO |
| 5.7 | Setup wizard polish (`src/ui/setup-wizard.ts` 195 lines) | First-run path tested on fresh `$HOME`; covered by E2E | 5.1 | cc:TODO |

---

## Phase 6: Merge gate

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 6.1 | Update FAQ entry on multi-terminal account drift | Replaces roadmap-issue link with concrete `claude switch profile use` instructions | 3b.1 | cc:TODO |
| 6.2 | README "Profiles — true per-terminal isolation" section | Section explains UX + coexistence with legacy switch; example commands tested | 2.3, 3b.1 | cc:TODO |
| 6.3 | CHANGELOG preview for 2.7.0 | Drafted from conventional commits; reviewed for user-facing language | 2.2 | cc:TODO |
| 6.4 | Open PR `experiment/per-terminal-isolation` → `main` | All CI checks green; review checklist linked | 1.*, 2.*, 3a.*, 3b.*, 4.*, 5.*, 6.1, 6.2, 6.3 | cc:TODO |
| 6.5 | Merge + verify release-please publishes 2.7.0 | npm package live, GitHub Release created, install command works on a clean machine | 6.4 | cc:TODO |

---

## Status Marker Legend

| Marker | Meaning |
|--------|---------|
| `cc:TODO` | Not started |
| `cc:WIP` | In progress |
| `cc:完了` | Worker completed, awaiting confirmation |
| `pm:確認済` | PM confirmed |
| `blocked` | Blocked (include reason inline) |

---

## Last Update

- **Updated at**: 2026-05-04
- **Last session owner**: Claude Code
- **Branch**: experiment/per-terminal-isolation
