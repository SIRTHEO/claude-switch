# claude-switch

A lightweight Zsh wrapper for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that adds seamless account switching.

Claude Code doesn't have a built-in way to switch between accounts (e.g., personal and work). This wrapper adds a simple `claude switch` command that handles logout, re-login, and account verification in one step.

## Features

- **`claude switch`** — Log out of the current account and log in to a different one, all in a single command
- **Account indicator** — Every time you run `claude`, it shows which account is active before starting the session
- **No-account warning** — If no account is connected, it reminds you to run `claude switch` instead of failing silently
- **Transparent passthrough** — Native commands like `claude auth`, `claude --help`, and `claude --version` work exactly as expected

## Installation

1. **Clone the repo:**

   ```bash
   git clone https://github.com/SIRTHEO/claude-switch.git ~/.claude-switch
   ```

2. **Source it from your `.zshrc`:**

   ```bash
   echo 'source "$HOME/.claude-switch/claude-switch.zsh"' >> ~/.zshrc
   ```

3. **Reload your shell:**

   ```bash
   source ~/.zshrc
   ```

## Usage

### Switch account

```bash
claude switch
```

This will:
1. Log out of the current Claude account
2. Open the browser for you to log in with a different account
3. Verify the login and display the active email

### Normal usage

```bash
claude
```

Before starting the interactive session, it displays the active account:

```
🔑 you@example.com

╭──────────────────────────────────────╮
│ ✻ Welcome to Claude Code!            │
│ ...                                  │
╰──────────────────────────────────────╯
```

### Native commands (passthrough)

These are passed directly to Claude Code without any wrapping:

```bash
claude auth status
claude --help
claude --version
```

## How it works

The script defines a `claude()` Zsh function that intercepts calls to `claude`. It uses `command claude` internally to call the real binary, avoiding infinite recursion.

The account detection relies on `claude auth status`, which outputs JSON containing the logged-in email. The wrapper parses this to display the active account.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Zsh shell

## License

MIT
