# Onboarding — claude-switch

> Auto-generated from the project's knowledge graph (`/understand-anything:understand`, commit `4728336`).
> Regenerate after major architectural changes: `claude /understand-anything:understand` then `/understand-anything:understand-onboard`.

## Project Overview

**`@sirtheo/claude-switch`** — a drop-in `claude` wrapper for multi-account management. Sign in once per account, switch instantly, bypass Max/Pro rate limits via API-key fallback that auto-reverts when the rate window resets. Cross-platform CLI (macOS, Linux, Windows).

| | |
|---|---|
| Languages | TypeScript, JSON, Markdown, YAML, Shell, JS (`.mjs`) |
| Frameworks | Ink (terminal React), GitHub Actions, TypeScript strict |
| Total source files | 150 (121 code, 16 docs, 7 config, 4 infra/CI, 2 scripts) |
| Test runner | `node --test --experimental-test-coverage`, 60% coverage floor |
| Release | release-please (conventional commits → semver bumps) |

## Architecture — 8 Layers

```
                ┌──────────────────────────┐
                │  Entry Point (bin/cli.ts)│
                └────────────┬─────────────┘
                             │
                ┌────────────▼─────────────┐
                │  Command Handlers        │
                │  (src/commands/*.ts)     │
                └─────────┬────────┬───────┘
                          │        │
            ┌─────────────▼──┐  ┌──▼─────────────┐
            │  Domain Core   │  │  Ink Terminal UI│
            │  (src/*.ts)    │  │  (src/ui/*.tsx) │
            └────────────────┘  └─────────────────┘
                          │
                ┌─────────▼─────────┐
                │   Tests, Docs,    │
                │   CI/CD, Config   │
                └───────────────────┘
```

| Layer | Description | Key Files |
|---|---|---|
| **Entry Point** | CLI shim that bootstraps the process and dispatches | `bin/cli.ts` |
| **Command Handlers** | Per-subcommand orchestrators translating CLI invocations into domain operations + UI | `src/commands/{passthrough,switch,profile,statusline,route,…}.ts` |
| **Ink Terminal UI** | React/Ink screens, hooks, theme; the interactive flows (home, profiles, manage-account, setup wizard) | `src/ui/run-app.ts` + `src/ui/screens/*.tsx` |
| **Domain Core** | Pure, lock-disciplined business logic. Accounts, profiles, keychain, OAuth refresh, proxy, fallback, routing | `src/{accounts,profiles,keychain,oauth-refresh,api-proxy,fallback,routing,paths,atomic-write,errors}.ts` |
| **Tests** | Node test runner suites mirroring `src/` structure | `test/*.test.ts` (55 files) |
| **Build & CI Infrastructure** | GitHub Actions, shell scripts driving lint/test/release-please | `.github/workflows/*.yml` + `scripts/*.sh` |
| **Documentation** | User-facing + internal architecture docs | `README.md`, `CHANGELOG.md`, `docs/internal/{architecture,error-handling}.md` |
| **Project Configuration** | Top-level manifests + release tooling | `package.json`, `tsconfig.json`, `release-please-config.json` |

## Guided Tour

Recommended reading order for new contributors. Each stop maps to a real concern users actually have.

### 1. Project Overview — `README.md`
Frames the product pitch: multi-account, OAuth↔API fallback, isolated profiles. Every later module maps back to a user-facing promise here.

### 2. CLI Entry Point — `bin/cli.ts` + `src/commands/context.ts`
What actually runs when the user types `claude`. Parses arguments, decides claude-switch subcommand vs passthrough, dispatches to the right handler in `src/commands/`.

### 3. Foundation — `src/{errors,paths,lock,atomic-write}.ts`
Three tiny modules underpin every domain operation:
- `errors.ts` — `ExitError` + `errMessage`/`errnoCode` safe extractors (no `as Error` casts)
- `paths.ts` — canonical filesystem layout (`~/.claude/accounts/`, `~/.claude.json`)
- `lock.ts` — filesystem mutex with stale-PID reclaim. `withLock(accountsDir)` serialises every mutation so two terminals running `claude switch` in parallel can never tear state

