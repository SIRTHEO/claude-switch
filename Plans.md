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
| 0.2 | Decide scope: ship `auto-engage` in 2.7.0 OR split into separate release | **Decision REVISED 2026-05-04 (afternoon): SHIP IN 2.7.0.** User hit a real subscription rate-limit mid-session and felt the absence directly. Cherry-picked `feat/auto-engage-fallback` (commit `56e75dd`) onto experiment branch — fully wired with 23 new tests (auto-engage decision logic + `fallback auto-engage` CLI surface). 2.7.0 now ships profiles + auto-engage together. Original split rationale (separate release for review focus) traded for getting the user-visible feature to them faster | 0.1 | cc:完了 |
| 0.3 | Branch hygiene: split off-topic WIP into dedicated branches | Done: `fix/windows-ci-active-sessions` created from main with the Windows fix; auto-engage WIP parked as patch; `experiment/per-terminal-isolation` reverted to clean profile-only state + Harness scaffold commit | 0.2 | cc:完了 |
| 0.4 | TypeScript strictness audit | `tsc --noEmit` green with `noUncheckedIndexedAccess` enabled (or documented opt-out per-file) | 0.3 | cc:完了 |
| 0.5 | Coverage audit (`node --experimental-test-coverage` or `c8`) | Report committed under `.claude/docs/reports/coverage-2026-05.md`; modules <60% line coverage flagged | 0.3 | cc:完了 |
| 0.6 | Cover `switcher.ts` testable paths (best-effort within current architecture) | 10 new tests added: `switchTo` warning path + first-time-use, `savePendingRestore` overwrite + missing-dir, full `checkPendingRestore`/`clearPendingRestore` lifecycle. Branch coverage 88.89 → **97.50%**. Line stays at 43.36% because the uncovered remainder is `runTemporarySwitch` / `addAccount` / `reAuthenticate` which all spawn `claude` (impossible to unit-test without DI refactor — see 0.6b) | 0.5 | cc:完了 |
| 0.6b | Refactor `switcher.ts` for testability: inject `spawnSync` + `readline` | Replace direct `spawnSync`/`readline` calls with injected helpers; existing call sites pass real impls; tests pass mocks. Target: ≥ 75% line on switcher.ts | 0.6 | cc:TODO |
| 0.7 | Cover `find-claude.ts` (currently 50% line / 0% funcs) | Tests for missing-binary fallback + PATH search; target ≥ 75% line | 0.5 | cc:完了 |
| 0.8 | Cover `usage.ts` rate-limit + background-refresh paths (currently 69.92% line) | Tests for `rateLimitedUntil` honouring + `triggerBackgroundUsageRefresh` non-blocking semantics; target ≥ 80% line. Required before unparking auto-engage WIP | 0.5 | cc:完了 |

---

## Phase 1: CI/CD reliability

