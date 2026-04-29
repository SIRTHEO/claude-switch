# claude-switch — multi-account manager for Claude Code

[![npm version](https://img.shields.io/npm/v/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![npm downloads](https://img.shields.io/npm/dm/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js CI](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/@sirtheo/claude-switch)](package.json)

**Use multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) accounts on the same computer. Sign in to each one in your browser ONCE. After that, switch between them in one second — no browser, no logout, no waiting.**

Plus: bypass your Max/Pro rate limit by switching to your Anthropic API key with one command, and let claude-switch flip back automatically when your subscription frees up.

```bash
claude switch personal       # instant switch, no browser
claude switch work
claude switch fallback on    # hit the 5h limit? bill against API credits instead
```

---

## What it does

- 🔐 **Multiple accounts on one machine** — work + personal + client + side-project, all saved, all signed in. Switch with one command.
- 🌐 **Browser opens once per account** — only when you first add it. Every switch after is instant and offline.
- 💳 **Bypass Max/Pro rate limits** — save your Anthropic API key, flip a toggle, keep working when your subscription hits the 5-hour or 7-day cap.
- 🤖 **Smart auto-revert** — let claude-switch flip back to your subscription automatically when usage drops, so you don't burn API credits when you don't need to.
- 📊 **See your usage live** — 5-hour and 7-day quota numbers in your shell prompt or Claude Code's status bar, fetched from Anthropic's quota API.
- 🎛️ **Interactive menu** — type `claude switch` and do everything from one screen: switch, manage keys, toggle fallback, re-authenticate, edit aliases.
- ⚡ **Instant, offline, no telemetry** — switching is just a file operation. No network calls. No data sent anywhere. All credentials live on your computer with `0600` permissions.
- 🍎 **macOS, Linux, Windows** — same commands everywhere.

---

## Quick links

**Quick links:** [Install](#install) · [First use](#your-first-time-using-it) · [Interactive menu](#the-interactive-menu-the-easy-way) · [Bypass rate limit](#when-you-hit-your-subscription-limit) · [Status bar](#show-your-account-in-your-shell-prompt-or-status-bar) · [Troubleshooting](#when-something-goes-wrong)

---

## Install

**3 minutes, one time only.**

### What you need first

- **Node.js 20.12 or newer** — type `node --version` in your terminal. If it says less than `v20.12`, [install Node](https://nodejs.org/) (Node 18 is end-of-life).
- **Claude Code already installed and working** — if `claude` doesn't already work in your terminal, [install Claude Code first](https://docs.anthropic.com/en/docs/claude-code).

### Step 1 — Install claude-switch

```bash
npm install -g @sirtheo/claude-switch
```

### Step 2 — Run the setup wizard

```bash
claude switch setup
```

This finds your real Claude Code on the computer and remembers where it is. It also adds the right folder to your PATH if needed.

### Step 3 — Open a NEW terminal window

Close your current terminal, open a fresh one. This is **required** — otherwise your shell still uses the old `claude` command.

### Step 4 — Check it worked

```bash
claude switch --version
```

You should see something like `claude-switch 2.5.1`. ✅ Done.

> **What just happened?** claude-switch put a tiny "wrapper" in front of the `claude` command. When you type `claude`, the wrapper picks the right account first, then runs the real Claude Code. Your original Claude Code is untouched.

---

## Your first time using it

### 1. Save your current account

Just run `claude` like you normally would:

```bash
claude
```

claude-switch sees you're already logged in and saves that account automatically:

```
Detected account: work@company.com (saved automatically)

🔑 work@company.com
```

You don't have to do anything. Done.

### 2. Add a second account

```bash
claude switch add
```

A browser opens. Sign in with your **other** account. When you come back to the terminal, claude-switch will ask if you want a short nickname (alias):

```
Email of the account you are about to add: personal@gmail.com
✔ Saved: personal@gmail.com
Optional alias: personal
✔ Done
```

Now you have two accounts saved.

### 3. Switch between them

```bash
claude switch personal      # use the alias
claude switch work          # back to work
claude switch               # opens a menu to pick from a list
```

The switch is instant — no browser, no waiting.

---

## The interactive menu (the easy way)

If you don't want to remember commands, just type:

```bash
claude switch
```

A menu pops up showing:

- which account is currently active
- whether you're using OAuth (subscription) or your API key
- if your token is still valid
- your current usage % (5 hours and 7 days)

From the menu you can:

- 🔄 **Switch account** — pick another account, claude opens automatically
- 🔑 **Turn fallback ON / OFF** — switch between subscription billing and API key billing
- 🤖 **Enable auto-revert to OAuth** — automatic switch back when subscription frees up
- 🗝️ **Set API key** for the active account
- ⚙️ **Manage account…** — edit any saved account (API key, alias, remove)
- ➕ **Advanced…** — add new account, run setup wizard, etc.

Press `Ctrl+C` or pick "Exit" to leave. Your terminal goes back to normal — no leftover stuff in the scrollback.

---

## Common things you'll want to do

### See your accounts

```bash
claude switch list
```

```
Saved accounts:

  * work@company.com (active) [work, w]
    personal@gmail.com [personal]
```

The `*` is which account is active right now. The names in `[brackets]` are aliases.

### Check what's going on

```bash
claude switch status
```

Tells you:
- which account is active
- if your token is still good (or expired)
- if you have an API key saved
- if fallback is ON or OFF

### Add nicknames (aliases)

Tired of typing `personal@gmail.com`? Give it a short name:

```bash
claude switch alias p personal@gmail.com   # now "claude switch p" works
claude switch alias --list                 # show all aliases
claude switch alias --remove p             # delete an alias
```

### Remove an account

```bash
claude switch remove old@email.com
```

(You can't remove the account you're currently using — switch to a different one first.)

### Use a different account just for ONE command

```bash
claude --as personal "review this code"
```

This runs the command as `personal`, then switches **back** to your original account automatically. Even if you press Ctrl+C in the middle, it restores correctly.

---

## When you hit your subscription limit

Claude's Max/Pro plans have rate limits (5-hour and 7-day). When you hit one, Claude Code stops working for a while — even though you have API credits available.

claude-switch fixes this with a **manual fallback toggle**:

### Step 1 — save an API key for an account

```bash
claude switch apikey set work
# paste sk-ant-... (the key is hidden as you type)
```

### Step 2 — turn fallback ON when you hit the limit

```bash
claude switch fallback on
```

Now `claude` runs with your API key instead of your subscription. You'll be billed against API credits until you turn fallback off.

> ⚠️ **First time:** Claude Code will ask `Use this API key? [y/N]` — press **y**. Your choice is remembered. If you press N or miss this prompt, fallback won't actually work.

### Step 3 — turn it back off when your subscription resets

```bash
claude switch fallback off
```

…or, even better, let claude-switch do it for you:

### Auto-revert (smart-switch)

Forgot to turn fallback off after your 5-hour reset? Auto-revert handles it:

```bash
claude switch fallback auto on                  # default: revert when usage < 80%
claude switch fallback auto on --threshold 70   # custom threshold
```

When fallback is ON and your 5-hour AND 7-day usage both drop below the threshold, the next time you run `claude` you'll see:

```
📈 Subscription back online (5h:30%, 7d:15%) — switched back to OAuth
🔑 work@company.com
```

claude-switch automatically flipped fallback OFF and you're back on your subscription. No more wasted API credits.

Turn it off:
```bash
claude switch fallback auto off
```

---

## Show your account in your shell prompt or status bar

Want to always see which account is active?

```bash
claude switch sl                # short version: "🔑 work OAuth 5h:42%"
claude switch sl --full         # full email instead of nickname
claude switch sl --json         # for scripts
```

The badge turns yellow at 75% usage and red at 90%, so you can see when you're getting close to the limit.

### Add it to Claude Code's status bar (one command)

claude-switch can install the badge into Claude Code for you — no editing of `~/.claude/settings.json` by hand:

```bash
claude switch statusline install                    # just the badge (recommended)
claude switch statusline install --ccstatusline     # combine with ccstatusline
claude switch statusline status                     # show what's currently configured
claude switch statusline uninstall                  # remove the badge
```

The setup wizard (`claude switch setup`) also asks if you want to install it during first-time setup. If you already have a custom `statusLine` configured, claude-switch shows it to you and asks before touching anything.

### Add it to your shell prompt

**Bash / Zsh** — paste at the end of `~/.bashrc` or `~/.zshrc`:
```bash
PS1='$(claude switch sl --no-color) \$ '
```

**Starship** — add to `~/.config/starship.toml`:
```toml
[custom.claude]
command = "claude switch sl --no-color"
when = "true"
```

---

## Tab completion (less typing)

Pick your shell, run the command once, then open a new terminal:

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

Now press Tab after `claude switch ` to see all commands and account names.

---

## Update claude-switch

```bash
claude switch update
```

Checks for a new version and offers to install it. claude-switch also notifies you automatically when an update is available.

---

## When something goes wrong

### `claude` doesn't exist after install

You skipped step 3. Open a **new** terminal window. If still broken:

```bash
claude switch setup
# then close the terminal and open a new one
```

### claude-switch can't find Claude Code

Tell it where Claude Code is:

```bash
export CLAUDE_SWITCH_BIN="/path/to/claude"
```

Find the path with `which claude` (in a terminal where claude-switch isn't installed yet) or check your npm global folder.

### "Token: EXPIRED" appears

Your OAuth login has expired. From the menu, click **Re-authenticate** — a browser opens, you sign in again, done.

Or from the command line:
```bash
claude switch add  # re-runs the login flow for the active account
```

### `claude switch usage` says nothing

Usage tracking only works for **Max/Pro subscribers** — it reads from Anthropic's quota endpoint. If you're on the free tier or only using API keys, this is normal.

### Fallback is ON but `claude` still uses OAuth

The first time Claude Code sees a new API key, it asks `Use this API key? [y/N]`. If you missed this prompt, run `claude` once interactively and press **y** when it appears.

### Anything else

```bash
claude switch status
claude switch list
claude switch --version
```

…and [open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) with the output, plus your OS and `node --version`.

---

## Why this exists

Claude Code lets you log in with **one** account at a time. So if you have a work account and a personal account, every time you want to switch you have to log out, open a browser, sign in again, and wait for the session to load — then again, in reverse, when you want to go back. Five minutes of clicks every time.

Plus: when you hit your Max/Pro subscription rate limit, Claude Code stops working until the window resets. Even if you have API credits sitting unused.

claude-switch fixes both: instant offline switching between saved accounts, and a one-command toggle that bills against your API key when your subscription is capped.

---

## How it works (under the hood)

If you're curious:

- Claude Code stores your **identity** (which email, which avatar, etc.) in `~/.claude.json`.
- Claude Code stores your **tokens** (the secrets that prove you're you) in the macOS **Keychain** (or in `~/.claude.json` on Linux/Windows).
- claude-switch saves both pieces for each account in `~/.claude/accounts/<email>.json` — file permissions `600`, only readable by you.
- When you switch, claude-switch swaps both at the same time. No network calls. Instant.
- A small file lock (`~/.claude/accounts/.lock`) prevents two `claude switch` running at the same time from corrupting your accounts.

---

## Good to know

- **Switching is offline.** No data is sent anywhere.
- **Your tokens are never invalidated.** Switching does not log you out — all accounts stay signed in.
- **The browser is only needed once per account** — when you first add it.
- **Accounts are saved per machine.** Add them again on each computer you use.
- **Usage data is cached.** Anthropic's quota endpoint is rate-limited, so claude-switch caches numbers for 15 minutes and refreshes in the background.

---

## Security

- All credentials live in `~/.claude/accounts/` with file permissions `600` (owner-only).
- On macOS, OAuth tokens are also stored in the login Keychain — same protection as Claude Code uses by default.
- Temporary files are written restricted from the moment they're created — credentials are never world-readable, even briefly.
- Account switches are protected by an advisory file lock, so concurrent processes can't corrupt your saved state.
- No automatic install scripts — you have to explicitly run `claude switch setup`.
- No telemetry. No analytics. Everything stays on your computer.

---

## What's new

**v2.5.0** — `claude switch statusline install` adds the account badge to Claude Code's status bar in one command (no more hand-editing `~/.claude/settings.json`). The setup wizard offers it during first-time setup. Idempotent and safe with existing custom status lines.

**v2.4.1** — minimum Node.js bumped to 20.12 (Node 18 is end-of-life).

**v2.4.0** highlights:

- **Auto-revert to OAuth** — opt-in toggle that flips fallback OFF when your subscription frees up
- **Manage any account** — edit API key / aliases / remove without switching to it first
- **Re-authenticate inline** — when your token expires, fix it from the menu (no shell commands)
- **Auto-launch claude after switch** — switching from the menu now opens claude automatically
- **Alt-screen menu** — the interactive menu opens in a fresh canvas (like vim or htop) and leaves your scrollback untouched

Earlier highlights:

- **v2.3.0** — interactive TUI, subscription usage monitoring, shell statusline, per-account API key + fallback toggle
- **v2.2.0** — fixed account switching to also swap macOS Keychain tokens (critical bug fix)

---

## Contributing

Pull requests welcome. For big changes, [open an issue first](https://github.com/SIRTHEO/claude-switch/issues/new/choose) so we can talk about the approach.

When reporting a bug, please include:
- Your OS and Node.js version (`node --version`)
- Output of `claude switch --version`
- Steps to reproduce
- What you expected vs what actually happened

---

## License

MIT
