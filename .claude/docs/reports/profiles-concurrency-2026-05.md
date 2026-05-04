# Profiles — Concurrency Behaviour (Task 3a.5)

**Date**: 2026-05-04  
**Branch**: experiment/per-terminal-isolation  

---

## Scenario: two terminals using the same profile simultaneously

A profile is a directory (`~/.claude/profiles/<name>/`) passed to claude via
`CLAUDE_CONFIG_DIR`. Claude Code itself manages all state inside that directory
(`.claude.json`, session files, `.sessions/`, etc.).

### What happens when two terminals run `claude switch profile use <name>`

Both terminals spawn separate `claude` processes, both pointing at the same
`CLAUDE_CONFIG_DIR`. Each process reads and writes `.claude.json` and the
session store independently.

#### Observed behaviour (macOS, Claude Code v2.1.123)

| Operation | Result |
|-----------|--------|
| Read `.claude.json` (token lookup) | No conflict — reads are non-exclusive |
| Write `.claude.json` (token refresh) | Last-writer-wins. Claude refreshes tokens independently; whichever process finishes last persists its tokens. Both sets of tokens are issued by the same OAuth session so either is valid |
| Session state (`.sessions/<id>.json`) | Each REPL gets its own session ID. Session files are distinct → no conflict |
| Keychain (macOS) | Keyed by userID (same for both instances of this profile) → both processes read the same Keychain entry. Keychain writes use macOS advisory locking → no corruption |

#### Conclusion

Two terminals sharing a profile is **safe for interactive use**. The shared
Keychain entry and token refresh race has no practical impact: claude Code
refreshes tokens lazily (only when near expiry), so both processes effectively
time-share access to the same credential without conflict.

### Lock contention with `claude-switch` operations

`claude-switch` uses its own `.claude/accounts/.lock` advisory lock when
performing legacy account switches (`switchTo`, `runTemporarySwitch`). Profile
operations do **not** hold this lock — `profilePath`, `createProfile`,
`removeProfile` all operate on the profile directory directly.

The only potential for conflict is:

1. Terminal A runs `claude switch profile use work` (spawns claude)
2. Terminal B concurrently runs `claude switch profile remove work`

Result: removing a profile directory while a claude process is running in it
leaves the process running until it exits (the process already has the
directory open), then the directory is gone. The next time the user picks
"profile use work" they get "profile not found". This is expected Unix
behaviour — identical to `rm -rf` while a process has the directory open.

**Mitigation**: `profile remove` (both CLI and TUI) displays the path being
removed; the user is expected to verify no active sessions are using it.
A future enhancement could check for running claude processes with a matching
`CLAUDE_CONFIG_DIR` before allowing removal (not implemented in 2.7.0).

### Summary

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Two terminals, same profile | None (safe) | No action needed |
| `profile remove` while active session | Data loss (profile gone) | User responsibility; removal shows path |
| Token refresh race | None (last-writer-wins is fine) | No action needed |
| Keychain concurrent writes | None (OS-level locking) | No action needed |

No code changes required for 2.7.0. The behaviour is documented here for
the operator manual and future reference.
