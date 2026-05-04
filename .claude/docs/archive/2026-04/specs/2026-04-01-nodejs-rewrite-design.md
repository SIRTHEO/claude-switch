# claude-switch: Node.js Rewrite Design Spec

## Overview

Rewrite claude-switch from a zsh script to a cross-platform Node.js CLI. The tool wraps the `claude` binary to add multi-account switching. Published via npm as `claude-switch` with bin name `claude`, so it acts as a transparent proxy.

## Goals

- Cross-platform: macOS, Linux, Windows
- Zero external dependencies (Node.js stdlib only)
- Drop Python3 dependency
- Publish on npm (`npm install -g claude-switch`)
- Maintain same UX: `claude switch`, `claude switch <email>`, passthrough for everything else
- Add: fuzzy match, shell completion, `switch status`, robust binary resolution

## Non-Goals

- Library/API for programmatic use
- GUI
- Token refresh/validation (out of scope — Claude Code handles this)
- Rust/Go rewrite (may come later)

## Architecture

### Package Structure

```
claude-switch/
├── package.json          # bin: { "claude": "./bin/cli.js" }
├── bin/
│   └── cli.js            # entry point, command parsing
├── src/
│   ├── accounts.js       # CRUD: save, load, list, remove, getCurrent
│   ├── switcher.js       # switch logic + interactive menu
│   ├── resolver.js       # find the real claude binary
│   ├── proxy.js          # exec passthrough to real binary
│   └── paths.js          # cross-platform path helpers
├── test/
│   ├── accounts.test.js
│   ├── resolver.test.js
│   ├── switcher.test.js
│   └── cli.test.js
├── LICENSE
└── README.md
```

### Flow

1. `cli.js` parses `process.argv`
2. If `claude switch ...` → handles internally via `accounts.js` / `switcher.js`
3. Everything else → `resolver.js` finds real claude, `proxy.js` does `spawnSync` with stdio inherit

## Binary Resolution

Three-tier strategy, in priority order:

### 1. Environment Variable

`CLAUDE_SWITCH_BIN` — explicit path to the real claude binary. Highest priority.

### 2. PATH Scan

Iterate over directories in `process.env.PATH` (split by `:` on Unix, `;` on Windows). For each directory:
- Look for `claude` (Unix) or `claude.cmd` / `claude.exe` (Windows)
- Check if executable exists (`fs.accessSync` with `fs.constants.X_OK`)
- Skip self: compare `fs.realpathSync(candidate)` with own `__filename`
- Skip other claude-switch wrappers: read first 5 lines, check for `claude-switch` marker
- Return first match

### 3. Known Paths Fallback

If PATH scan fails, check platform-specific common locations:

| Platform | Paths |
|----------|-------|
| macOS | `/usr/local/bin/claude`, `~/.npm-global/bin/claude` |
| Linux | `/usr/bin/claude`, `/usr/local/bin/claude`, `~/.local/bin/claude` |
| Windows | `%APPDATA%\npm\claude.cmd`, `%ProgramFiles%\nodejs\claude.cmd` |

Error with clear message if no binary found.

## Account Management

### Storage

- Account profiles: `~/.claude/accounts/<email>.json` (contains `oauthAccount` object)
- Active config: `~/.claude.json` (contains full Claude config with `oauthAccount` field)
- Permissions: `0o600` on Unix, skipped on Windows (NTFS ACL not managed)

### Paths (cross-platform)

```js
const home = os.homedir();
const claudeJson = path.join(home, '.claude.json');
const accountsDir = path.join(home, '.claude', 'accounts');
```

### Operations

**`getCurrent()`** — Read `.claude.json`, return `oauthAccount.emailAddress` or empty string.

**`save(email)`** — Extract `oauthAccount` from `.claude.json`, write to `accounts/<email>.json`. Create `accounts/` dir with `0o700` if needed. Set file permissions `0o600`.

