# claude-switch v2.1: Feature Improvements Design Spec

## Overview

Add three quality-of-life features for individual developers who use claude-switch daily with 2-3 accounts.

## Goals

- Faster switching via account aliases (nicknames)
- Better visibility on token health via enhanced `switch status`
- One-shot account usage via `--as` flag without persistent switch
- Updated README with VS Code usage guidance

## Non-Goals

- VS Code extension (future project)
- Team/enterprise features
- Token refresh (Claude Code handles this)
- Network-based token validation

## Feature 1: Account Aliases

### Storage

New file: `~/.claude/accounts/aliases.json`

```json
{
  "work": "work@company.com",
  "personal": "personal@gmail.com",
  "w": "work@company.com"
}
```

File created on first alias assignment. Permissions `0o600` on Unix.

### Commands

- `claude switch alias <name> <email>` — create/update alias
- `claude switch alias --list` — show all aliases
- `claude switch alias --remove <name>` — remove alias
- `claude switch add` — after login, prompts: `Alias (press Enter to skip):`

### Resolution Order

When user runs `claude switch <input>`:
1. Check alias exact match → resolve to email
2. Check email exact match
3. Fuzzy match on emails

### Module Changes

New file: `src/aliases.ts` — CRUD for aliases (getAlias, setAlias, listAliases, removeAlias, resolveAlias)

Modify: `src/switcher.ts` — `addAccount()` prompts for alias after save
Modify: `bin/cli.ts` — add `alias` subcommand, integrate alias resolution into `switch-to`

### Display

`claude switch list` shows aliases next to emails:
```
Saved accounts:

  * work@company.com (active) [work, w]
    personal@gmail.com [personal]
```

`claude switch status` shows alias if set.

## Feature 2: Token Health Check

### Enhanced `switch status`

Read `oauthAccount` from `.claude.json` and display token health.

**Fields checked:**
- `oauthAccount.emailAddress` — display
- `oauthAccount.accessToken` — presence check
- `oauthAccount.expiresAt` — if present, parse as ISO date or epoch ms, compare to now

**Output formats:**

Token valid with known expiry:
```
Active account: work@company.com
  Alias: work
  Token: valid (expires in 3 days)
```

Token expired:
```
Active account: work@company.com
  Token: expired (2 days ago) — run: claude switch add
```

No expiry info:
```
Active account: work@company.com
  Token: present
```

No token:
```
Active account: work@company.com
  Token: missing — run: claude switch add
```

No account:
```
No account connected. Run: claude switch add
```

### Module Changes

New file: `src/token.ts` — `getTokenHealth(claudeJsonPath): TokenHealth`

Returns:
```ts
interface TokenHealth {
  status: 'valid' | 'expired' | 'present' | 'missing';
  expiresAt?: Date;
  expiresIn?: string; // human-readable "in 3 days" / "2 days ago"
}
```

Time formatting: relative time without dependencies. Simple logic: < 1h = "in X minutes", < 24h = "in X hours", else "in X days". Past tense for expired.

Modify: `bin/cli.ts` — `status` case uses `getTokenHealth` + alias info

## Feature 3: `--as` Temporary Switch

### Syntax

```bash
claude --as <alias-or-email> [claude args...]
```

### Flow

1. CLI detects `--as` in args (before passthrough)
2. Resolve `<alias-or-email>` via alias → exact → fuzzy
3. If ambiguous or not found, error and exit
4. Save current email to `~/.claude/accounts/.pending-restore` (atomic write)
5. Load target account into `.claude.json`
6. Execute real `claude` with remaining args (everything after `--as <value>`)
7. On exit (regardless of exit code), restore original account
8. Delete `.pending-restore`

### Crash Recovery

On any `claude` invocation (passthrough path), check for `.pending-restore`:
- If exists, read the email from it
- Restore that account
- Delete the file
- Print: `Restored account: <email> (from interrupted --as)`

This handles cases where the process was killed before restoration.

### Module Changes

Modify: `bin/cli.ts` — detect `--as` in parseCommand, add `temporary-switch` action
New function in `src/switcher.ts`: `temporarySwitch(target, claudeBin, claudeJsonPath, accountsDirPath, args)`
Modify: passthrough path — check `.pending-restore` before executing

### Edge Cases

- `--as` with no value → error: `Usage: claude --as <account> [args...]`
- `--as` with ambiguous match → error with suggestions
- `--as` with the already-active account → skip swap, just execute
- Nested `--as` calls → `.pending-restore` already exists → warn and proceed (restore the original, not the intermediate)

## Feature 4: README Updates

Add VS Code section:
- Switch works for new sessions (terminal: `claude switch work`)
- Already-open sessions keep their original account
- To change: switch in terminal, then restart Claude Code session in VS Code

## Testing Strategy

- `src/aliases.ts` — unit tests for CRUD, resolution order
- `src/token.ts` — unit tests for each token status, relative time formatting
- `--as` flow — integration test with tmpdir (save/restore cycle)
- Crash recovery — integration test (create `.pending-restore`, verify auto-restore)
- Existing 62 tests must continue to pass
