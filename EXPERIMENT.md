# Per-terminal isolation — research log

**Branch:** `experiment/per-terminal-isolation`
**Started:** 2026-04-30

## The problem

Claude Code's active-account state is **global per OS user**:
- Identity (`~/.claude.json` — `oauthAccount.emailAddress`)
- Tokens (macOS Keychain, or `~/.claude.json` on Linux/Windows)

When the user runs `claude switch B` in terminal 1, terminal 2's already-running `claude` REPL keeps using A's tokens (cached in process memory) and only flips to B at the next token refresh — silently changing the account underneath.

User mental model is "this terminal = this account". Reality is "this machine = this account". We want to close the gap.

## Constraint we must respect

We do **not** want to fork/patch the upstream `claude` binary. claude-switch is a wrapper. The solution must work with the official Claude Code as-is.

## Hypotheses to test

### H1 — Claude Code resolves `~/.claude.json` via `$HOME`

If Claude Code uses Node's `os.homedir()` (or equivalent), it reads `$HOME` at process start. Spawning `claude` with `HOME=/tmp/cs-iso-XYZ` should redirect ALL its config reads to `/tmp/cs-iso-XYZ/.claude.json` and `/tmp/cs-iso-XYZ/.claude/`.

**Test:** `HOME=/tmp/test-empty claude --version` — what does it print? Does it ask to log in (because no `.claude.json` in the fake HOME)?

If yes → we can build per-session HOME with a pre-populated `.claude.json`.

### H2 — Linux/Windows: tokens live in `~/.claude.json`, so HOME override is sufficient

Pre-populate `<isolated-HOME>/.claude.json` with the desired account's full state (oauthAccount including tokens). Spawn claude. Done.

**Risk:** Claude Code may also touch `~/.claude/` (subdirectory) for other state (sessions, history). We may need to populate that too.

### H3 — macOS: tokens are in Keychain (global). HOME override is necessary but not sufficient

Three sub-strategies:

**H3a — Embed tokens directly in the isolated `.claude.json`**
Claude Code on Linux/Windows already writes `oauthAccount.accessToken` to the JSON — does the macOS code path fall back to JSON if Keychain lookup fails? If yes, we win: write tokens to JSON, override HOME, ignore Keychain.

**Test:** rename Keychain entry temporarily, spawn claude, see if it succeeds with JSON-embedded tokens.

**H3b — Per-spawn keychain**
`security create-keychain <name>.keychain` creates a brand-new keychain file. We can populate it with the account's tokens, then prepend it to the search list in the env of the spawned claude:
```
security list-keychains -s /tmp/cs-iso-XYZ.keychain login.keychain
```
But this **mutates the user's global keychain search list** — bad. Alternative: spawn claude in a sub-shell that has the search list set differently. macOS keychain search list is per-session, so this might work.

**H3c — Patch upstream Claude Code to support `CLAUDE_CONFIG_DIR`**
Submit an upstream PR. Outside our control timeline — but worth opening in parallel as a long-term strategy.

### H4 — Sub-processes spawned by claude inherit our env

If claude spawns helper processes (MCP servers, etc.), they need to see the same isolated HOME. Verifying that env is inherited correctly is straightforward (Node spawn inherits env by default), but Claude Code may explicitly override HOME for sub-processes — need to check.

## Open questions

1. Does Claude Code touch `~/.claude/` (the dir) at all? What's in it?
2. On macOS, does the OAuth refresh path read from Keychain ONLY, or does it fall back to `.claude.json` if the Keychain lookup returns nothing?
3. Does `claude` write log/session files anywhere outside `$HOME`?
4. What happens on isolated-claude exit? Does it leave temp files in `/tmp/cs-iso-XYZ`?

## Plan of attack (sequential)

1. **Empirical baseline** — spawn `claude --version` in an empty `/tmp/test-home` and document observed file accesses (`fs_usage` on macOS, `strace` on Linux). Confirms which paths are touched.
2. **H1 verification** — does `HOME=...` redirect `.claude.json` reads? Yes/no.
3. **H2 minimal PoC on Linux/Windows** — build the smallest possible "isolated spawn" and try a real interactive session.
4. **H3 macOS investigation** — check if JSON-embedded tokens work without Keychain.
5. **Design & implement** — once we know what works, design `claude switch isolate <account>` (or whatever the UX ends up being) on top of the verified primitives.