### 4. Account Persistence — `src/{accounts,aliases}.ts`
`accounts.ts` is the most depended-on module in the repo (fan-in ~40). Saves/loads/lists/removes the on-disk snapshots that capture each account's identity + OAuth credentials. `aliases.ts` layers human-friendly names (`@work`, `@personal`).

### 5. Credentials — `src/{keychain,apikey,apikey-keychain,token}.ts`
Secrets never live in plain JSON.
- `keychain.ts` — macOS Keychain access via `security` command (see Caveat below — graph summary says cross-platform but on Linux/Windows tokens actually live in `.claude.json`)
- `apikey.ts` + `apikey-keychain.ts` — per-account API keys, masked metadata in account file, secret in OS keychain on darwin
- `token.ts` — derives token health/expiry

### 6. The Switcher — `src/{switcher,state-store,preferences,active-sessions}.ts`
Heart of the tool. `switcher.ts` orchestrates `claude switch <account>`: lock → swap active claude profile on disk → sync fallback state → refresh OAuth tokens if needed → update last-used marker. `preferences.ts` handles per-account `authMode` (auto/oauth-first/api-first).

### 7. Passthrough — `src/commands/passthrough.ts` + `src/{resolver,find-claude,proxy}.ts`
When the user types plain `claude`, passthrough resolves active account, configures routing + fallback, spawns the real Claude CLI as a child. `find-claude.ts` locates the binary across PATH/npm/yarn/pnpm/platform install dirs. `proxy.ts` forks with merged env, mirroring stdio so users see zero difference from official tool.

### 8. Auto-Fallback + API Proxy — `src/{auto-fallback,fallback,fallback-env,api-proxy}.ts`
The headline feature.
- `auto-fallback.ts` — detects rate-limit windows, decides when to engage API-key fallback per account
- `fallback.ts` + `fallback-env.ts` — state mutation + `ANTHROPIC_API_KEY` env override injection
- `api-proxy.ts` — local HTTP proxy intercepting Claude CLI traffic. Swaps OAuth bearer for API key on the fly, so the same `claude` invocation transparently spans OAuth and API auth as quotas reset

### 9. Profiles + Routing — `src/{profiles,routing,usage}.ts`
- `profiles.ts` — isolated per-terminal accounts via `CLAUDE_CONFIG_DIR`. Two terminals can run `@work` and `@personal` simultaneously with zero interference
- `routing.ts` — parses `.claude-switch` files in repos + global rules, resolves which account to use from cwd. Users stop typing `claude switch` once configured

### 10. Ink Terminal UI — `src/ui/{run-app,screen-buffer,screens/*}`
When user runs `claude switch` with no args, an Ink dashboard takes over. `run-app.ts` drives screens (home, manage-account, profiles, auto-fallback). `screen-buffer.ts` swaps the terminal into alt-buffer for clean restore on exit.

### 11. Quality-of-Life — `src/{setup,statusline-install,update-check,version,completions}.ts`
- `setup.ts` — first-run wizard, locates real claude binary, patches shell config
- `statusline-install.ts` — injects status-line entry into Claude Code settings
- `update-check.ts` + `version.ts` — once-a-day npm registry check, prompt only on next interactive `claude switch`. Never silent install, no telemetry

### 12. Architecture Docs + CI
Capstone:
- `docs/internal/architecture.md` — formalises the 3-layer model walked above
- `docs/internal/error-handling.md` — the 4 allowed error patterns enforced by `errors.ts`
- `.github/workflows/{ci,codeql,release}.yml` — lint/type-check/tests with 60% coverage floor, CodeQL security scans, release-please for semver

## Complexity Hotspots