**`load(email)`** — Read `accounts/<email>.json`, merge into `.claude.json` as `oauthAccount`. Atomic write: write to `.claude.json.tmp`, then `fs.renameSync` to `.claude.json`. Set `0o600`.

**`list()`** — Read `accounts/` directory, return array of emails. Mark current as active.

**`remove(email)`** — Delete `accounts/<email>.json`. Refuse if it's the active account.

## CLI Commands

| Command | Action |
|---------|--------|
| `claude switch` | Interactive menu (numbered list, readline prompt) |
| `claude switch <partial>` | Fuzzy match: if unique match, switch. If ambiguous, show options. |
| `claude switch add` | Add account via `claude auth login` with optional email verification |
| `claude switch list` | List saved accounts with active indicator |
| `claude switch remove <email>` | Remove account (not the active one) |
| `claude switch status` | Show active account email |
| `claude switch help` | Show help text |
| `claude [anything else]` | Passthrough: show active account banner, exec real claude |

### Fuzzy Match

For `claude switch <input>`:
1. Check exact match first
2. Filter accounts where email includes `<input>` (case-insensitive)
3. If 1 match → switch
4. If multiple → print matches and ask user to be more specific
5. If 0 → error with suggestion to run `claude switch list`

### Interactive Menu

Uses `readline` from Node.js stdlib. Shows numbered list, reads choice, validates. Same UX as current zsh version.

### Add Account Flow

1. Prompt for expected email (optional, readline)
2. Save current account if exists
3. Run `claude auth login` via the real binary (using `spawnSync` with stdio inherit)
4. Read new email from `.claude.json`
5. If login failed → restore previous account, error
6. Save new account, report status
7. If expected email set and doesn't match → offer retry (unlimited retries)

### Passthrough

For non-switch commands:
1. Auto-save current account on first run (if no accounts dir exists)
2. Print account banner: `🔑 email@example.com`
3. `spawnSync(realClaude, args, { stdio: 'inherit' })` with exit code forwarding

On Windows, use `spawn` with `shell: true` for `.cmd` files.

## Shell Completion

Generate completion scripts for:
- **bash** — `claude switch --completions bash`
- **zsh** — `claude switch --completions zsh`
- **fish** — `claude switch --completions fish`
- **PowerShell** — `claude switch --completions powershell`

Completions suggest: subcommands (`add`, `list`, `remove`, `status`, `help`) and saved account emails.

## Cross-Platform Details

| Aspect | macOS/Linux | Windows |
|--------|-------------|---------|
| npm bin shim | symlink | `.cmd` wrapper |
| File permissions | `chmod 0o600/0o700` | skipped |
| Proxy execution | `spawnSync` | `spawnSync` with `shell: true` for `.cmd` |
| PATH separator | `:` | `;` |
| Path building | `path.join` handles all | `path.join` handles all |
| Interactive input | `readline` | `readline` (works on cmd/PowerShell) |

## Testing

Node.js native test runner (`node:test`).

### Unit Tests
- `resolver.test.js` — PATH scan with mock directories, self-detection, fallback paths
- `accounts.test.js` — save/load/list/remove with temp directory, atomic write, permissions
- `switcher.test.js` — fuzzy match logic, interactive menu (mocked readline)
- `cli.test.js` — command parsing, routing

### Integration Tests
- Full flow with temporary `.claude.json` and accounts directory
- Add → list → switch → remove cycle
- Passthrough command execution

All tests use `os.tmpdir()` for isolation. No filesystem mocks.

## Distribution

- **Primary:** npm — `npm install -g claude-switch`
- **Secondary:** GitHub Releases with bundled script
- **README:** installation, setup, usage, troubleshooting

## Migration from Shell Script

Users upgrading from the zsh version:
- Account files in `~/.claude/accounts/` are 100% compatible (same JSON format)
- Remove old `~/bin/claude` symlink
- `npm install -g claude-switch`
- Done — existing accounts carry over seamlessly
