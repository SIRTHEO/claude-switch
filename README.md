# claude-switch

Instant multi-account switching for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on macOS.

Claude Code doesn't support multiple accounts. This wrapper lets you save multiple accounts and switch between them **instantly** — no logout, no browser, no re-authentication.

## How it works

Claude Code stores OAuth tokens in the macOS Keychain. This wrapper:

1. **Saves** each account's tokens to `~/.claude/accounts/<email>.json`
2. **Swaps** tokens in the Keychain when you switch
3. Never calls `logout` — tokens stay valid

## Features

- **Instant switch** — swap accounts in under a second, no browser needed
- **Account indicator** — shows the active account every time you run `claude`
- **Works everywhere** — standalone script, works in terminals and VS Code
- **One-time setup** — log in via browser once per account, then never again

## Installation

1. **Clone the repo:**

   ```bash
   git clone https://github.com/SIRTHEO/claude-switch.git ~/.claude-switch
   ```

2. **Run the installer:**

   ```bash
   ~/.claude-switch/install.sh
   ```

3. **Ensure `~/bin` comes before the real claude binary in your PATH.** Add to `.zshrc`:

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   export PATH="$HOME/bin:$PATH"
   ```

4. **Reload your shell:**

   ```bash
   source ~/.zshrc
   ```

## Usage

### Add accounts

Add your first account (saves the currently logged-in account):

```bash
claude switch add
```

This opens the browser for login. Do this once per account.

### Switch account

Interactive menu:

```bash
claude switch
```

```
Accounts:

  1) work@company.com (active)
  2) personal@gmail.com

Switch to [1-2]: 2
Switched to personal@gmail.com
```

Or switch directly:

```bash
claude switch personal@gmail.com
```

### List accounts

```bash
claude switch list
```

### Remove an account

```bash
claude switch remove old@email.com
```

### Normal usage

```bash
claude
```

Shows the active account before starting:

```
🔑 work@company.com

╭──────────────────────────────────────╮
│ ✻ Welcome to Claude Code!            │
│ ...                                  │
╰──────────────────────────────────────╯
```

### Native commands (passthrough)

```bash
claude auth status
claude --help
claude --version
```

## Custom binary path

If your claude binary is not in the default location:

```bash
export CLAUDE_SWITCH_BIN="/custom/path/to/claude"
```

## Requirements

- macOS (uses Keychain for token storage)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Zsh shell
- Python 3 (for JSON parsing)

## Security

- Account tokens are stored in `~/.claude/accounts/` with `600` permissions (owner-only)
- No tokens are ever sent anywhere — everything stays local
- No `logout` is performed — tokens are never invalidated

## License

MIT
