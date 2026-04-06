# claude-switch

[![npm version](https://img.shields.io/npm/v/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![npm downloads](https://img.shields.io/npm/dm/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js CI](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/@sirtheo/claude-switch)](package.json)

Switch between multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) accounts instantly — no logout, no browser, no waiting.

---

## What's new in v2.2.0

**Important fix — accounts were using the wrong API tokens on macOS.**

Claude Code stores OAuth tokens in the macOS Keychain, not in `~/.claude.json`. Previous versions of claude-switch only swapped the account metadata in that file, leaving the Keychain untouched. The result: after switching, the Claude CLI showed the right account name but silently made API calls using a different account's tokens.

v2.2.0 fixes this by saving and restoring Keychain tokens alongside account metadata.

**What changed:**
- Account switching now correctly swaps the tokens in the macOS Keychain
- `claude switch status` shows real token expiry (previously always showed "missing")
- `claude --as` restores the original account correctly even on Ctrl+C
- New command: `claude switch update` — check for updates and install with one keystroke
- When a new version is available, claude-switch prompts you to update inline

**If you are upgrading from an older version:**
1. Run `claude switch status` — this automatically updates your active account file
2. Run `claude switch add` for each of your other accounts — this re-authenticates and captures their tokens

---

## The problem it solves

Claude Code only supports one account at a time. If you use it for work _and_ personal projects, switching means logging out, opening a browser, and logging back in — every time.

**claude-switch** saves all your accounts and lets you switch between them in under a second, entirely from the terminal.

---

## How it works

Claude Code authenticates via OAuth. The active account identity is stored in `~/.claude.json`, and the actual tokens (access token, refresh token) are stored in the macOS Keychain. Switching accounts means updating both.

claude-switch handles this for you — instantly, with no network requests. The browser is only needed **once per account**, when you first add it.

---

## Requirements

- **Node.js** version 18 or newer — check with `node --version`
- **Claude Code** CLI — install from the [official docs](https://docs.anthropic.com/en/docs/claude-code)

---

## Installation

### Step 1 — Install the package

```bash
npm install -g @sirtheo/claude-switch
```

### Step 2 — Run setup

```bash
claude switch setup
```

This tells claude-switch where the real `claude` binary is on your machine, and optionally adds it to your shell's PATH if needed.

### Step 3 — Open a new terminal

Close your current terminal window and open a fresh one. This is required so your shell picks up the new `claude` wrapper.

### Step 4 — Verify it works

```bash
claude switch --version
```

You should see something like `claude-switch 2.2.0`. If you do, you're all set.

> **What changed?** claude-switch places a thin wrapper in front of the `claude` command. Your original Claude Code installation is untouched — the wrapper just intercepts the command, shows which account is active, and then calls the real binary.

---

## Getting started

### Your first account is saved automatically

Just run `claude` as you normally would. If you are already logged in to Claude Code, claude-switch detects your current account and saves it:

```
Detected account: work@company.com (saved automatically)

🔑 work@company.com
```

No extra steps needed.

### Add a second account

```bash
claude switch add
```

This opens your browser for sign-in. After you authenticate, you will be asked if you want to set a short alias:

```
Authenticated: personal@gmail.com
Saved: personal@gmail.com
Alias (press Enter to skip): personal
Alias set: personal → personal@gmail.com
```

An alias is just a nickname — instead of typing the full email, you can type `personal`.

### Switch between accounts

```bash
claude switch personal
```

That's it. The switch is instant. Run `claude` again and you'll see the new account is active.

---

## All commands

### Switch to an account

```bash
claude switch                        # opens an interactive menu to pick an account
claude switch personal               # switch by alias
claude switch personal@gmail.com     # switch by full email
claude switch pers                   # fuzzy match — finds "personal@gmail.com"
```

### List your accounts

```bash
claude switch list
```

Output:

```
Saved accounts:

  * work@company.com (active) [work, w]
    personal@gmail.com [personal]
```

The `*` shows the currently active account. Names in brackets `[...]` are aliases.

### Check account status

```bash
claude switch status
```

Output:

```
Active account: work@company.com
  Alias: work
  Token: valid (expires in 3 days)
```

This also tells you if your token has expired and you need to log in again.

### Add or remove accounts

```bash
claude switch add                      # add a new account (opens browser)
claude switch remove old@email.com     # remove a saved account
```

> You cannot remove the currently active account. Switch to another account first.

### Aliases

Aliases are short nicknames for your accounts. You can have multiple aliases per account.

```bash
claude switch alias work work@company.com    # create alias "work" for that email
claude switch alias w    work@company.com    # create another alias "w" for the same email
claude switch alias --list                   # show all aliases
claude switch alias --remove w               # delete alias "w"
```

### Use a different account for just one command

```bash
claude --as personal "review this code"
```

This temporarily switches to `personal`, runs the command, then automatically restores your original account when done. The active account never changes permanently.

If the command is interrupted (Ctrl+C or a crash), the original account is restored automatically on the next `claude` invocation.

### Update claude-switch

```bash
claude switch update
```

Checks the npm registry for a newer version and offers to install it:

```
Current version: 2.2.0
Checking for updates...
New version available: 2.2.0 → 2.3.0
Update now? [y/N]
```

You can also let claude-switch notify you automatically — if a new version is available, it will prompt you the next time you run any `claude switch` command.

### Setup

```bash
claude switch setup
```

Finds the real `claude` binary and saves its location. Run this if:
- you installed claude-switch on a new machine
- you moved or reinstalled Claude Code
- `claude` stops working after a system update

### Shell completions (tab to autocomplete)

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

After adding completions, open a new terminal. Then press Tab after `claude switch` to see available commands and account names.

---

## Using claude-switch with VS Code

claude-switch works with the Claude Code extension in VS Code. To switch accounts:

1. Open the integrated terminal in VS Code
2. Run `claude switch work` (or whatever account you want)
3. Restart the Claude Code session in VS Code

Sessions that are already open keep their original account until restarted.

---

## Troubleshooting

### `claude` command not found after installing

Run setup, then open a **new** terminal window:

```bash
claude switch setup
# then close and reopen your terminal
```

### claude-switch can't find the real `claude` binary

Set the path manually using an environment variable:

```bash
export CLAUDE_SWITCH_BIN="/path/to/the/real/claude"
```

You can find the path with `which claude` (before installing claude-switch) or by looking in your npm global bin directory.

### After upgrading to v2.2.0, a second account shows a token warning

Run `claude switch add` for that account to re-authenticate and capture its tokens. You only need to do this once.

### Something else is wrong

Check your setup:

```bash
claude switch status      # is an account active?
claude switch list        # are accounts saved?
claude switch --version   # is the wrapper running?
```

If you are still stuck, [open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) and include:
- Your OS and Node.js version (`node --version`)
- The output of `claude switch --version`
- What you ran and what happened

---

## Good to know

- **Switching is local and offline.** No network request is made when you switch. It's just a file operation.
- **Your tokens are never invalidated.** Switching does not log you out. All accounts stay authenticated.
- **The browser is only needed once** per account — during `claude switch add`.
- **Accounts are saved per machine.** You need to run `claude switch add` on each machine you use.

---

## Security

- Account credentials (including OAuth tokens) are stored in `~/.claude/accounts/` with permissions `600` (only readable by you)
- On macOS, tokens are also saved in and restored from the login Keychain
- No data is sent anywhere — everything stays on your machine
- No install scripts run automatically — setup requires you to explicitly run `claude switch setup`

---

## Contributing

Contributions are welcome. For significant changes, please [open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) first to discuss the approach.

When reporting a bug, include:
- Your OS and Node.js version (`node --version`)
- The output of `claude switch --version`
- Steps to reproduce the problem
- What you expected vs what happened

---

## License

MIT
