# Profiles — Linux Behaviour Spike (Task 3a.4)

**Date**: 2026-05-04  
**Branch**: experiment/per-terminal-isolation  
**Method**: static code analysis of `src/profiles.ts`, `src/keychain.ts`,
`src/proxy.ts`; cross-referenced against Claude Code documentation and the
verified macOS smoke report (`profiles-smoke-macos.md`).

---

## Key difference: no Keychain on Linux/Windows

Claude Code stores OAuth tokens in **two** places depending on platform:

| Platform | Token storage |
|----------|--------------|
| macOS    | macOS Keychain (service `"Claude Code-credentials"`, account = userID) |
| Linux    | `CLAUDE_CONFIG_DIR/.claude.json` (default path set by Claude Code itself; claude-switch uses `~/.claude/profiles/<name>/` for profiles) |
| Windows  | `CLAUDE_CONFIG_DIR\.claude.json` (same pattern) |

Profiles leverage exactly this: setting `CLAUDE_CONFIG_DIR` to a per-profile
directory gives each profile its own `.claude.json` that contains the tokens
directly — no Keychain involved at all.

---

## Profile creation on Linux

```bash
claude switch profile create work
# → ~/.claude/profiles/work/  (mode 0700)
# → no Keychain entry (not applicable)
```

## Profile login on Linux

```bash
claude switch profile login work
# → spawns: CLAUDE_CONFIG_DIR=~/.claude/profiles/work/ claude auth login
# → on success, claude writes tokens to ~/.claude/profiles/work/.claude.json
# → includes: oauthAccount.accessToken, refreshToken, expiresAt
```

Unlike macOS, there is no Keychain entry to create. The entire credential
blob is in `.claude.json` at the profile path.

## Profile import on Linux

`importProfileFromAccount` follows the non-darwin path:

```typescript
} else if (_keychain.claudeAiOauth) {
  claudeJson.oauthAccount = {
    ...oauthFields,
    emailAddress: email,
    accessToken: _keychain.claudeAiOauth.accessToken,
    refreshToken: _keychain.claudeAiOauth.refreshToken,
    expiresAt: _keychain.claudeAiOauth.expiresAt,
  };
}
```

The `_keychain.claudeAiOauth` fields (accessToken, refreshToken, expiresAt)
are written **directly into the profile's `.claude.json`** — no
`writeKeychainAt` call. This means import works without any system
credential store.

> **Caveat**: accounts saved before v2.2 (no `_keychain` field) will have
> `needsLogin = true` on all platforms, requiring a browser login after
> import.

## Profile use on Linux

```bash
claude switch profile use work
# → spawns: CLAUDE_CONFIG_DIR=~/.claude/profiles/work/ claude [args]
# → claude reads ~/.claude/profiles/work/.claude.json for tokens
# → no Keychain lookup required
```

Claude Code on Linux reads tokens from `.claude.json` at startup
rather than querying a credential store. The `CLAUDE_CONFIG_DIR`
environment variable is honoured natively.

## Edge cases on Linux

| Scenario | Behaviour |
|----------|-----------|
| `profile remove work` | Deletes `~/.claude/profiles/work/` entirely. No Keychain cleanup needed (no entry was created). Cleaner than macOS. |
| `profile status work` | Keychain field shows `(not applicable on this platform)`. All other fields (email, token validity via mtime/expiresAt, userID) behave identically to macOS. |
| `readKeychain()` call | Returns `null` on non-darwin (early return at line 33 of `keychain.ts`). Safe no-op. |
| `writeKeychainAt()` call | Returns immediately on non-darwin (line 66 of `keychain.ts`). Called only from `importProfileFromAccount` on darwin path. |
| Token refresh by claude | Claude Code on Linux writes refreshed tokens back to the same `.claude.json` — contained within the profile dir, no cross-profile pollution. |
| Two terminals, same profile | Identical to macOS: last-writer-wins on `.claude.json` token refresh. Session files are distinct per REPL. Safe in practice. |
| `CLAUDE_CONFIG_DIR` not set | Falls back to default `~/.config/Claude/`. Legacy `claude switch` flow unaffected. |

## File permissions

`createProfile` creates the directory with `mode: 0o700` on all platforms.
`writeJsonAtomic` uses a temp-file + rename pattern — inherits directory
permissions on Linux.

There is no equivalent of the macOS Keychain's ACL on Linux. The only
protection for tokens is the `0700` directory mode. This is the same
model Claude Code itself uses for its default config directory on Linux.

## Summary

Profiles work **better on Linux than macOS** in some respects:

- No Keychain dependency — simpler import/remove
- Tokens fully contained in the profile directory — trivial backup/inspect
- `profile remove` is a complete cleanup with no orphaned Keychain entries

No code changes are needed for Linux support. The non-darwin path in
`importProfileFromAccount` correctly writes tokens to `.claude.json`,
and `writeKeychainAt` / `readKeychain` are both no-ops on non-darwin.

The only Linux-specific limitation is that the `profile status` command's
Keychain check returns `(not applicable on this platform)` — correct
and user-visible.