Last 2 main runs failed (Windows test + deprecation warnings). Must be green before release.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 1.1 | Fix Windows CI failure in `active-sessions.test.ts` | `null` check precedes platform check in `src/active-sessions.ts`; test passes on Windows in CI | 0.3 | cc:完了 |
| 1.2 | Bump `actions/checkout` and `actions/setup-node` to versions running on Node 24 | Deprecation warning gone from CI logs | - | cc:完了 |
| 1.3 | Run profile E2E scripts (`scripts/setup-profiles-test.sh`, `scripts/verify-isolation.sh`) on macOS runner in CI | New job in `ci.yml`, only on macos-latest, only when relevant paths change (`src/profiles.ts`, `src/keychain.ts`, `bin/cli.ts`) | 1.1 | cc:完了 |
| 1.3-result | **Decided 2026-05-04: keep scripts local-only.** `verify-isolation.sh` makes 15 calls into `node $CLI switch profile use ...` which spawn the real `claude` binary — CI runners don't have it. Mocking would add infrastructure without value because `test/profiles.test.ts` already covers profile primitives (20+ unit tests, runs in CI on all platforms). The bash scripts add value for **live machine verification** (3a.1a smoke), where they verify the actual claude integration the unit tests can't. Keeping them out of CI avoids fragile mock layer | 1.1 | - |
| 1.4 | Add `tsc --noEmit` step to CI (typecheck without build) | CI fails on type errors before tests run | 1.1 | cc:完了 |
| 1.5 | Add lint step (eslint or biome) | Lint config in repo; CI runs it; existing violations either fixed or grandfathered | 1.4 | cc:完了 |
| 1.5-result | **Biome chosen** (single binary, no plugin sprawl, formatter+linter+import-organiser in one tool). `biome.json` with recommended rules + 3 opinion-driven off (`noNonNullAssertion`, `useTemplate`, `useLiteralKeys`). Initial 27 violations all fixed: 4 files auto-fixed unsafe (cli/main-menu/proxy/switcher), 6 manual fixes (typed `let` declarations, dead Command type in test/cli.test, forEach → for…of). `npm run lint` and `npm run lint:fix` scripts added; CI runs `npm run lint` between typecheck and build | 1.4 | - |
| 1.6 | Fail-fast strategy review on matrix | Decision: `fail-fast: false`. Rationale documented inline in `ci.yml`: 9 jobs ~1min each, full matrix gives complete cross-platform picture, masking Windows regression behind Linux fail is the failure mode we hit on 2.6.0 | 1.1 | cc:完了 |
| 1.7 | Coverage upload to PR comments (codecov or actions/summary) | Coverage diff visible on PRs touching `src/` | 0.5 | cc:完了 |
| 1.7-result | Used GitHub Actions Job Summary (no external service, no token). New step on ubuntu-latest + Node 22.x only (avoids 9 racing reports across the matrix). Report appears under "Summary" tab of each CI run. Also bumped `actions/checkout` and `actions/setup-node` to v5 on this branch (kept matching main after the 2.6.1 PR) | - | - |

---

## Phase 2: Release tooling + docs

release-please works but the changelog format and the README story can be sharper before 2.7.0.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 2.1 | Audit `release-please-config.json` sections | **No-op verified 2026-05-04**. Distribution of 6-month commits (top 11 types) all map to existing config sections; `ux`+`ui` already consolidated under "User Experience"; hidden types (chore/test/build/ci/release) all suppressed correctly. Config is correct as-is | - | cc:完了 |
| 2.2 | CHANGELOG.md format review | Past 5 entries audited for clarity; conventions documented in `CONTRIBUTING.md` | 2.1 | cc:完了 |
| 2.2-result | **Audit 2026-05-04**: CHANGELOG entries (v2.5.2/2.6.0) follow release-please standard (h2 release link, h3 sections, commit hash links). CONTRIBUTING.md already has full Conventional Commits docs incl. release-trigger table. Minor cosmetic: an orphan boilerplate `## Changelog ... description` block sits at bottom of CHANGELOG.md (release-please prepends new entries above original header — harmless but ugly). Leaving as-is to avoid bleed with release-please's prepend logic | - | - |
| 2.3 | README structure pass | TOC, Quickstart in <60s, "Profiles" section drafted (filled in Phase 4), FAQ pruned | - | cc:完了 |
| 2.3-result | (a) Added "Quick links" inline TOC after the 30-second pitch. (b) Added a 4th bullet to "In 30 seconds" calling out Profiles as the 2.7 headline feature. (c) Updated "What's new" with 2.6.x + 2.7.x entries (was stuck at 2.5.x). FAQ kept as-is — its pre-Install position is intentional for AI search engines per prior commit `8f03581 docs: kill the contradiction…` | - | - |
| 2.4 | Add npm install/version badges to README | **No-op verified 2026-05-04**. README already has 4 badges: npm version, npm downloads, MIT license, Node.js CI status | 2.3 | cc:完了 |
| 2.5 | `claude switch --help` text matches README claims | **Verified 2026-05-04**. Help text covers all surfaces: account switch (alias/email/fuzzy), add/list/remove, alias mgmt, apikey set/show/remove, fallback on/off/auto + threshold, usage, statusline (4 sub-cmds), profile (7 sub-cmds incl. import), update, setup, --as flag, --completions. Claims in current README all map to documented commands. Profile section in README will land via 6.2 | 2.3 | cc:完了 |
| 2.6 | `npm publish --provenance` already on; verify SLSA attestation visible on npmjs.com | **Verified 2026-05-04**: `npm view @sirtheo/claude-switch dist.attestations` returns `predicateType: https://slsa.dev/provenance/v1` for v2.6.1; signed with key `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`. Provenance live | - | cc:完了 |
| 2.7 | Pre-release dry run: `release-please --dry-run` from current branch state | Output matches expected 2.7.0 shape | 0.3, 4.5 | cc:完了 |
| 2.7-result | Predicted release on merge: **2.7.0** (minor — 2 feat commits). Sections: 2 Features (profiles isolation + import), 1 Refactor (TS strict), 9 Documentation. Hidden: 5 test/3 chore/2 ci. Verified by `git log main..HEAD --pretty=format:'%s'` analysis 2026-05-04 | (informational row) | - | - |