Approach these carefully — they encapsulate non-trivial state or cross-cutting logic:

| File | Why it's complex |
|---|---|
| `bin/cli.ts` | Argument parsing + subcommand routing + 30+ dispatch cases |
| `src/accounts.ts` | Lock-disciplined, +14 callers fan-in, JSON+Keychain consistency invariant |
| `src/api-proxy.ts` | Local HTTP proxy + OAuth↔API token swap + 3-state machine (oauth-first/oauth-burst/api-first) |
| `src/auto-fallback.ts` | Rate-limit window detection, per-account engagement decisions, smart-revert timing |
| `src/profiles.ts` | Per-config-dir Keychain service naming, legacy snapshot migration, live-Keychain capture (Phase 12.2) |
| `src/keychain.ts` | macOS Keychain service-name derivation (`sha256[:8]` of `CLAUDE_CONFIG_DIR`), claude binary compat |
| `src/commands/passthrough.ts` | Routing resolution + fallback computation + child spawn + env merge |
| `src/preferences.ts` | Per-account `authMode` resolution, defaults migration |

## Caveats / Known graph quirks

The knowledge graph was generated by LLM analysis — a couple of summaries are slightly off and worth flagging:

- **`src/keychain.ts` summary** mentions "libsecret on Linux, wincred on Windows" — this is **wrong**. claude-switch only uses macOS Keychain via the `security` command. On Linux/Windows, tokens live directly in `~/.claude.json` under `oauthAccount.accessToken` (see actual code + `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` env semantics).
- **Tour step 5** repeats the libsecret/wincred claim — same caveat applies.

For accurate cross-platform details, see `docs/internal/architecture.md` and `src/keychain.ts:1-25` (file header comment).

## Privacy + Conventions Quick Reference

From `CLAUDE.md` (local-only) — the rules every contributor should know:

- **Privacy in tracked files**: never commit personal emails (use `sirtheo` handle or just GitHub primitives for maintainer identity). Fixtures use `sirtheo.work@example.com` / `sirtheo.personal@example.com` and `/tmp/sirtheo-home`.
- **Commit style**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). End-of-milestone coordinated releases use `Release-As: X.Y.Z` footer.
- **Testing**: `npm test`. Always set `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` for tests that exercise Keychain code paths (avoids leaking real Keychain entries).
- **TS strict**: no `any`; `as` only for `JSON.parse` + `NodeJS.ErrnoException` (use `errMessage`/`errnoCode` helpers from `src/errors.ts`).
- **Migration story**: schema changes apply on-read; no migration scripts.
- **Release**: never push to `main` without explicit user OK. release-please opens PR automatically with bump derived from conventional commits.

## Next Steps for New Contributors

1. **Run it locally**:
   ```bash
   git clone https://github.com/SIRTHEO/claude-switch.git
   cd claude-switch && npm install && npm run build
   ./dist/bin/cli.js --help
   ```

2. **Run the test suite**:
   ```bash
   npm test   # builds + runs node --test against dist/test/
   ```

3. **Pick a starter issue**:
   - Browse [open issues](https://github.com/SIRTHEO/claude-switch/issues) with `good-first-issue` label
   - Or pick a `cc:TODO` task in `Plans.md` (local file, gitignored — ask maintainer to share)

4. **Visualize the architecture**:
   ```bash
   claude /understand-anything:understand-dashboard
   ```
   Opens an interactive graph viewer at `http://127.0.0.1:5173?token=…`. Drill into any file, follow imports/calls/depends_on edges, browse layers and tour steps interactively.

5. **Ask the codebase**:
   ```bash
   claude /understand-anything:understand-chat
   ```
   Query the knowledge graph in natural language ("how does fallback engage?", "where is the profile dir resolved?").

6. **Deep-dive a specific file**:
   ```bash
   claude /understand-anything:understand-explain src/api-proxy.ts
   ```
