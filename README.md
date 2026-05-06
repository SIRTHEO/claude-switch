<div align="center">

<img src="docs/images/logo.svg" alt="claude-switch logo" width="540"/>

# `claude-switch`

### The fastest way to manage multiple Claude Code accounts, bypass Max & Pro rate limits, and run parallel Claude sessions on the same machine.

**One CLI · zero browser logins after setup · macOS · Linux · Windows**

<p>
  <a href="https://www.npmjs.com/package/@sirtheo/claude-switch"><img alt="npm" src="https://img.shields.io/npm/v/@sirtheo/claude-switch?color=f0b429&label=npm&style=for-the-badge"></a>
  <a href="https://www.npmjs.com/package/@sirtheo/claude-switch"><img alt="downloads" src="https://img.shields.io/npm/dm/@sirtheo/claude-switch?color=3fb950&style=for-the-badge"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-79c0ff?style=for-the-badge"></a>
  <a href="https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/SIRTHEO/claude-switch/ci.yml?style=for-the-badge&label=CI"></a>
  <a href="https://github.com/SIRTHEO/claude-switch"><img alt="stars" src="https://img.shields.io/github/stars/SIRTHEO/claude-switch?style=for-the-badge&color=f0b429"></a>
</p>

```bash
npm install -g @sirtheo/claude-switch && claude switch setup
```