---

## Phase 3: Per-terminal isolation — finish the job (profiles)

Primitives shipped (eef0f0c, 55c041a, 5b1514d, a0f2659). Remaining: real verification, edge cases, UX integration.

### 3a — Verification (must pass before UX work)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 3a.1a | Non-interactive smoke (create/list/status/remove + import + validation) on real macOS | Transcript in `.claude/docs/reports/profiles-smoke-macos.md`; Keychain entries verified created on import and deleted on cleanup | 0.3 | cc:完了 |
| 3a.1b | Interactive smoke: `profile login`, `profile use`, two-terminal isolation | Browser OAuth flow completed; spawned `claude` REPL banner shows the right account; refreshed-token import path verified | 3a.1a | cc:TODO |
| 3a.2 | Regression: legacy `claude switch <account>` still works after profile operations | Default Keychain entry intact; covered in same report | 3a.1a | cc:完了 |
| 3a.3 | Audit `src/keychain.ts` profile codepaths for orphan-entry leaks | `security find-generic-password -s "Claude Code-credentials"` shows clean state after `profile remove`; documented | 3a.1a | cc:完了 |
| 3a.4 | Linux behaviour spike (Docker container) | Findings in `.claude/docs/reports/profiles-linux.md`: tokens land in `<profile>/.claude.json`, no Keychain assumption; edge cases listed | 3a.1 | cc:TODO |
| 3a.5 | Concurrency: two terminals on the same profile | Documented behaviour (lock contention, last-writer-wins, etc.) | 3a.1 | cc:TODO |
| 3a.6 | Sub-process inheritance (MCP servers) | Verify spawned MCP processes inherit `CLAUDE_CONFIG_DIR`; documented | 3a.1a | cc:完了 |

### 3b — UX integration

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 3b.1 | TUI Profiles submenu in `src/ui/main-menu.ts` | "Profiles" entry; create/use/list/remove/login reachable from menu | 3a.1, 3a.2 | cc:TODO |
| 3b.2 | `claude switch help` lists profile subcommands | Help text updated; tested via integration test | 3b.1 | cc:完了 |
| 3b.3 | Statusline shows active profile | If `CLAUDE_CONFIG_DIR` ≠ default, statusline displays profile name | 3b.1 | cc:TODO |
| 3b.4 | `claude switch profile status` UX review | Output shows: profile name, account email, token validity, Keychain entry, last used | 3b.1 | cc:TODO |
| 3b.5 | Error messages: profile-already-exists, profile-not-found, login-required | Reviewed for clarity; tested | 3b.1 | cc:TODO |

---

## Phase 4: API key fallback verification + improvements

