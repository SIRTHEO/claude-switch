# Profiles smoke test — real macOS

**Date**: 2026-05-04
**Branch**: `experiment/per-terminal-isolation` @ commit `c537760`
**Tester**: Claude Code (autonomous, harness-work skill, task 3a.1)
**Machine**: macOS Darwin 24.6.0, claude-switch v2.6.0 (build from HEAD)

## Scope

Real-machine smoke (NOT sandboxed HOME) of the per-terminal-isolation feature on macOS:

- `claude switch profile create / list / status / use / remove`
- `claude switch profile import <email>` (legacy → isolated profile re-key)
- Path-traversal + reserved-name + length-limit input validation
- Keychain entry lifecycle: created on import, NOT auto-cleaned on remove

The interactive `profile login` and `profile use` (spawning a real `claude` REPL) are NOT covered by this report — they require a browser OAuth flow, which falls under task **3a.1b**.

## Pre-state baseline

| Artefact | State |
|---|---|
| `~/.claude/profiles/` | empty (no profiles) |
| Keychain entries for `Claude Code-credentials` | 2 unique accounts: `theo`, `Claude Code-credentials` (legacy) |
| `~/.claude.json` active account | `matteo19.dimattia@icloud.com` |
| Saved legacy accounts | `matteo19.dimattia@icloud.com.json`, `tech@gyver.work.json` (both have `_keychain` blob) |

## Test 1 — Lifecycle (no login)

| Step | Command | Outcome |
|---|---|---|
| 1.1 | `profile create harness-smoke-test` | ✅ Dir created `~/.claude/profiles/harness-smoke-test`, mode `0700`, owner `501:20` |
| 1.2 | Keychain count after create | ✅ Unchanged (no entry written — Keychain is populated only on `login` or `import`) |
| 1.3 | `profile list` | ✅ Shows `harness-smoke-test (not logged in — run: claude switch profile login harness-smoke-test)` |
| 1.4 | `profile status harness-smoke-test` | ✅ Renders `Email: (not logged in yet)`, `User ID: (not yet assigned — run claude once in this profile)` |
| 1.5 | `profile use harness-smoke-test` (no login yet) | ✅ Refused with `Profile "harness-smoke-test" has no login yet. Run: claude switch profile login harness-smoke-test` (exit non-zero) |
| 1.6 | `profile remove harness-smoke-test` | ✅ Dir deleted; **no Keychain message** (correct — `userID` was null because no claude run, so no orphan entry exists) |

## Test 2 — Input validation

| Input | Outcome |
|---|---|
| `profile create '../escape'` | ✅ Rejected: `Invalid profile name "../escape". Use letters, digits, _ or - (max 64 chars)…` |
| `profile create list` (reserved) | ✅ Rejected with same message; reserved list verified: `list, ls, create, use, login, remove, rm, status, help` |
| `profile create <70-char string>` | ✅ Rejected (max 64 chars) |

The `profilePath()` defence-in-depth check (`resolved.startsWith(base + path.sep)`) is present in `src/profiles.ts:55-57` but cannot be reached after `isValidProfileName()` returns false on `..`. Validation regex `^[A-Za-z0-9_-]{1,64}$` already excludes `/` and `.`. Belt-and-braces; fine to keep.

## Test 3 — Import flow (legacy account → isolated profile)

Pre-state: 2 Keychain entries.

```
$ node dist/bin/cli.js switch profile import tech@gyver.work --as harness-import-test

✔ Imported "tech@gyver.work" into profile "harness-import-test"
  Path:    /Users/theo/.claude/profiles/harness-import-test
  User ID: 9cbd92f9efba063e…
  Tokens:  written to macOS Keychain (account=9cbd92f9efba063e…)

Use it now with:  claude switch profile use harness-import-test
```

Verifications:

| Check | Result |
|---|---|
| Profile dir created with mode 0700 | ✅ |
| `<profile>/.claude.json` contains `userID` (64 hex chars) + `oauthAccount.{emailAddress, accountUuid, organizationName}` | ✅ |
| `<profile>/.claude.json` does **NOT** contain access/refresh tokens (macOS path) | ✅ — tokens go to Keychain, JSON has metadata only |
| Keychain entry created for new userID | ✅ — count went 2 → 3 |
| Keychain blob contains `claudeAiOauth.{accessToken, refreshToken, expiresAt}` | ✅ |
| `profile list` shows `→ tech@gyver.work` | ✅ |
| `profile status harness-import-test` shows email + full userID | ✅ |

⚠️ **Finding (informational)**: imported tokens for `tech@gyver.work` had `expiresAt` 4 days in the past. This is expected — the legacy `_keychain` blob stores the snapshot from when `claude switch` last touched the account, not a fresh token. Claude Code refreshes via the refreshToken on next run. This needs to be verified in 3a.1b (interactive `profile use`).

## Test 4 — Cleanup + post-state restoration

```
$ node dist/bin/cli.js switch profile remove harness-import-test
Removed profile dir: /Users/theo/.claude/profiles/harness-import-test

Note: macOS Keychain still has an entry created by claude for this profile.
To remove it manually:
  security delete-generic-password -a "9cbd92f9efba063e602c6ded7294139124a033e740b40525d8a04933e4b45bf9" -s "Claude Code-credentials"
```

