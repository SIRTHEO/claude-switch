# claude-switch

Instant multi-account switching for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) - cross-platform.

Claude Code does not support multiple accounts. This wrapper lets you save
multiple accounts and switch between them instantly - no logout, no browser,
no re-authentication.

## Features

- **Instant switch** - swap accounts in milliseconds, no browser needed
- **Aliases** - `claude switch work` instead of typing full emails
- **Fuzzy match** - `claude switch pers` finds `personal@gmail.com`
- **Temporary switch** - `claude --as work "do something"` without changing the active account
- **Token health** - see if your token is valid, expired, or missing
- **Shell completions** - tab completion for bash, zsh, fish, PowerShell
- **Cross-platform** - macOS, Linux, Windows
- **Auto-detect** - active account is saved automatically on first run

## How it works

Claude Code stores the active account in `~/.claude.json`. Switching is a JSON
field swap - instant and offline. The browser is only needed once per account
during initial setup.

## Installation

```bash
npm install -g @sirtheo/claude-switch
```

Open a new terminal window. Done.

Verify:

```bash
claude switch --version
```

## Quick start

### 1. Your current account is saved automatically

Just run `claude` - if you are already logged in, the active account is detected
and saved:

```
Detected account: work@company.com (saved automatically)

* work@company.com
```

### 2. Add another account

```bash
claude switch add
```

This opens the browser for OAuth. After authorization, you are prompted for an alias:

```
Authenticated: personal@gmail.com
Saved: personal@gmail.com
Alias (press Enter to skip): personal
Alias set: personal -> personal@gmail.com
```

### 3. Switch

```bash
claude switch personal
```

Done.

## Usage

### Switch accounts

```bash
claude switch              # interactive menu
claude switch work         # by alias
claude switch personal@gmail.com  # by email
claude switch pers         # fuzzy match
```

### Temporary switch (--as)

Use a different account for a single command without changing the active account:

```bash
claude --as personal "review this code"
claude --as work
```

The original account is automatically restored when the command finishes. If the
process is interrupted, the account is restored on the next `claude` invocation.

### List accounts

```bash
claude switch list
```

```
Saved accounts:

  * work@company.com (active) [work, w]
    personal@gmail.com [personal]
```

### Account status

```bash
claude switch status
```

```
Active account: work@company.com
  Alias: work
  Token: valid (expires in 3 days)
```

### Aliases

```bash
claude switch alias work work@company.com    # set alias
claude switch alias w work@company.com       # multiple aliases per account
claude switch alias --list                   # list all
claude switch alias --remove w               # remove
```

### Manage accounts

```bash
claude switch add                   # add new account (opens browser)
claude switch remove old@email.com  # remove saved account
```

### Shell completions

```bash
# Bash
claude switch --completions bash >> ~/.bashrc

# Zsh
claude switch --completions zsh >> ~/.zshrc

# Fish
claude switch --completions fish > ~/.config/fish/completions/claude.fish

# PowerShell
claude switch --completions powershell >> $PROFILE
```

### Re-run setup

If you install a new shell or move to a new machine:

```bash
claude switch setup
```

## VS Code

claude-switch works with Claude Code in VS Code:

1. Switch in the integrated terminal: `claude switch work`
2. Restart your Claude Code session

Already-open sessions keep their original account.

## Good to know

- **Sessions are not affected.** Switching changes which account new sessions use.
- **Browser only once per account** - during `claude switch add`.
- **No logout.** Tokens stay valid. Switching is just a local config change.
- **Auto-save.** Active accounts are detected and saved automatically.

## Custom binary path

If the real `claude` binary cannot be found automatically:

```bash
export CLAUDE_SWITCH_BIN="/custom/path/to/claude"
```

Or re-run setup:

```bash
claude switch setup
```

## Requirements

- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

## Security

- Account profiles stored in `~/.claude/accounts/` with `600` permissions (owner-only)
- No data sent anywhere - everything stays local
- No logout performed - tokens are never invalidated

## License

MIT
