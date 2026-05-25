# Architecture (internal)

Internal notes for contributors. Three layers:

1. **Domain** (`src/*.ts`) — `accounts.ts`, `profiles.ts`, `keychain.ts`,
   `oauth-refresh.ts`, `api-proxy.ts`, `errors.ts`. Pure-ish, lock-disciplined
   via `withLock(accountsDirPath)` at the UI boundary.
2. **Commands** (`src/commands/*.ts`) — one handler per CLI subcommand;
   orchestrate domain + UI.
3. **UI** (`src/ui/*.tsx`) — Ink screens + `run-app.ts` orchestrator.

See `docs/internal/error-handling.md` for the catch/exit conventions.

## Isolated-profile credential reuse

"Open account isolated" creates a per-profile config dir
(`CLAUDE_CONFIG_DIR=<profile>`) and launches `claude` against it. The goal is
to reuse credentials the user already has on the machine instead of forcing a
browser OAuth re-login. `ensureProfileForAccount(email, accountsDir)` is the
entry point. Credentials can come from three sources, in order of authority:

1. **An existing profile** already linked to the email — reused as-is. When the
   email matches the currently-active account, the profile's per-config-dir
   Keychain entry is refreshed from the live default Keychain
   (`captureLiveCredentialsForActiveAccount`), covering token rotation drift.
2. **A legacy snapshot** (`<accountsDir>/<email>.json`, written by
   `accounts.save`) — imported into a fresh profile. Stale access tokens are
   refreshed first via `refreshLegacySnapshotIfStale`.
3. **An implicit snapshot** — see below.

### Implicit snapshot for never-saved active accounts

An account authenticated directly (e.g. `claude /login`) never goes through
`claude switch save`, so it has no legacy snapshot. Without one, the import
step throws "No saved account" and the UX degrades to a browser re-login even
though the live credentials sit in `~/.claude.json` + the default Keychain.

To close this gap, `ensureProfileForAccount` performs an **implicit
`accounts.save`** right before the import step, but only when **all** of the
following hold:

- no legacy snapshot file exists for the email, **and**
- the email equals the currently-active account (`getCurrent`).

The active-account guard is essential: snapshotting a non-active email would
capture the wrong account's live tokens under the wrong filename. When the
email is not active, the implicit save is skipped and the import falls through
to its existing "No saved account" behaviour.

The implicit save is enabled by default. Opt out with
`CLAUDE_SWITCH_NO_IMPLICIT_SAVE=1` (one release of back-compat for anyone
relying on the previous throw).

> Under `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` (the test default) the snapshot is
> written without a `_keychain` block, so the import succeeds but credentials
> are not fabricated — the result honestly reports `needsLogin=true`. Real
> live-Keychain capture is exercised manually on darwin, the same policy used
> for `tryRecoverFromLegacy`.