Then ran the printed `security delete-generic-password` command manually:

```
$ security delete-generic-password -a "9cbd…bf9" -s "Claude Code-credentials"
password has been deleted.
```

Post-state:

| Check | Pre-state | Post-state | OK? |
|---|---|---|---|
| `~/.claude/profiles/` | empty | empty | ✅ |
| Keychain entries for service `Claude Code-credentials` | 2 | 2 | ✅ |
| `~/.claude.json` active account | `matteo19.dimattia@icloud.com` | `matteo19.dimattia@icloud.com` | ✅ |
| `claude switch list` | 2 saved accounts | same 2 accounts | ✅ |
| Default Keychain entry (`account=theo`) | present | present | ✅ |

**Regression check (3a.2)**: legacy `claude switch <account>` flow is unaffected by profile operations. ✅

## Findings

### F1 — `profile remove` does NOT auto-clean Keychain entries (BY DESIGN)

`src/profiles.ts:138-148`: `removeProfile()` returns the `userID` so the caller can clean up the Keychain entry; `bin/cli.ts:589-601`: the CLI surfaces a copy-pasteable `security delete-generic-password` command but does NOT execute it.

Rationale documented in code: "we don't want to delete entries we didn't create without explicit user confirmation". But the entry IS created by us indirectly (we spawn `claude auth login` with `CLAUDE_CONFIG_DIR=<profile>` which writes the entry on the user's behalf, OR our `importProfileFromAccount` writes it via `writeKeychainAt`).

**Recommended improvement (logged for Phase 3b)**: `profile remove` should accept `--purge-keychain` flag, or prompt interactively when stdin is a TTY: "Also remove the macOS Keychain entry for this profile? [y/N]". Default `N` keeps backward compat.

### F2 — Imported tokens may be stale (informational)

When importing from a legacy account that hasn't been recently used, the embedded `expiresAt` may be in the past. Claude Code's refresh-token flow handles this at first run, but a proactive check in `importProfileFromAccount` to warn the user (`⚠ Imported tokens expired N days ago — first claude run will refresh`) would improve UX.

### F3 — `profile remove` of a fresh (never-logged-in) profile is silent on Keychain

When `userID` is null (profile created but never `login`-ed), `bin/cli.ts:595` correctly skips the Keychain cleanup hint. Verified ✅.

### F4 — Defence-in-depth path traversal is currently unreachable

The `profilePath()` boundary check at `src/profiles.ts:55-57` is unreachable due to the regex in `isValidProfileName()` excluding `/`, `\`, and `.`. Not a bug — just dead code at runtime. Keep as a safety net for future regex relaxation.

## Coverage gaps (require interactive flow — task 3a.1b)

These need a real browser OAuth and were intentionally not exercised here:

1. **`profile login <name>`** — verifies that spawning `claude auth login` with `CLAUDE_CONFIG_DIR` populates `<profile>/.claude.json` with a fresh oauthAccount and writes a fresh Keychain entry (different userID than imported one).
2. **`profile use <name>`** — verifies the spawned `claude` REPL actually authenticates as the profile's account (banner shows the right email; subscription usage is per-profile).
3. **Cross-terminal isolation** — open two terminals, `profile use A` in one and `profile use B` in the other, verify they don't interfere (this is the original motivating use case from `EXPERIMENT.md`).
4. **Imported profile usability** — does `profile use harness-import-test` immediately work (refresh-on-run path), or does it fail with "expired token" requiring manual `profile login`?
5. **MCP sub-process inheritance** — when `claude` spawns MCP servers, do they inherit `CLAUDE_CONFIG_DIR`? (Task 3a.6 covers this explicitly.)

## Status

| Plans.md task | Result |
|---|---|
| **3a.1a** (this report — non-interactive) | ✅ PASS |
| **3a.1b** (interactive: login/use/two-terminal) | ⏳ TODO (needs user-driven OAuth) |
| **3a.2** (regression on legacy switch) | ✅ PASS (verified at end of Test 4) |
| **3a.3** (Keychain orphan audit) | ✅ PASS — orphan risk is real but visible (printed instructions); recommend F1 improvement |

## Reproducibility

```bash
npm run build
CLI=dist/bin/cli.js
PROFILE=harness-smoke-test

# Lifecycle
node $CLI switch profile create $PROFILE
node $CLI switch profile list
node $CLI switch profile status $PROFILE
node $CLI switch profile use $PROFILE     # expect: refused (no login)
node $CLI switch profile remove $PROFILE

# Validation
node $CLI switch profile create '../escape'   # expect: rejected
node $CLI switch profile create list          # expect: rejected (reserved)

# Import (requires existing legacy account with _keychain blob)
node $CLI switch profile import <email> --as harness-import-test
USERID=$(jq -r .userID ~/.claude/profiles/harness-import-test/.claude.json)
node $CLI switch profile remove harness-import-test
security delete-generic-password -a "$USERID" -s "Claude Code-credentials"
```

Pre/post Keychain state verifiable with:

```bash
security dump-keychain ~/Library/Keychains/login.keychain-db 2>/dev/null \
  | awk '/"svce"<blob>="Claude Code-credentials"/{c++} END{print c}'
```
