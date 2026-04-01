# claude-switch

Instant multi-account switching for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — cross-platform.

Claude Code doesn't support multiple accounts. This tool lets you save multiple accounts and switch between them **instantly** — no logout, no browser, no re-authentication.

## How it works

Claude Code determines the active account from the `oauthAccount` field in `~/.claude.json`. OAuth tokens are shared across accounts. Switching is just a JSON field swap — instant and offline.

The **browser is only needed once per account**, during the initial setup (`claude switch add`). This is the standard Claude Code OAuth flow: browser opens, you log in, and authorize. After that, the account profile is saved locally and switching never touches the browser again.

## Installation

```bash
npm install -g claude-switch
```

Verify the installation:

```bash
claude switch help
```

## Migration from shell script

Account files are fully compatible with the previous shell script version. To migrate:

1. Remove the old symlink created by `install.sh` (usually `~/bin/claude`)
2. Run `npm install -g claude-switch`

Your saved accounts in `~/.claude/accounts/` are preserved and ready to use.

## Setup

The browser is needed **only during this initial setup** — once per account.

### Save your current account

If you're already logged in to Claude Code, save it:

```bash
claude switch add
```

When prompted for an email, enter the email of your current account (or press Enter to skip). This saves the currently active account without requiring a new login.

### Add more accounts

Run `claude switch add` again and enter the email of the new account. This opens the browser for the OAuth flow. After authorization, the account is saved and you can switch to it instantly at any time.

Repeat for as many accounts as you need.

## Usage

### Interactive menu

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

### Fuzzy match by name or email

```bash
claude switch personal
```

### List saved accounts

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
claude switch status
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

## Shell completions

Enable tab completion for your shell:

**Bash:**
```bash
claude switch completions bash >> ~/.bashrc
```

**Zsh:**
```bash
claude switch completions zsh >> ~/.zshrc
```

**Fish:**
```bash
claude switch completions fish > ~/.config/fish/completions/claude-switch.fish
```

**PowerShell:**
```powershell
claude switch completions powershell >> $PROFILE
```

## Good to know

- **Already-open sessions are not affected.** Switching changes which account new sessions use. Sessions already running keep their original account.
- **The browser is only needed once per account**, during `claude switch add`. After that, switching is instant and fully offline.
- **No logout is ever performed.** Tokens stay valid. Switching is just a local config change.
- **Cross-platform.** Works on macOS, Linux, and Windows.

## Custom binary path

If your `claude` binary is not in the default location:

```bash
export CLAUDE_SWITCH_BIN="/custom/path/to/claude"
```

## Requirements

- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed

## Security

- Account profiles are stored in `~/.claude/accounts/` with `600` permissions (owner-only)
- No data is sent anywhere — everything stays local
- No `logout` is performed — tokens are never invalidated

## License

MIT
