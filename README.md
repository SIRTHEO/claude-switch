# claude-switch — multi-account manager for [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

[![npm version](https://img.shields.io/npm/v/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![npm downloads](https://img.shields.io/npm/dm/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js CI](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml)

claude-switch is a tiny wrapper around the `claude` command that lets you keep **multiple Claude Code accounts** on the same computer and switch between them in **one second** — no browser, no logout. It also gives you a fallback to your **Anthropic API key** when your Max/Pro subscription hits the rate limit, with optional **auto-revert** back to OAuth when your subscription frees up again.

> **The only new command you ever type is `claude switch`.** That opens a menu where you do everything else.

```bash
claude switch personal       # switch to your "personal" account in 1 second
claude switch                # or open a menu to do everything else
claude                        # then keep using claude as you always have
```

---

## In 30 seconds

- 🪶 **It's just a wrapper.** You keep typing `claude` like you always have. claude-switch is invisible.
- 🎛️ **`claude switch` opens a menu.** No flags to memorize. Pick what you want.
- 🔁 **Smart auto-revert.** Hit your Max/Pro rate limit? claude-switch can switch to your API key automatically — and switch back to your subscription the moment usage drops back below your threshold. Never burn API credits when you don't need to.

---

## Frequently asked questions

**How do I use multiple Claude Code accounts on the same machine?**
Install claude-switch, then run `claude switch add` to register each account (browser opens once per account). After that `claude switch <name>` swaps between them in under a second, with no browser.

**How do I switch Claude Code accounts without logging out?**
Run `claude switch <alias>`. It rewrites the active account in `~/.claude.json` and restores the OAuth tokens in your macOS Keychain (or Linux/Windows equivalent). No network calls. No logout.

**Can I use my Anthropic API key when my Max/Pro subscription hits the rate limit?**
Yes. Save the key once with `claude switch apikey set <account>`, then `claude switch fallback on` when you hit the limit. claude-switch will inject `ANTHROPIC_API_KEY` into every `claude` invocation until you turn fallback off.

**Will claude-switch flip back to my subscription automatically when the limit resets?**
Yes — turn on auto-revert: `claude switch fallback auto on`. When your 5-hour and 7-day usage both drop below the threshold (default 80%), the next time you run `claude` you'll see `📈 Subscription back online — switched back to OAuth` and you're back on your subscription.

**Do I have to learn a bunch of new commands?**
No. The only new command is `claude switch` — that opens an interactive menu with everything in it.

**Does it work on macOS, Linux and Windows?**
Yes. Requires Node.js **20.12 or newer**.

**Does claude-switch send my data anywhere?**
No. Everything stays on your computer. Switching accounts is a local file operation. The only network calls claude-switch makes are: (1) your subscription quota at `api.anthropic.com` when you ask for usage stats, and (2) the npm registry to check for updates. No telemetry, no analytics.

---

## Install

**3 steps. Takes ~3 minutes.**

### 1. Install it

```bash
npm install -g @sirtheo/claude-switch
```

> Don't have Node.js? Install it first from [nodejs.org](https://nodejs.org/) (version 20.12 or newer).
> Don't have Claude Code? [Install it first](https://docs.anthropic.com/en/docs/claude-code).

### 2. Run setup

```bash
claude switch setup
```

A friendly wizard finds your Claude Code on the computer, sets up your shell PATH, and (optionally) adds an account badge to Claude Code's status bar.

### 3. Open a NEW terminal window

Important — close the current one and open a fresh one. Otherwise your shell still uses the old `claude` command.

### Done. Try it:

```bash
claude switch --version       # should print "claude-switch 2.5.1"
```

✅ You're set. Add your accounts with `claude switch add`.

---

## Daily use — the 3 commands you actually need

```bash
claude switch                  # open the menu (do anything from here)
claude switch <alias>          # switch directly by alias or email
claude --as <alias> "task"     # use another account for ONE command, then auto-restore
```

Everything else is in the menu — adding accounts, setting API keys, toggling fallback, viewing usage, re-authenticating an expired token.

---

## Smart features

### Per-account API key + manual fallback

Each saved account can have its own Anthropic API key. When the subscription hits its limit, flip the global toggle:

```bash
claude switch apikey set work         # save the key (input is hidden)
claude switch fallback on             # bill against API credits from now on
claude switch fallback off            # back to subscription
```

> ⚠️ The first time Claude Code sees a new API key it asks `Use this API key? [y/N]`. Press **y**. Your choice is remembered.

### Auto-revert to OAuth

Forget to turn fallback off when your subscription frees up? Auto-revert handles it:

```bash
claude switch fallback auto on                    # default threshold: 80%
claude switch fallback auto on --threshold 70     # custom threshold
```

When fallback is on AND both your 5-hour and 7-day usage drop below the threshold, the next `claude` run flips fallback off automatically and prints:

```
📈 Subscription back online (5h:30%, 7d:15%) — switched back to OAuth
🔑 work@company.com
```

### Live usage in your status bar

Show the active account + usage % in Claude Code's status bar:

```bash
claude switch statusline install
```

(Patches `~/.claude/settings.json` for you. Idempotent — won't touch a custom status line you've already set.)

The badge turns yellow at 75% usage and red at 90%, so you can see when you're getting close to the limit.

### One-shot switch with `--as`

Use a different account for a single command, then snap back:

```bash
claude --as personal "review this code"
```

If the command is interrupted (Ctrl+C, crash) the original account is restored automatically on the next `claude` run.

### Tab completion

```bash
claude switch --completions bash >> ~/.bashrc       # or zsh / fish / powershell
```

---

## When something goes wrong

**`claude` not found after install** → open a NEW terminal. If still broken, run `claude switch setup` again.

**"Token: EXPIRED" in the menu** → click **Re-authenticate** in `claude switch`. A browser opens, you sign in, done.

**Fallback is on but `claude` still uses OAuth** → first time, Claude Code asks `Use this API key? [y/N]` — press **y**. If you missed it, run `claude` once interactively.

**`claude switch usage` shows nothing** → only works for Max/Pro subscribers. If you're free-tier or API-key-only, this is normal.

**Anything else** → run `claude switch status` and `claude switch --version`, then [open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) with your OS and `node --version`.

---

## Security

- All credentials live in `~/.claude/accounts/` with file permissions `600` (owner-only)
- On macOS, OAuth tokens are also stored in the login Keychain — same protection as Claude Code itself
- Account switches are protected by an advisory file lock so concurrent processes can't corrupt your saved state
- No automatic install scripts. No telemetry. No analytics.
- All credential writes are atomic (`tmp + rename`) so a process crash mid-write can never corrupt your account files

---

## How it works (for the curious)

- Claude Code stores your active account in `~/.claude.json` and the OAuth tokens in the macOS Keychain (or in `~/.claude.json` on Linux/Windows).
- claude-switch saves both pieces for each account in `~/.claude/accounts/<email>.json`.
- When you switch, claude-switch swaps both at the same time. Local file operation. No network. Instant.
- A small file lock (`.lock`) serializes concurrent `claude switch` invocations.
- The wrapper itself is ~40KB of compiled JavaScript. The real `claude` binary is untouched.

---

## What's new

**v2.5.x** — `claude switch statusline install` patches Claude Code's status bar in one command. Auto-install offered during setup. Idempotent and safe with custom configs.

**v2.4.x** — Auto-revert to OAuth (smart-switch), in-menu re-authenticate, manage any account without switching, auto-launch claude after switch, alt-screen menu (no scrollback noise).

**v2.3.x** — Interactive menu, subscription usage monitoring, shell statusline, per-account API key + fallback toggle.

Full changelog: [CHANGELOG.md](CHANGELOG.md) · [GitHub Releases](https://github.com/SIRTHEO/claude-switch/releases)

---

## Contributing

Pull requests welcome. Releases are fully automated — see [CONTRIBUTING.md](CONTRIBUTING.md) for the commit-message conventions that drive version bumps.

---

## License

MIT
