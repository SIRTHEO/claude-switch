# claude-switch

[![npm version](https://img.shields.io/npm/v/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![npm downloads](https://img.shields.io/npm/dm/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js CI](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/@sirtheo/claude-switch)](package.json)

Switch between multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) accounts instantly — no logout, no browser, no waiting.

---

## What's new in v2.4.0

**Smart auto-revert, in-menu re-auth, manage any account, alt-screen menu.**

### Auto-revert to OAuth (smart-switch)

When you flip fallback ON because you hit the 5h subscription limit, you usually forget to flip it back when the window resets. claude-switch can now do it for you:

```bash
claude switch fallback auto on                  # default threshold: 80%
claude switch fallback auto on --threshold 70   # custom threshold
```

When fallback is on AND both 5-hour and 7-day usage drop below the threshold, the next `claude` run prints `📈 Subscription back online — switched back to OAuth` and runs on your subscription instead of API credits. Strictly opt-in. Decision uses the cached usage, so no extra network call in the hot path. See [Smart-switch](#smart-switch-auto-off-when-the-subscription-comes-back) below.

### Manage any account from the menu

`claude switch` → **Manage account…** lets you edit API key, aliases, or remove any saved account — active or not, no need to switch first. Replaces what previously required dropping to shell commands or switching just to change a key.

### Re-authenticate without leaving the menu

When the OAuth token for the active account expires, the menu now offers a top-priority **Re-authenticate (token expired)** entry that runs the browser flow inline and refreshes Keychain tokens — no need to know that "Add account" was the recovery path. Detects mid-flow account changes and incomplete logins, so you don't get a misleading "Tokens refreshed" confirmation.

### Auto-launch after switch

Picking a new account from `claude switch` now exits the menu and hands stdio to a fresh `claude` invocation automatically. Switching to use an account, immediately followed by needing to type `claude` again, was friction that no longer exists.

### Alt-screen menu (no more scrollback noise)

The interactive menu now opens in the terminal's alternate screen buffer (like `vim`, `htop`, `lazygit`). Each iteration redraws in place instead of accumulating panels in your scrollback; on exit the terminal looks exactly as it did before you opened the menu. Falls back gracefully on non-TTY (CI / piped output).

---

## What's new in v2.3.0

**Interactive TUI, subscription usage monitoring, and shell statusline.**

### Interactive menu

Running `claude switch` with no arguments now opens a persistent menu instead of a numbered list:

```
◆ Status ────────────────────────────────
│ Account    work@company.com
│ Auth mode  OAuth subscription
│ Token      valid (expires in 3 days)
│ Usage      5h 42%  7d 18%
└────────────────────────────────────────

◆ What would you like to do?
● Switch account
○ Turn fallback ON (use API key)
○ Set API key
○ Refresh usage
○ Advanced…
○ Exit
```

All actions — switching, adding/removing accounts, setting an API key, toggling fallback — are accessible from the menu. After each action the menu reappears, so you can do multiple things without re-running the command.

### Subscription usage monitoring

claude-switch can now read your Max/Pro subscription quota from Anthropic's API:

```bash
claude switch usage           # show 5-hour and 7-day utilisation %
claude switch usage --force   # force a fresh fetch
```

Usage is shown in the interactive menu and in the shell statusline (see below). The data is cached for 15 minutes to respect Anthropic's rate limits; a background refresh keeps it near-live while Claude Code is running.

### Shell statusline (`claude switch statusline`)

Add a live account badge to your shell prompt or [ccstatusline](https://github.com/simonw/ccstatusline):

```
🔑 work OAuth  5h:42%
```

Colors: account name in cyan, `OAuth` in green, `API` in yellow, usage in red when ≥ 90%.

Integration options:

**ccstatusline** (recommended — shown inside Claude Code's status bar):

```json
// ~/.claude/settings.json
"statusLine": {
  "type": "command",
  "command": "bash -c 'INPUT=$(cat); claude switch sl; echo \"$INPUT\" | npx -y ccstatusline@latest'"
}
```

**Starship:**

```toml
# ~/.config/starship.toml
[custom.claude]
command = "claude switch sl --no-color"
when = "true"
```

**Plain shell prompt (bash/zsh):**

```bash
PS1='$(claude switch sl --no-color) \$ '
```

Available flags:

```bash
claude switch statusline            # compact: alias + mode + usage
claude switch statusline --full     # full: email + mode + usage
claude switch statusline --json     # machine-readable JSON
claude switch statusline --no-color # no ANSI codes
claude switch sl                    # alias for statusline
```

### Per-account API key + fallback toggle (with smart-switch)

Claude Code has no built-in fallback from a Max/Pro subscription to an API key when you hit the rate limit. claude-switch gives you a manual toggle, plus an opt-in smart-switch that flips it back automatically:

- `claude switch apikey set <account>` — save an Anthropic API key for an account (input hidden)
- `claude switch fallback on` — inject the saved key as `ANTHROPIC_API_KEY` on every `claude` invocation (billed against API credits)
- `claude switch fallback off` — back to OAuth subscription
- `claude switch fallback auto on` — **smart-switch**: when fallback is on, automatically flip it back OFF the next time you run `claude` if both 5h and 7d subscription usage drop below a configurable threshold
- Each account keeps its own key, so switching accounts also switches which key is active

See [API key fallback](#api-key-fallback-when-your-max-plan-hits-its-limit) and [Smart-switch](#smart-switch-auto-off-when-the-subscription-comes-back) below.

---

## What's new in v2.2.0

**Important fix — accounts were using the wrong API tokens on macOS.**

Claude Code stores OAuth tokens in the macOS Keychain, not in `~/.claude.json`. Previous versions of claude-switch only swapped the account metadata in that file, leaving the Keychain untouched. The result: after switching, the Claude CLI showed the right account name but silently made API calls using a different account's tokens.

v2.2.0 fixes this by saving and restoring Keychain tokens alongside account metadata.

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

You should see something like `claude-switch 2.4.0`. If you do, you're all set.

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
✔ Add a new claude account
◆ Email of the account you are about to add
│  work@company.com
│
◇ A browser window will open shortly.
│  Sign in with the new account, then come back to this terminal.
│
✔ Saved: work@company.com
◆ Optional alias (a short nickname you can type instead of the email)
│  work
└─ Done
   Email: work@company.com
   Alias: work
```

An alias is just a nickname — instead of typing the full email, you can type `work`.

### Switch between accounts

```bash
claude switch work
```

That's it. The switch is instant. Run `claude` again and you'll see the new account is active.

Or open the interactive menu for a full overview:

```bash
claude switch
```

---

## All commands

### Interactive menu

```bash
claude switch
```

Opens a persistent TUI menu showing your current account, auth mode, token expiry, and usage percentage. All common actions are available from the menu:

- **Switch account** — pick from your saved accounts
- **Turn fallback ON/OFF** — toggle between OAuth and API key billing
- **Set API key** — save an Anthropic key for the active account
- **Refresh usage** — force-fetch subscription quota
- **Advanced…** — add account, remove account, re-run setup wizard

### Switch to an account

```bash
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
  API key: sk-ant-api03…WXYZ
  Fallback: off
```

### Add or remove accounts

```bash
claude switch add                      # add a new account (opens browser, guided TUI)
claude switch remove old@email.com     # remove a saved account
```

> You cannot remove the currently active account. Switch to another account first.

### Subscription usage

```bash
claude switch usage           # show cached 5-hour and 7-day utilisation %
claude switch usage --force   # force a fresh fetch from Anthropic's API
```

Output:

```
Subscription usage (fetched just now):
  5-hour:  42.0%
  7-day:   18.3%
    Opus:  12.1%
    Sonnet: 6.2%
```

Usage is automatically cached for 15 minutes. When the cache is stale, a background process refreshes it so the statusline always shows near-live numbers.

### Shell statusline

```bash
claude switch statusline        # compact: alias/local-part + auth mode + usage
claude switch statusline --full # full email instead of alias
claude switch statusline --json # machine-readable JSON
claude switch sl                # shorthand alias
```

Example output (compact):
```
🔑 work OAuth  5h:42%
```

When usage reaches 75% the badge turns yellow; at 90% it turns red.

JSON output format:
```json
{
  "email": "work@company.com",
  "shortName": "work",
  "mode": "oauth",
  "fallback": false,
  "hasApiKey": true,
  "fiveHour": 42.0,
  "sevenDay": 18.3
}
```

### Aliases

Aliases are short nicknames for your accounts. You can have multiple aliases per account.

```bash
claude switch alias work work@company.com    # create alias "work" for that email
claude switch alias w    work@company.com    # create another alias "w" for the same email
claude switch alias --list                   # show all aliases
claude switch alias --remove w               # delete alias "w"
```

### API key fallback (when your Max plan hits its limit)

Claude Code does not switch from your subscription to an API key automatically when you hit the Max plan rate limit ([feature request open since 2024](https://github.com/anthropics/claude-code/issues/2944)). claude-switch gives you a manual toggle that does the next-best thing:

1. Save an Anthropic API key for any account:

   ```bash
   claude switch apikey set work
   # paste sk-ant-… (input is hidden)
   ```

   Or use the interactive menu: `claude switch` → **Set API key**.

2. When you hit the limit, turn fallback on:

   ```bash
   claude switch fallback on
   ```

   From now on, every `claude` invocation runs with `ANTHROPIC_API_KEY` set to the saved key for the active account — Claude Code uses your API credits instead of the subscription.

   > **First-time approval:** the first time Claude Code sees a new API key it will ask:
   > ```
   > Use this API key? [y/N]
   > ```
   > Press **y** to approve. This choice is remembered. If you miss the prompt or press N, claude silently keeps using OAuth and the fallback looks broken — watch for it on the first launch.

3. When the subscription quota refreshes, turn it back off:

   ```bash
   claude switch fallback off
   ```

   Or let claude-switch do it for you — see [Smart-switch](#smart-switch-auto-off-when-the-subscription-comes-back) below.

Each account keeps its own key, so switching accounts also switches which key is used.

Other commands:

```bash
claude switch apikey show work        # show the saved key, masked
claude switch apikey remove work      # delete the saved key
claude switch fallback                # show fallback state + whether the active account has a key
```

The key is stored in `~/.claude/accounts/<email>.json` (perms `600`) — same place and same protection as the OAuth tokens.

#### Smart-switch (auto-OFF when the subscription comes back)

Forgot to flip fallback back to OAuth after your 5-hour quota reset? Smart-switch does it for you:

```bash
claude switch fallback auto on                  # default threshold: 80%
claude switch fallback auto on --threshold 70   # custom threshold
claude switch fallback auto status              # show current setting
claude switch fallback auto off                 # disable
```

When smart-switch is on AND fallback is currently on AND the cached usage shows both 5-hour and 7-day utilisation strictly below the threshold, the next `claude` invocation prints:

```
📈 Subscription back online (5h:30%, 7d:15%, threshold 80%) — switched back to OAuth
🔑 work@company.com
```

…and runs Claude Code on your subscription instead of API credits. No network calls in the hot path — the decision uses the cached usage that the statusline already keeps fresh.

Strictly opt-in (default OFF). Both 5h and 7d windows are checked so you don't bounce back to OAuth only to hit the weekly cap a few minutes later.

Toggle from the menu too: `claude switch` → **Enable smart-switch**.

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
Current version: 2.4.0
Checking for updates...
New version available: 2.4.0 → 2.5.0
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

## Integrating the statusline

### Inside Claude Code (ccstatusline)

Add this to `~/.claude/settings.json` to show the account badge in Claude Code's bottom status bar:

```json
"statusLine": {
  "type": "command",
  "command": "bash -c 'INPUT=$(cat); claude switch sl; echo \"$INPUT\" | npx -y ccstatusline@latest'"
}
```

This runs claude-switch first (outputting the account badge), then pipes the original Claude Code context to ccstatusline.

### Starship prompt

```toml
# ~/.config/starship.toml
[custom.claude]
command = "claude switch sl --no-color"
when = "true"
symbol = ""
```

### Bash / Zsh prompt

```bash
# Add to ~/.bashrc or ~/.zshrc
PS1='$(claude switch sl --no-color) \$ '
```

### Oh My Zsh

Create `~/.oh-my-zsh/custom/themes/claude.zsh-theme`:

```zsh
PROMPT='$(claude switch sl --no-color) %~ $ '
```

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

### `claude switch usage` shows nothing or an error

Usage monitoring requires a **Max or Pro** Claude subscription (OAuth login). It is not available for API-key-only accounts. If you are rate-limited, wait a few minutes before retrying — Anthropic's usage endpoint enforces aggressive limits.

### Fallback is on but claude still uses OAuth

The first time Claude Code sees a new `ANTHROPIC_API_KEY` it asks for approval:
```
Use this API key? [y/N]
```
If you missed this prompt or pressed N, run `claude` once interactively and watch for the prompt.

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
- **Usage data is cached.** Fetches are rate-limited by Anthropic; claude-switch caches responses for 15 minutes and refreshes in the background.

---

## Security

- Account credentials (including OAuth tokens) are stored in `~/.claude/accounts/` with permissions `600` (only readable by you)
- On macOS, tokens are also saved in and restored from the login Keychain
- Temporary files are created with `600` permissions before being atomically renamed into place — credentials are never world-readable even briefly
- All `save()`/`load()` operations are protected by an advisory file lock to prevent concurrent processes from corrupting account state
- Email addresses used as filenames are validated against an allowlist (`[A-Za-z0-9._+@-]`) before any file operation
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