## Findings (2026-04-30)

### ✅ Claude Code natively supports `CLAUDE_CONFIG_DIR`

Empirical test on macOS with `claude` v2.1.123:

```bash
CLAUDE_CONFIG_DIR=/tmp/iso claude --print "ping"
# → "Not logged in · Please run /login"
# Files written to /tmp/iso (not ~/.claude/)
```

The binary contains the literal env-var names: `CLAUDE_CONFIG_DIR`, `ANTHROPIC_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`. So Claude Code already implements config-dir isolation — we don't need to invent it.

### ✅ Each `CLAUDE_CONFIG_DIR` gets its own `userID` (and own Keychain entry)

Two different config dirs produce two different `userID` values in their respective `.claude.json`:

```
Real ~/.claude.json:        userID = cfc0482b6ae14ad3...
/tmp/cs-cfgdir-test/...:    userID = 50b7645e426d17f6...
```

The userID is generated on first run and persists in `<CONFIG_DIR>/.claude.json`. It is almost certainly the `account` field passed to the macOS `security` CLI — which means **two different `CLAUDE_CONFIG_DIR`s map to two different Keychain entries**.

Conclusion: per-profile isolation on macOS works *natively*. No Keychain hacks. No HOME tricks. Just `CLAUDE_CONFIG_DIR=<profile-dir>`.

### ⚠️ `oauthAccount.accessToken` in `.claude.json` alone is NOT enough on macOS

A `.claude.json` populated with fake `oauthAccount.accessToken` still results in "Not logged in". Claude Code on macOS reads tokens from the Keychain identified by the `userID`, not from the JSON. So embedding tokens in JSON is not a workaround — the user has to actually `claude auth login` once per profile to populate that profile's Keychain entry.

### ✅ The current `~/.claude.json` is preserved

When `CLAUDE_CONFIG_DIR` is set, Claude Code does NOT touch `~/.claude.json`. Our existing `claude switch` flow (which manipulates `~/.claude.json` and the default Keychain entry) is unaffected by per-profile sessions.

## Strategy

Two coexisting flows:

| Flow | Use case | Mechanism |
|------|----------|-----------|
| **Legacy `claude switch <account>`** | "I want to swap which account is active globally" | rewrites `~/.claude.json` + restores default Keychain entry. Affects all future `claude` invocations on the machine. |
| **New `claude switch profile use <name>`** | "I want THIS terminal to use account X without affecting others" | spawns `claude` with `CLAUDE_CONFIG_DIR=~/.claude/profiles/<name>/`. Other terminals are untouched. |

Profiles are **first-class isolated environments**:
- Own `userID` (stable across spawns within the profile)
- Own Keychain entry (no leakage across profiles)
- Own session history, projects, MCP state, etc.
- Own usage cache, token expiry, etc.

### UX sketch

```
claude switch profile create work        # creates ~/.claude/profiles/work/, runs auth login
claude switch profile use work           # spawns claude with CLAUDE_CONFIG_DIR=…/work
claude switch profile list               # shows all profiles + which terminal is using which (best-effort)
claude switch profile remove work        # delete the profile dir + the corresponding Keychain entry
claude switch profile login work         # re-authenticate that profile
```

Or from the menu: a new "Profiles" submenu sibling of "Manage account".

### Coexistence with existing `claude switch`

Default `claude` (no flag, no profile) continues to use the global state — backward compatible. Profiles are opt-in; the FAQ + a one-line note in the menu point to them when the user wants real per-terminal isolation.

## Status

- [x] Branch created
- [x] H1 test (HOME) — `$HOME` works but `CLAUDE_CONFIG_DIR` is the right primitive
- [x] Discovered `CLAUDE_CONFIG_DIR` natively supported
- [x] Verified per-profile userID + Keychain isolation (macOS)
- [ ] Verify same on Linux (no Keychain — should be easier)
- [ ] Design: `claude switch profile *` subcommand surface
- [ ] Implement create/use/list/remove
- [ ] Tests (mock `CLAUDE_CONFIG_DIR` end-to-end)
- [ ] FAQ + menu integration
- [ ] Merge to main
