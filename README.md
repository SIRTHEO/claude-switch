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

> 📌 **TL;DR for every "how do I…" question below:** type `claude switch` and follow the menu. The menu shows your current state and walks you through every action — adding accounts, setting API keys, toggling fallback, viewing usage, re-authenticating. You never need to remember any of the specific commands shown below — they're shortcuts for power users.

**How do I use multiple Claude Code accounts on the same machine?**
Type `claude switch` → pick **Advanced…** → **Add account**. The menu opens your browser, you sign in with the new account, and you're done. Repeat for each account you want. After that, switching is instant.

**How do I switch Claude Code accounts without logging out?**
Type `claude switch` → pick **Switch account** → choose from the list. No browser. No logout. Under a second.

**Can I use my Anthropic API key when my Max/Pro subscription hits the rate limit?**
Yes. From the menu: **Set API key** → paste the key. Then **Turn fallback ON**. From now on `claude` runs against your API credits until you turn fallback off.

**Will claude-switch flip back to my subscription automatically when the limit resets?**
Yes. From the menu: **Enable auto-revert to OAuth** → set a threshold (default 80%). When your 5-hour and 7-day usage both drop below it, the next `claude` run prints `📈 Subscription back online — switched back to OAuth` and you're back on your subscription.

**Do I have to learn a bunch of new commands?**
No. **The only new command is `claude switch`** — everything happens in the menu it opens. Direct command shortcuts exist (e.g. `claude switch personal`, `claude switch fallback on`) but you never need them.

**Does it work on macOS, Linux and Windows?**
Yes. Requires Node.js **20.12 or newer**.

**Does claude-switch send my data anywhere?**
No. Everything stays on your computer. Switching accounts is a local file operation. The only network calls claude-switch makes are: (1) your subscription quota at `api.anthropic.com` when you ask for usage stats, and (2) the npm registry to check for updates. No telemetry, no analytics.

**I want different terminals using different accounts at the same time.**
Use **profiles** — `claude switch profile use <name>` pins a single terminal to one account without touching the others. Sign in once per profile (`claude switch profile login <name>`), then every terminal that runs `claude switch profile use <name>` gets its own isolated session with its own user ID, Keychain entry, and history. See the [Profiles section](#profiles--true-per-terminal-isolation-new-in-27) for the full UX. The classic `claude switch <account>` flip-the-active-account-everywhere flow is unchanged and still works alongside profiles.

**I switched accounts in one terminal but my other open Claude Code sessions still show the old account. Bug?**
Not a bug — it's how Claude Code itself works *globally*. `claude switch <account>` rewrites the user-level state (`~/.claude.json` + macOS Keychain), so already-running `claude` processes hold their old tokens **in memory** and only flip on the next refresh. claude-switch warns you before a switch when it detects other sessions running so you aren't surprised. If you want true per-terminal isolation today, use **profiles** — see the question above and the [Profiles section](#profiles--true-per-terminal-isolation-new-in-27). One-shot swap for a single command without affecting other terminals: `claude --as <account> "task"`.

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

## Daily use — just type `claude switch`

```bash
claude switch
```

That's it. The menu opens and shows:

```
◆ Status
│ Account     work@company.com
│ Auth mode   OAuth subscription
│ Token       valid (expires in 3 days)
│ Usage       5h 42%   7d 18%
└──

◆ What would you like to do?
● Switch account
○ Turn fallback ON (use API key)
○ Enable auto-revert to OAuth
○ Set API key
○ Manage account…
○ Refresh usage
○ Advanced…
○ Exit
```

Pick what you want. The menu walks you through everything — switching, adding accounts, setting API keys, toggling fallback, re-authenticating an expired token, even installing the status badge in Claude Code.

When you switch accounts from the menu, claude-switch automatically opens claude on the new account. So your typical flow is just:

```bash
claude switch     # type this once, pick the account, claude opens automatically
```

---

## Profiles — true per-terminal isolation _(new in 2.7)_

`claude switch <account>` flips the active account globally — every terminal on the machine starts using the new account on its next run. That's the right behaviour 90% of the time, but it does NOT isolate by terminal: two open `claude` REPLs cannot use two different accounts at the same time on the same machine.

**Profiles** fix that. Each profile is a fully isolated environment: own user ID, own macOS Keychain entry, own session history. You sign in once per profile, then run `claude switch profile use <name>` in the terminal you want pinned to that account. Other terminals are not affected.

```bash
# 1. Create + sign in (browser opens once per profile)
claude switch profile create work
claude switch profile login work

# 2. Use it in THIS terminal
claude switch profile use work       # spawns claude pinned to "work"
                                     # other terminals stay on whatever they were

# Have a saved account already? Skip the browser:
claude switch profile import tech@gyver.work --as work

# Inspect / clean up
claude switch profile list
claude switch profile status work
claude switch profile remove work    # also prints the macOS Keychain
                                     # cleanup command (one-liner you can copy)
```

Profiles **coexist** with the legacy `claude switch <account>` flow — using one does not affect the other. Pick whichever matches your need:

| You want | Use |
|---|---|
| "swap the active account everywhere on this machine" | `claude switch <account>` |
| "this terminal uses account X, others stay as they are" | `claude switch profile use <name>` |

> **Platform notes:** macOS is verified end-to-end (each profile gets its own Keychain entry). Linux and Windows store tokens directly in the profile's `.claude.json` (no system credential store involved); the same UX works there but with simpler internals.

---

## Smart features

### Auto-revert to OAuth (the killer feature)

Hit your Max/Pro 5-hour rate limit, turn on fallback, then **forget about it**. claude-switch will switch you back to your subscription automatically the moment your usage drops below your threshold.

From the menu: **Enable auto-revert to OAuth** → set a threshold (default 80%).

The next time you run `claude` after your subscription frees up, you'll see:

```
📈 Subscription back online (5h:30%, 7d:15%) — switched back to OAuth
🔑 work@company.com
```

…and you're back on your subscription. No more burning API credits when you don't have to. Both 5-hour AND 7-day usage are checked, so you don't bounce back to OAuth only to slam into the weekly cap a few minutes later.

### Per-account API key

Each saved account can have its own Anthropic API key. Switching accounts also switches which key is used for fallback billing. From the menu: **Set API key**.

### One-shot switch with `--as`

Use a different account for a single command, then snap back:

```bash
claude --as personal "review this code"
```

The original account is restored when the command finishes — even if you press Ctrl+C or claude crashes mid-task.

### Live usage in Claude Code's status bar

From the menu: **Advanced…** → **Install status bar badge**. Or one-liner:

```bash
claude switch statusline install
```

The badge turns yellow at 75% usage and red at 90%, so you can see when you're approaching the limit at a glance. Idempotent — won't touch a custom status line you already configured.

### Tab completion in your shell

```bash
claude switch --completions bash >> ~/.bashrc       # or zsh / fish / powershell
```

---

## When something goes wrong

**`claude` not found after install** → open a NEW terminal. If still broken, run `claude switch setup` again.

**"Token: EXPIRED" in the menu** → the menu shows a **Re-authenticate** entry at the top. Click it. Browser opens, sign in, done.

**Fallback is on but `claude` still uses OAuth** → the first time Claude Code sees a new API key it asks `Use this API key? [y/N]`. Press **y**. If you missed it, run `claude` once interactively.

**Usage stats show nothing** → only works for Max/Pro subscribers. If you're free-tier or API-key-only, this is normal.

**Anything else** → open `claude switch`, look at the **Status** panel at the top, and [open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) with what you see + your OS and `node --version`.

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
