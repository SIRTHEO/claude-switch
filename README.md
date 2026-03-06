# claude-switch

Instant multi-account switching for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on macOS.

Claude Code doesn't support multiple accounts. This wrapper lets you save multiple accounts and switch between them **instantly** — no logout, no browser, no re-authentication.

## How it works

Claude Code determines the active account from the `oauthAccount` field in `~/.claude.json`. OAuth tokens in the macOS Keychain are shared across accounts. Switching is just a JSON field swap — instant and offline.

The **browser is only needed once per account**, during the initial setup (`claude switch add`). This is the standard Claude Code OAuth flow: browser opens, you enter your email, click the magic link from your inbox, and authorize. After that, the account profile is saved locally and switching never touches the browser again.

## Features

- **Instant switch** — swap accounts in under a second, no browser needed
- **Account indicator** — shows the active account every time you run `claude`
- **Works everywhere** — standalone script, works in terminals and VS Code
- **One-time setup** — log in via browser once per account, then never again
- **No logout** — tokens are never invalidated, accounts stay ready

## Installation

1. **Clone the repo:**

   ```bash
   git clone https://github.com/SIRTHEO/claude-switch.git ~/.claude-switch
   ```

2. **Run the installer:**

   ```bash
   ~/.claude-switch/install.sh
   ```

   This creates a symlink at `~/bin/claude` pointing to the wrapper script.

3. **Ensure `~/bin` comes before the real claude binary in your PATH.** Add to `.zshrc`:

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   export PATH="$HOME/bin:$PATH"
   ```

   The last `export` wins, so `~/bin` ends up first in the PATH.

4. **Reload your shell:**

   ```bash
   source ~/.zshrc
   ```

## Initial setup

The browser is needed **only during this initial setup** — once per account.

### 1. Save your current account

If you're already logged in to Claude Code, save it:

```bash
claude switch add
```

This saves the currently active account without requiring a new login.

### 2. Add a second account

Run `claude switch add` again. This time it will open the browser for the OAuth flow:

1. Browser opens with the Claude login page
2. Enter the email for the new account
3. Check your inbox and click the magic link
4. Click "Authorize" in the browser
5. The terminal shows "Login successful"

The account is now saved. **You won't need the browser for this account again.**

Repeat for as many accounts as you need.

## Usage

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

Or switch directly by email:

```bash
claude switch personal@gmail.com
```

### List accounts

```bash
claude switch list
```

```
Saved accounts:

  * work@company.com (active)
    personal@gmail.com
```

### Check active account

```bash
claude auth status
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

## Good to know

- **Already-open sessions are not affected.** Switching changes which account new sessions use. Sessions that were already running keep their original account.
- **The browser is only needed once per account**, during `claude switch add`. After that, switching is instant and fully offline.
- **No logout is ever performed.** Tokens stay valid. Switching is just a local config change.

## Custom binary path

If your claude binary is not in the default location:

```bash
export CLAUDE_SWITCH_BIN="/custom/path/to/claude"
```

## Requirements

- macOS
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Zsh shell
- Python 3 (for JSON parsing)

## Security

- Account profiles are stored in `~/.claude/accounts/` with `600` permissions (owner-only)
- No data is sent anywhere — everything stays local
- No `logout` is performed — tokens are never invalidated

## License

MIT