[**🚀 Install**](#-install) · [**✨ Features**](#-features) · [**🎯 Why**](#-why-claude-switch) · [**🪟 Profiles**](#-run-two-claude-accounts-in-parallel) · [**❓ FAQ**](#-faq) · [**⭐ Star it**](https://github.com/SIRTHEO/claude-switch)

</div>

---

## 📜 Table of contents

<details>
<summary><b>Click to expand</b></summary>

- [⚡ TL;DR — the 30-second pitch](#-tldr--the-30-second-pitch)
- [🎯 Why claude-switch](#-why-claude-switch)
- [🚀 Install](#-install)
- [✨ Features](#-features)
  - [🔁 Sub-second account switching](#-1-sub-second-account-switching)
  - [🔋 Rate-limit bypass with auto-revert](#-2-rate-limit-bypass-with-auto-revert)
  - [🪟 Parallel sessions via isolated profiles](#-3-parallel-sessions-via-isolated-profiles)
  - [📊 Live usage in the statusline](#-4-live-usage-in-the-claude-code-statusline)
  - [⚙️ Configurable smart defaults](#-5-configurable-smart-defaults)
  - [🔐 Security-first by design](#-6-security-first-by-design)
  - [🎛 Built on Ink — a real TUI](#-7-built-on-ink--a-real-tui)
  - [🧠 Bonus utilities](#-8-bonus-utilities)
- [🪟 Run two Claude accounts in parallel](#-run-two-claude-accounts-in-parallel)
- [🧭 The dashboard at a glance](#-the-dashboard-at-a-glance)
- [⚖️ Comparison vs the alternatives](#-comparison-vs-the-alternatives)
- [❓ FAQ](#-faq)
- [🛠 Troubleshooting](#-troubleshooting)
- [🧱 Under the hood](#-under-the-hood)
- [📦 Changelog](#-changelog)
- [🤝 Contributing & license](#-contributing--license)

</details>

---

## ⚡ TL;DR — the 30-second pitch

> [!TIP]
> **You have a Claude Max account, a work Claude account, and an Anthropic API key.**
> Claude Code only knows about one at a time. **claude-switch fixes that.**

|  | What you get |
|---|---|
| ⚡ | **Switch accounts in < 1 second** — no browser, no re-login |
| 🔋 | **Bypass Max & Pro rate limits** with auto-fallback to your API key, and **auto-revert** when your subscription resets |
| 🪟 | **Run two accounts in two terminals at the same time** with isolated profiles |
| 🔐 | **Zero telemetry. Zero analytics.** Credentials live in your OS keychain |
| 🔄 | **Auto-updates in the background** — install once, stay current forever |

```bash
claude switch          # opens the interactive dashboard — that's the whole UX
```

---

## 🎯 Why claude-switch

If you use Claude Code seriously, you've hit one of these walls. claude-switch is the wall-removal tool.

| 🧱 The wall | 🤕 What you used to do | ✅ What claude-switch does |
|---|---|---|
| Hit your Max/Pro 5h or 7d cap mid-task | Stop, wait 5 hours, lose flow | Auto-fallback to API key, auto-revert when limit resets |
| Personal + work accounts on one machine | `claude logout` → browser → log in → repeat | One keystroke. Atomic token swap. |
| Two accounts, two projects, **same time** | Impossible — Claude Code is single-account globally | **Profiles** — isolated session per terminal |
| No idea how much quota is left | Open Anthropic dashboard, refresh, panic | Live 5h + 7d usage bars in menu and statusline |
| Forgot which account is active | `claude` and pray | Active account, token health, fallback flag — visible at a glance |

> [!NOTE]
> **This is the tool you wished was built into Claude Code.** Until Anthropic ships it, install this.

---

## 🚀 Install

> [!IMPORTANT]
> **Requires Node.js 20.12+ and Claude Code already installed.**

#### 1️⃣ Install globally

```bash
npm install -g @sirtheo/claude-switch
```

#### 2️⃣ Run the setup wizard

```bash
claude switch setup
```

> Auto-detects the `claude` binary, fixes your shell `PATH`, offers to install the statusline.

#### 3️⃣ Open a **new** terminal window

> [!WARNING]
> The old terminal still has the stale `PATH`. Close it. Open a fresh one.

#### ✅ Verify

```bash
claude switch --version
```

That's it. Run `claude switch` to see the dashboard.

> [!TIP]
> **Already installed?** Since v2.8 claude-switch updates itself silently in the background while you work. Install once, forget about it.

---

## ✨ Features

### 🔁 1. Sub-second account switching

Type `claude switch`. Highlight a row. Hit `Enter`. Done.

- ⚡ **Atomic swap** of OAuth token + active account in `~/.claude.json`
- 🌐 **No browser** — tokens are encrypted at rest in the macOS Keychain (or in a `0600`-permissioned file on Linux/Windows)
- 🔄 **No logout/login loop** — Claude Code doesn't even notice; the next session starts as the new account

---

### 🔋 2. Rate-limit bypass with auto-revert

Stop losing 5 hours of momentum to the Max cap.

- 🎚 **Per-account fallback** — each account has its own Anthropic API key
- 🚦 **Auto-engage thresholds** — e.g. "switch to API key at 95% usage"
- ↩️ **Auto-revert** when both the **5h** *and* **7d** windows clear — no manual flip
- 🗒 **Plain-text reasoning**:
  ```text
  📈 Subscription back online (5h:30%, 7d:15%) — switched back to OAuth
  🔑 work@company.com
  ```

---

### 🪟 3. Parallel sessions via isolated profiles

Two accounts. Two terminals. Same machine. **Zero interference.**

- 🗂 Each profile gets its own `CLAUDE_CONFIG_DIR`, Keychain entry, and session history
- 🪟 Open in one terminal — the rest of your machine is unaffected
- 🪄 **One-step launch** from the menu: `Profiles → Open account isolated`
- 🤖 Or scriptable:
  ```bash
  claude switch profile use work
  claude --as personal "summarize this PR"
  ```

---

### 📊 4. Live usage in the Claude Code statusline

```bash
claude switch statusline install
```

A discreet badge in Claude Code's status bar:

| State | Color | Meaning |
| :---: | :---: | --- |
| `🟢 22%` | green  | plenty of headroom |
| `🟡 78%` | yellow | approaching the cap |
| `🔴 94%` | red    | about to hit the wall |

You'll never be ambushed by a rate limit again.

---

### ⚙️ 5. Configurable smart defaults

Open Settings (`g`) and tune:

| Default | What it does | Where |
|---|---|---|
| **Auto-launch `claude` after switch** | drop straight into the REPL | Settings → Account |
| **Auto-toggle fallback on switch** | prevents stale `ANTHROPIC_API_KEY` leaks across accounts | Settings → Account |
| **Refresh usage on menu open** | foreground-fetch fresh subscription usage | Settings → Global |
| **Hide manual profile ops** | profiles auto-create on demand | Settings → Global |
| **Always launch isolated** *(per account)* | this account always starts in its own terminal-scoped profile | Settings → Account |

> Settings live in `~/.claude/accounts/.user-prefs.json` (global) and inside each `accounts/<email>.json` under `_prefs` (per-account override).

---

### 🔐 6. Security-first by design

> [!IMPORTANT]
> **No telemetry. No analytics. No phone-home.**
> Only network calls: Anthropic's usage endpoint and the npm registry for update checks.

- 📁 Credentials in `~/.claude/accounts/` with `0600` permissions (owner-only)
- 🔑 macOS: OAuth tokens in the login Keychain (same protection as Claude Code itself)
- 💾 All credential writes are atomic (`tmp + rename`) — a crash mid-write **cannot** corrupt your tokens
- 🚫 No `postinstall` scripts. The real `claude` binary is never modified.

---

### 🎛 7. Built on Ink — a real TUI

The dashboard is a full **React-for-the-terminal** UI: focus rings, live updates, hotkeys, in-place re-renders.

| Key | Action |
| :---: | --- |
| `Tab` / `Shift+Tab` | cycle between sections |
| `↑` / `↓` | navigate within a section |
| `Enter` | activate the highlighted row |
| `a` `k` `m` `f` `c` `d` `g` `p` `u` `s` `F` | single-letter accelerators from anywhere |
| `?` | inline help |
| `q` / `Esc` / `Ctrl-C` | quit |

---

### 🧠 8. Bonus utilities

- 🐚 **Tab completion** — `claude switch --completions zsh >> ~/.zshrc` (also `bash` · `fish` · `powershell`)
- 🎯 **One-shot `--as`** — `claude --as personal "task"` runs a single command as another account, no global switch
- 🧪 **Cross-platform CI** — Linux + macOS + Windows × Node 20 / 22 / 24
- 🔄 **Auto-updates** — never run `npm install -g` again

---

## 🪟 Run two Claude accounts in parallel

`claude switch work` flips the active account on the **whole machine**. That's what you want 90% of the time.

The other 10% — when you need Terminal A on `@work` and Terminal B on `@personal` **at the same time** — that's what **profiles** are for.

```bash
# One terminal scoped to work
claude switch profile use work

# Another terminal, simultaneously, scoped to personal
claude switch profile use personal
```

| You want | Use |
|---|---|
| Switch the active account globally | `claude switch <account>` (or the menu) |
| One terminal on X, others on Y | **Profiles → Open account isolated** |
| Run a single command as another account | `claude --as <alias> "<task>"` |

> [!NOTE]
> **Platform notes** — macOS verified end-to-end (each profile gets its own Keychain entry). Linux & Windows store tokens in the profile's `.claude.json` — same UX, simpler internals.

---

## 🧭 The dashboard at a glance

<details>
<summary><b>Click to see the rendered dashboard</b></summary>

```text
⚡ claude-switch  multi-account dashboard  ·  tab cycles  ·  ? help  ·  q quit

╭─ Accounts (2) ────────────────────────────────────────────────────────╮
│ ▸ work@company.com  @work  ◀ active                                   │
│       OAuth  ·  fallback OFF  ·  token ✓ valid · 3 days               │
│       ● 5h ████▒░░░░░░░░░ 42%    ● 7d ▒░░░░░░░░░░░░░ 18%              │
│                                                                       │
│   personal@gmail.com                                                  │
│       OAuth + key saved  ·  sk-ant-…2BBB  ·  isolated default         │
╰───────────────────────────────────────────────────────────────────────╯

╭─ Account  for work@company.com ───────────────────────────────────────╮
│ ▸ [↵] Launch claude (already active)        open a session            │
│   [k] Replace API key                       currently sk-ant-…1AAA    │
│   [m] Manage (alias · key · remove)         detailed account ops      │
│   [f] Toggle fallback                       flip OAuth ↔ API key      │
│   [c] Re-authenticate                       browser re-login          │
│   [d] Remove account                        delete saved              │
╰───────────────────────────────────────────────────────────────────────╯

╭─ General ─────────────────────────────────────────────────────────────╮
│   [a] Add account     [g] Settings     [p] Profiles                   │
│   [F] Auto-fallback   [u] Refresh usage [s] Setup wizard  [q] Quit    │
╰───────────────────────────────────────────────────────────────────────╯
```

</details>

Three sections, one screen:

1. **Accounts** — the roster, with state + live usage
2. **Account** — actions for the highlighted row (label changes with state)
3. **General** — global, cross-cutting actions

The orange border tells you which section has focus.

---

## ⚖️ Comparison vs the alternatives

|  | **claude-switch** | `claude logout` + browser | shell aliases / dotenv | manual `~/.claude.json` swap |
|---|:---:|:---:|:---:|:---:|
| ⏱ Switch time | **< 1 sec** | 30–60 sec | seconds (breaks OAuth) | seconds (risky) |
| 👥 Multiple accounts | ✅ unlimited | 🚫 one at a time | 🚫 | ⚠️ manual |
| 🔋 API-key fallback w/ auto-revert | ✅ | 🚫 | 🚫 | 🚫 |
| 🪟 Parallel terminal sessions | ✅ profiles | 🚫 | 🚫 | 🚫 |
| 📊 Usage tracking | ✅ live | 🚫 | 🚫 | 🚫 |
| 🔄 Auto-update | ✅ | n/a | 🚫 | 🚫 |
| 🛡 Telemetry | **none** | n/a | n/a | n/a |
| 💥 Risk of corrupting `~/.claude.json` | atomic | n/a | low | **high** |

---

## ❓ FAQ

<details>
<summary><b>Does claude-switch send my data anywhere?</b></summary>

**No.** Everything stays on your machine. Only network calls: Anthropic's usage endpoint (your subscription quota) and the npm registry (update checks). No telemetry. No analytics. The source is open — verify it.
</details>

<details>
<summary><b>Is it safe to use with my real Claude account?</b></summary>

Yes. Credentials live exactly where Claude Code already puts them (Keychain on macOS; permission-`600` JSON elsewhere). All writes are atomic. No `postinstall` scripts. MIT-licensed, ~40 KB of compiled JavaScript, the real `claude` binary is never modified.
</details>

<details>
<summary><b>How do I add a second account?</b></summary>

```bash
claude switch     # → press a (Add account)
```

Browser opens once. Sign in. Done.
</details>

<details>
<summary><b>Will my Max plan ban me for using claude-switch?</b></summary>

claude-switch is just a wrapper that swaps tokens Anthropic already issued you. It doesn't bypass anything Anthropic doesn't already allow — multiple accounts are explicitly supported by Claude Code; this tool just makes managing them ergonomic.
</details>

<details>
<summary><b>What's the difference between switching and a profile?</b></summary>

| | Switching | Profile |
|---|---|---|
| Scope | Whole machine | One terminal |
| Use for | Daily account toggling | Parallel sessions |
| Affects other terminals | Yes | No |
</details>

<details>
<summary><b>My API-key fallback didn't kick in mid-session.</b></summary>

Fallback works by injecting `ANTHROPIC_API_KEY` into the env of the `claude` process it spawns. A REPL that's already running can't be hot-swapped. Exit it, turn fallback on (`claude switch fallback on`), re-run `claude`.
</details>

<details>
<summary><b>Does it work on Windows?</b></summary>

Yes. macOS · Linux · Windows. Node.js 20.12+.
</details>

<details>
<summary><b>How do I remove it?</b></summary>

```bash
npm uninstall -g @sirtheo/claude-switch
```

Account files in `~/.claude/accounts/` you can delete by hand if you want; Claude Code itself is untouched.
</details>

---

## 🛠 Troubleshooting

| Symptom | Fix |
|---|---|
| `claude` not found after install | Open a new terminal. If still broken: `claude switch setup` |
| `Token: ✗ expired` in the dashboard | Highlight the row → press `c` (Re-authenticate) |
| Fallback is on but Claude still uses OAuth | The first time Claude Code sees a new key it asks `Use this API key? [y/N]` — press **y** |
| Usage stats show nothing | Only available for Max/Pro subscribers |
| Anything else | [Open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) — include OS + `node --version` |

---

## 🧱 Under the hood

<details>
<summary><b>How the magic actually works</b></summary>

- Claude Code stores the active account in `~/.claude.json` (and OAuth tokens in the macOS Keychain, or in `~/.claude.json` on Linux/Windows).
- claude-switch saves both for each account in `~/.claude/accounts/<email>.json`.
- Switching swaps both **atomically** (`tmp + rename`). No network round-trip. No race window.
- Profiles set `CLAUDE_CONFIG_DIR` for the spawned `claude` — natively supported by Claude Code, which gives each directory its own isolated state.
- The wrapper itself is **~40 KB** of compiled JavaScript. The real `claude` binary is never touched.

</details>

---

## 📦 Changelog

| Version | Highlights |
|---|---|
| **v3.1.x** | 🎨 **Ink TUI rebuild.** Three-section dashboard, configurable smart defaults, cross-account API-key leak fixed. |
| **v2.8.x** | 🔄 **Auto-update.** Silent background updates while you work. |
| **v2.7.x** | 🪟 **Profiles.** One-step "Open account isolated" — parallel sessions on one machine. |
| **v2.6.x** | ⚠️ Warns on running Claude sessions before flipping the active account. Cross-platform CI. |
| **v2.5.x** | 📊 `claude switch statusline install`. |
| **v2.4.x** | ↩️ Auto-revert to OAuth, in-menu re-authenticate, auto-launch claude after switch. |
| **v2.3.x** | 🎛 Interactive menu, usage monitoring, statusline, per-account API key + fallback. |

📄 Full changelog: [`CHANGELOG.md`](CHANGELOG.md) · [GitHub Releases](https://github.com/SIRTHEO/claude-switch/releases)

---

## 🤝 Contributing & license

PRs welcome. Releases are fully automated — see [`CONTRIBUTING.md`](.github/CONTRIBUTING.md) for the commit conventions that drive version bumps.

Licensed under [**MIT**](LICENSE).

---

<div align="center">

### If claude-switch saved you 5 hours of waiting for a rate limit to reset…

### ⭐ [**Star it on GitHub**](https://github.com/SIRTHEO/claude-switch)

> It's the only metric that helps other devs find it.

```bash
npm install -g @sirtheo/claude-switch
```

[**npm**](https://www.npmjs.com/package/@sirtheo/claude-switch) · [**GitHub**](https://github.com/SIRTHEO/claude-switch) · [**Issues**](https://github.com/SIRTHEO/claude-switch/issues) · [**Changelog**](CHANGELOG.md)

<sub><b>Keywords</b> — claude code multi account · claude account switcher · claude max rate limit bypass · claude pro rate limit · anthropic api key fallback · claude code parallel sessions · claude code profiles · claude cli multiple accounts · claude code account manager · switch claude accounts</sub>

</div>