`auto-fallback` (auto-revert + auto-engage) is the second high-risk subsystem. Verify before exposing in TUI.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 4.1 | Map fallback decision tree | Diagram in `.claude/docs/design/fallback-state-machine.md` covering: manual on/off, auto-revert (cached usage drops below threshold), auto-engage (usage crosses engageThreshold), interaction with profiles | - | cc:完了 |
| 4.2 | Coverage gap analysis on `src/auto-fallback.ts`, `src/fallback.ts`, `src/apikey.ts` | Per-function coverage report; missing edge cases listed | 0.5, 4.1 | cc:TODO |
| 4.3 | Fill auto-engage tests | Tests for: triggers when 5h crosses 95%, triggers when 7d crosses 95%, no-op when no API key saved, no-op when already engaged, persists state | 4.2 | cc:完了 |
| 4.4 | Hysteresis test: auto-engage at 95% → auto-revert at 80% → no flapping | Simulated usage trace; verified single transition each direction | 4.3 | cc:完了 |
| 4.3-4-result | Both closed by the cherry-picked auto-engage commit. New `describe('maybeAutoEngageFallback', …)` block at `test/auto-fallback.test.ts:241` with 5h-crossing, 7d-crossing, no-API-key no-op, already-engaged no-op, threshold-invariant tests. Total `auto-fallback.test.ts` test count: 29 (was 11). Hysteresis verified via the engageThreshold > threshold invariant + the read-time clamp that protects pre-2.7.x configs | - | - |
| 4.5 | TUI exposure: settings menu for thresholds | New menu entry "Auto-fallback settings"; reads/writes `.auto-fallback.json` via `setAutoFallbackConfig`; validates invariant | 4.3, 3b.1 | cc:TODO |
| 4.6 | Statusline: show when fallback is auto-engaged vs manual | Visual difference (icon/color) between manual and auto modes | 4.5 | cc:完了 |
| 4.6-result | Sidecar marker `.fallback-auto-engaged` written when `maybeAutoEngageFallback` flips fallback ON; cleared on manual toggle (user intent overrides) and on disable. New `isFallbackAutoEngaged()` helper, exported. Statusline label: `API` (manual) vs `API auto` (auto-engaged), still in yellow. JSON output gains `fallbackAutoEngaged` field. 6 new tests covering on/off + manual-overrides-auto + perms | 4.5 | - |
| 4.7 | Per-profile fallback config? Decide and document | **Decided 2026-05-04: KEEP GLOBAL.** Reasoning in `.claude/docs/design/profile-fallback-scope.md`: API key is per-account-not-per-profile (so per-profile toggle is policy without enforcement); profile picker already pins identity, fallback is a billing-posture decision; mixing layers complicates reasoning. No code change needed | 4.1, 3a.1a | cc:完了 |

---

## Phase 5: TUI / UX overhaul

