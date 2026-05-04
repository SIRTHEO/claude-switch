# claude-switch — manage multiple Claude Code accounts, bypass rate limits, run parallel sessions

[![npm version](https://img.shields.io/npm/v/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![npm downloads](https://img.shields.io/npm/dm/@sirtheo/claude-switch)](https://www.npmjs.com/package/@sirtheo/claude-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js CI](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml)

**claude-switch** lets you manage multiple Claude Code accounts on the same machine — switch between Claude accounts in one second, bypass Claude Max/Pro rate limits with API key fallback and auto-revert, and run isolated per-terminal sessions where each terminal uses a different Claude account simultaneously.

> ⭐ **If this saves you time, [star the repo](https://github.com/SIRTHEO/claude-switch) — it helps others find it.**

---

## One command. That's all you need.

```bash
claude switch
```

That opens a menu. Everything happens from there — switching accounts, managing API keys, opening isolated sessions, checking usage. You don't need to memorize anything else.

> **Already installed?** Starting from v2.8, claude-switch updates itself automatically in the background while you work. Run `npm install -g @sirtheo/claude-switch` once to get the latest version, then you'll never need to update manually again.

---

## What it does

| Problem | claude-switch fix |
|---|---|
| You have a personal and a work Claude account | One command switches between them — no browser, no re-login |
| Your Max/Pro subscription hit the rate limit | Auto-switch to your API key; auto-switch back when the limit resets |
| You need two accounts open in two terminals at the same time | **Profiles** — each terminal gets its own fully isolated session |

---

## Install (3 steps, ~3 minutes)

**Requires:** Node.js 20.12+ and Claude Code already installed.

```bash
# 1. Install
npm install -g @sirtheo/claude-switch

# 2. Run the setup wizard
claude switch setup

# 3. Open a NEW terminal window (important — old window has stale PATH)
```

Verify:

```bash
claude switch --version
```

---

## Daily use

Type `claude switch` and the interactive menu does everything:

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
○ Profiles…
○ Advanced…
○ Exit
```

You never need to remember any command — the menu shows your current state and walks you through every action.

---

## Run two Claude accounts in parallel — per-terminal isolation

`claude switch work` makes *every* terminal use the work account. That's what you want 90% of the time.

But sometimes you need Terminal A on account X and Terminal B on account Y simultaneously. That's what **profiles** are for.

Each profile is a fully isolated environment: its own user ID, its own macOS Keychain entry, its own session history. You open it in one terminal and every other terminal is unaffected.

### The one-step way (new in 2.7)

From the menu: **Profiles → Open account isolated** → pick your account → done.

claude-switch creates or reuses the profile automatically. No manual "create then import" needed.

```bash
claude switch
# → Profiles…
# → Open account isolated
# → pick work@company.com
# → claude opens, isolated to that account in this terminal only
```

### Command line

```bash
# Open an isolated session for a saved account (auto-creates the profile)
claude switch profile use work

# List all profiles
claude switch profile list

# Log in to a profile for the first time (browser opens once)
claude switch profile login work

# Remove a profile
claude switch profile remove work
```

### Global switch vs isolated — which to use?

| You want | Use |
|---|---|
| Switch the active account on this machine | `claude switch <account>` (or the menu) |
| One terminal on account X, others on account Y | **Profiles → Open account isolated** |
| Run one command as a different account | `claude --as personal "task"` |

> **Platform notes:** macOS verified end-to-end (each profile gets its own Keychain entry). Linux and Windows store tokens in the profile's `.claude.json` — same UX, simpler internals.

---

## Bypass Claude rate limits with API key fallback

Hit your Max/Pro limit, turn on API key fallback, then **forget about it**. claude-switch watches your usage and switches back to your subscription automatically when the limit resets.

From the menu: **Enable auto-revert to OAuth** → set a threshold (default 80%).

The next time you run `claude` after your subscription frees up:

```
📈 Subscription back online (5h:30%, 7d:15%) — switched back to OAuth
🔑 work@company.com
```

Both 5-hour AND 7-day usage are checked, so you don't bounce back only to hit the weekly cap moments later.

---

## More features

**Per-account API key** — each saved account has its own Anthropic API key; switching accounts switches which key is used for billing.

**Live usage in Claude Code's status bar** — install a badge that turns yellow at 75% and red at 90%:

```bash
claude switch statusline install
```

**Tab completion:**

```bash
claude switch --completions bash >> ~/.bashrc   # or zsh / fish / powershell
```

**Keyboard shortcuts in the menu** — `↑`/`↓` to move, `Enter` to confirm, `Esc` or `Ctrl+C` to cancel.

---

## Common questions

**How do I add a second account?**
`claude switch` → **Advanced…** → **Add account**. Browser opens once, you sign in, done.

**How do I switch accounts without logging out?**
`claude switch` → **Switch account** → pick from the list. No browser. Under a second.

**Does it work on macOS, Linux and Windows?**
Yes. Requires Node.js 20.12 or newer.

**Does claude-switch send my data anywhere?**
No. Everything stays on your machine. The only network calls are: your subscription quota at `api.anthropic.com` (usage stats) and the npm registry (update checks). No telemetry, no analytics.

**I switched accounts in one terminal but another open Claude Code session shows the old account.**
Not a bug — it's how Claude Code works globally. Running sessions keep tokens in memory and only flip on the next refresh. For true per-terminal isolation, use **Profiles → Open account isolated**.

**My API key fallback didn't kick in mid-session.**
claude-switch's fallback works by injecting `ANTHROPIC_API_KEY` into the environment of the claude process it *spawns*. A REPL that's already running can't be hot-swapped mid-session. Exit it, turn fallback on (`claude switch fallback on`), and re-run `claude`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `claude` not found after install | Open a new terminal. If still broken, run `claude switch setup` again. |
| "Token: EXPIRED" in the menu | Menu shows **Re-authenticate** at the top. Click it. |
| Fallback is on but claude still uses OAuth | The first time Claude Code sees a new API key it asks `Use this API key? [y/N]` — press **y**. |
| Usage stats show nothing | Only works for Max/Pro subscribers. |
| Anything else | [Open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) with your OS and `node --version`. |

---

## Security

- Credentials in `~/.claude/accounts/` with file permissions `600` (owner-only)
- On macOS, OAuth tokens also live in the login Keychain — same protection as Claude Code itself
- All credential writes are atomic (tmp + rename) — a crash mid-write can never corrupt your files
- No automatic install scripts. No telemetry. No analytics.

---

## What's new

**v2.8.x** — **Auto-update.** claude-switch now updates itself silently in the background while `claude` is running. No more `npm install -g` after every release — just install once and stay current automatically.

**v2.7.x** — **Profiles** with one-step "Open account isolated" from the menu. Each profile is its own Keychain entry / userID / session — open two terminals on two different accounts simultaneously, no interference. Auto-creates the profile from a saved account — no browser re-login required.

**v2.6.x** — Warns when other Claude Code sessions are running before flipping the active account. Cross-platform CI (Linux + macOS + Windows × Node 20/22/24).

**v2.5.x** — `claude switch statusline install` patches Claude Code's status bar in one command. Auto-install offered during setup.

**v2.4.x** — Auto-revert to OAuth, in-menu re-authenticate, auto-launch claude after switch.

**v2.3.x** — Interactive menu, subscription usage monitoring, shell statusline, per-account API key + fallback toggle.

Full changelog: [CHANGELOG.md](CHANGELOG.md) · [GitHub Releases](https://github.com/SIRTHEO/claude-switch/releases)

---

## How claude-switch manages multiple Claude Code accounts

- Claude Code stores your active account in `~/.claude.json` and OAuth tokens in the macOS Keychain (or in `~/.claude.json` on Linux/Windows).
- claude-switch saves both for each account in `~/.claude/accounts/<email>.json`.
- When you switch, claude-switch swaps both atomically. No network. Instant.
- Profiles pass `CLAUDE_CONFIG_DIR` to the claude binary — Claude Code natively supports this and gives each distinct directory its own isolated state.
- The wrapper itself is ~40KB of compiled JavaScript. The real `claude` binary is untouched.

---

## Contributing

Pull requests welcome. Releases are fully automated — see [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the commit conventions that drive version bumps.

---

## License

MIT

---

> ⭐ **Found this useful? [Give it a star on GitHub](https://github.com/SIRTHEO/claude-switch)** — it helps others discover the project.
