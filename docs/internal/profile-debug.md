# Profile Debug Flag — `CLAUDE_SWITCH_DEBUG_PROFILES`

Internal diagnostic tool for tracing the credential-resolution path of
`ensureProfileForAccount`. Useful for identifying which of the five known
failure hypotheses (H1–H5) is active on a specific machine.

---

## Enable

Set the environment variable before running any `claude switch` command:

```bash
CLAUDE_SWITCH_DEBUG_PROFILES=1 claude switch <email>
```

Or to open an isolated profile:

```bash
CLAUDE_SWITCH_DEBUG_PROFILES=1 claude switch open --isolated <email>
```

All debug output is written to **stderr** only. The prefix is always
`[claude-switch:profiles]`. Normal stdout output is unaffected.

---

## Expected output by hypothesis (H1–H5)

Each hypothesis produces a recognisable pattern in the debug lines.

### H1 — legacy snapshot absent

The account was authenticated directly via `claude /login`, never via
`claude switch save`. No `~/.claude/accounts/<email>.json` exists.

Expected lines:

```
[claude-switch:profiles] ensureProfileForAccount email=<email> disableKeychain=false
[claude-switch:profiles] emailMatch=false profileFound=false importing from legacy account
```

Followed by an error thrown from `readLegacyAccount` ("No saved account for
`<email>`"). The UI surfaces this as a login prompt.

### H2 — legacy snapshot stale, account not active

`_keychain.claudeAiOauth.accessToken` is expired. `refreshLegacySnapshotIfStale`
was called (at the UI call site) but failed silently (network error or expired
`refreshToken`). `tryRecoverFromLegacy` writes the stale blob to the per-
config-dir Keychain entry anyway.

Expected lines:

```
[claude-switch:profiles] ensureProfileForAccount email=<email> disableKeychain=false
[claude-switch:profiles] emailMatch=false profileFound=false importing from legacy account
[claude-switch:profiles] importProfileFromAccount legacyKeychain=true useKeychain=true profileDir=<path>
[claude-switch:profiles] keychainWrite=success service=per-config-dir account=<path> (import from snapshot)
[claude-switch:profiles] profileFound=true path=<path> needsLogin=false created=true
[claude-switch:profiles] recoveryAttempted=true legacyKeychain=true reason=snapshot-stale profileDir=<path>
[claude-switch:profiles] keychainWrite=success service=per-config-dir account=<path>
```

`needsLogin=false` but claude subsequently 401s — the Keychain entry contains
expired tokens. Distinguishing signal: `reason=snapshot-stale` in the
`recoveryAttempted` line. The stale check is a synchronous `expiresAt` comparison
against `Date.now()`.

### H3 — active account, stale snapshot

The "real" tokens live in `~/.claude.json` and the default Keychain entry
(`Claude Code-credentials` keyed by OS username). The legacy snapshot's mtime
looks fresh but the tokens inside are outdated because claude rotates the
Keychain in-process without always rewriting `claude.json`.

Expected lines:

```
[claude-switch:profiles] ensureProfileForAccount email=<email> disableKeychain=false
[claude-switch:profiles] emailMatch=true profileFound=true path=<path>
[claude-switch:profiles] captureLive emailMatchActive=true profileDir=<path>
[claude-switch:profiles] keychainWrite=success service=per-config-dir account=<path> (live capture)
[claude-switch:profiles] hasLogin=true reason=json-ok
```

Distinguishing signal: `emailMatchActive=true` in the `captureLive` line and
`keychainWrite=success (live capture)`. On darwin, `captureLiveCredentialsForActiveAccount`
fires before `readProfile` for the matching profile — if it succeeds the fresh
tokens are captured from the default Keychain. If tokens still drift after that,
H3 is confirmed and the live-capture path has a separate bug. If tokens already
match, `keychainWrite=skipped (already in sync)` appears instead.

### H4 — existing profile, wrong Keychain service, no `_keychain` in legacy

Profiles created by claude-switch ≤ 3.4.x wrote the Keychain entry at the
wrong service (keyed by `userID` instead of the per-config-dir SHA256 prefix).
`readProfile` on darwin demotes `hasLogin=false`. `tryRecoverFromLegacy` finds
no `_keychain` in the legacy file → no-op → `needsLogin=true`.

Expected lines (legacy file absent):

```
[claude-switch:profiles] ensureProfileForAccount email=<email> disableKeychain=false
[claude-switch:profiles] emailMatch=true profileFound=true path=<path>
[claude-switch:profiles] captureLive emailMatchActive=false profileDir=<path>
[claude-switch:profiles] hasLogin=false reason=keychain-miss
[claude-switch:profiles] recoveryAttempted=true legacyKeychain=false profileDir=<path> (readLegacyAccount failed)
```

If the legacy file exists but has no `_keychain` key:

```
[claude-switch:profiles] recoveryAttempted=true legacyKeychain=false reason=keychain-miss profileDir=<path>
```

Distinguishing signal: `reason=keychain-miss` + `legacyKeychain=false` (vs H2
where `legacyKeychain=true` and `reason=snapshot-stale`).

### H5 — `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` set accidentally

The environment variable is present (shell rc file, leftover test fixture, CI
environment). Every profile on darwin appears as `needsLogin=true` because both
`readKeychainForConfigDir` and `writeKeychainForConfigDir` are skipped.

Expected lines:

```
[claude-switch:profiles] ensureProfileForAccount email=<email> disableKeychain=true
[claude-switch:profiles] emailMatch=true profileFound=true path=<path>
[claude-switch:profiles] hasLogin=false reason=disable-flag
```

Distinguishing signal: `disableKeychain=true` on the first line and
`reason=disable-flag`.

---

## Repro workflow

1. Enable the flag and run the failing command:

   ```bash
   CLAUDE_SWITCH_DEBUG_PROFILES=1 claude switch open --isolated <email> 2>debug.log
   ```

2. Inspect `debug.log`:

   ```bash
   grep '\[claude-switch:profiles\]' debug.log
   ```

3. Match the line pattern against H1–H5 above.

4. Share the relevant lines (redacting real email addresses if needed) in the
   Phase 12.1 spike report.

---

## Log line reference

| Field | Values | Meaning |
|-------|--------|---------|
| `disableKeychain` | `true` / `false` | `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` is set |
| `emailMatch` | `true` / `false` | A profile with `oauthAccount.emailAddress` matching the request was found |
| `emailMatchActive` | `true` / `false` | The requested email matches `getCurrent()` (currently active account) |
| `profileFound` | `true` / `false` | A matching profile (by email or derived name) exists |
| `hasLogin` | `true` / `false` | `readProfile().hasLogin` after live-capture attempt |
| `reason` | `json-ok` / `keychain-miss` / `disable-flag` / `snapshot-stale` | Why `hasLogin` has that value |
| `recoveryAttempted` | `true` | `tryRecoverFromLegacy` was invoked (darwin + Keychain enabled only) |
| `legacyKeychain` | `true` / `false` | `_keychain` key is present in the legacy account JSON |
| `keychainWrite` | `success` / `failed` / `skipped` | Result of the Keychain write attempt |