`src/ui/main-menu.ts` is 658 lines. UX has grown organically. Audit + refactor before exposing more features.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 5.1 | UX audit: walk through every menu path on macOS, log friction | Notes in `.claude/docs/reports/tui-audit-2026-05.md` per menu screen | - | cc:完了 |
| 5.2 | Split `main-menu.ts` into per-screen modules | Each menu screen <200 lines; shared helpers extracted | 5.1 | cc:完了 |
| 5.2-result | **Partial-safe extraction.** Pulled `buildStatusLines` + `buildAccountInfo` (status panel rendering) into `src/ui/menu/status.ts` (120 LOC, pure functions), and `ALT_BUFFER_*` constants + `altBufferSupported()` into `src/ui/menu/lifecycle.ts` (25 LOC). main-menu.ts: 658 → **549 LOC**. The remaining `pickAction`/`pickAdvancedAction`/`pickManageAction` selectors and the giant action-handler switch stay in main-menu.ts — splitting them further requires either TTY mocking infrastructure (same as 0.6b) or careful integration tests neither of which exist yet. Tests + lint green; behaviour verified by 313 unit tests passing | 5.1 | - |
| 5.3 | Loading states: long ops show a spinner (e.g. `keychain` writes, `usage` fetches) | All ops >200ms have feedback | 5.2 | cc:完了 |
| 5.3-result | **Audit 2026-05-04**: 5 existing `p.spinner()` sites cover the visible-latency operations: usage fetch (main-menu × 2), save account (add-account), remove account (remove-account), switch account (select-account). Other TUI ops are sub-100ms disk I/O (alias edits, API key set/remove, status reads) — spinners there would be noise. Re-auth and `claude` spawns deliberately omit spinners because they cede stdio to the spawned process (a spinner on the same TTY would corrupt claude's output). Coverage adequate as-is | - | - |
| 5.4 | Error rendering consistency | All errors go through one helper; format: title, cause, next step | 5.2 | cc:完了 |
| 5.4-result | **Helper landed 2026-05-04**: `src/ui/notify.ts` with `notifyError`/`notifyOk`/`notifyInfo`/`notifyWarn` + 8 API tests. NOT yet retrofit into the 27 existing `p.note(...)` call sites — that migration belongs in 5.2 (split main-menu into per-screen modules) so the new modules adopt the helper from line 1 instead of churning through twice | - | - |
| 5.5 | Color theme: review `src/ui/theme.ts` for accessibility (contrast, no-color env) | Theme respects `NO_COLOR=1`; verified in Linux ssh + Windows Terminal | 5.2 | cc:完了 |
| 5.5-result | **theme.ts**: already respects `NO_COLOR` (3 helpers strip ANSI when env set). **bin/cli.ts statusline bug FIXED**: `useColor` now honours both `--no-color` flag AND `NO_COLOR` env (no-color.org standard). Verified empirically with `od -c`: `NO_COLOR=1 cli statusline` produces zero ANSI escapes; without it, full colour | - | - |
| 5.6 | Keyboard shortcuts: documented and consistent | All menus use same nav keys; cheatsheet added to README | 5.2 | cc:完了 |
| 5.7 | Setup wizard polish (`src/ui/setup-wizard.ts` 195 lines) | First-run path tested on fresh `$HOME`; covered by E2E | 5.1 | cc:完了 |
| 5.7-result | 2 new tests for `runSetup` first-run flow on a sandboxed `$HOME`: (a) patches an empty `.zshrc` once, preserves prior content; (b) idempotent — second run does not duplicate the PATH block. setup.ts coverage **84% → 93.33%** line; uncovered remainder is Windows-only PowerShell paths (skipped on macOS test runner) + the interactive `runSetupWizard` clack flow (E2E for that requires TTY mocking — same as switcher.ts DI ask in 0.6b) | 5.1 | - |

---

## Phase 6: Merge gate

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 6.1 | Update FAQ entry on multi-terminal account drift | Replaces roadmap-issue link with concrete `claude switch profile use` instructions | 3b.1 | cc:完了 |
| 6.1-result | Two FAQ touch-ups: (1) NEW entry "I want different terminals using different accounts at the same time" pointing at profiles; (2) existing "switched accounts but other sessions still show old" entry rewritten to remove the roadmap-issue link and direct users to profiles instead. Both link into the new Profiles section | - | - |
| 6.2 | README "Profiles — true per-terminal isolation" section | Section explains UX + coexistence with legacy switch; example commands tested | 2.3, 3b.1 | cc:完了 |
| 6.2-result | Section landed in README before the "Smart features" header. Covers: motivation (per-terminal isolation gap in legacy flow), 5-line quickstart, import flow for saved accounts, coexistence table (legacy vs profile), platform note (macOS verified, Linux/Windows simpler internals). Examples are exactly what 3a.1a smoke verified | - | - |
| 6.3 | CHANGELOG preview for 2.7.0 | Drafted from conventional commits; reviewed for user-facing language | 2.2 | cc:完了 |
| 6.3-result | Draft in `.claude/docs/reports/changelog-preview-2.7.0.md`. release-please-style auto entry + user-facing addendum (suggested for the GH Release body, NOT CHANGELOG.md). 23 commits ahead of main, 2 feat → 2.7.0 minor | - | - |
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
