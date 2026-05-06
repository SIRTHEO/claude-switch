<div align="center">

<img src="docs/images/brand.svg" alt="claude-switch — multi-account manager for Claude Code" width="540"/>

### The fastest way to manage multiple Claude Code accounts, bypass Max & Pro rate limits, and run parallel Claude sessions on the same machine.

**One CLI · zero browser logins after setup · macOS · Linux · Windows**

<p>
  <a href="https://www.npmjs.com/package/@sirtheo/claude-switch"><img alt="npm" src="https://img.shields.io/npm/v/@sirtheo/claude-switch?color=f0b429&label=npm&style=for-the-badge"></a>
  <a href="https://www.npmjs.com/package/@sirtheo/claude-switch"><img alt="downloads" src="https://img.shields.io/npm/dm/@sirtheo/claude-switch?color=3fb950&style=for-the-badge"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-79c0ff?style=for-the-badge"></a>
  <a href="https://github.com/SIRTHEO/claude-switch"><img alt="stars" src="https://img.shields.io/github/stars/SIRTHEO/claude-switch?style=for-the-badge&color=f0b429"></a>
</p>

```bash
npm install -g @sirtheo/claude-switch && claude switch setup
```

[**🚀 Install**](#-install) · [**✨ Features**](#-features) · [**🪟 Profiles**](#-run-two-claude-accounts-in-parallel) · [**❓ FAQ**](#-faq) · [**⭐ Star it**](https://github.com/SIRTHEO/claude-switch)

</div>

---

## ⚡ TL;DR

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

## 🚀 Install

> [!IMPORTANT]
> **Requires Node.js 20.12+ and Claude Code already installed.**

```bash
npm install -g @sirtheo/claude-switch
claude switch setup
```

Then **open a new terminal window** (the old one has a stale `PATH`) and verify:

```bash
claude switch --version
```

> [!TIP]
> **Already installed?** Since v2.8 claude-switch updates itself silently in the background. Install once, forget about it.

---

## ✨ Features

### 🔁 Sub-second account switching

Type `claude switch`. Highlight a row. Hit `Enter`. Done.

- ⚡ **Atomic swap** of OAuth token + active account in `~/.claude.json`
- 🌐 **No browser** — tokens encrypted at rest in the macOS Keychain (or `0600`-permissioned on Linux/Windows)
- 🔄 **No logout/login loop** — the next session simply starts as the new account

---

### 🔋 Rate-limit bypass with auto-revert

Stop losing 5 hours of momentum to the Max cap.

- 🎚 **Per-account fallback** — each account has its own Anthropic API key
- 🚦 **Auto-engage thresholds** — e.g. switch to API key at 95% usage
- ↩️ **Auto-revert** when both **5h** *and* **7d** windows clear — no manual flip

```text
📈 Subscription back online (5h:30%, 7d:15%) — switched back to OAuth
```

---

### 🪟 Parallel sessions via isolated profiles

Two accounts. Two terminals. Same machine. **Zero interference.** Each profile gets its own `CLAUDE_CONFIG_DIR`, Keychain entry, and session history.

```bash
claude switch profile use work       # one terminal
claude switch profile use personal   # another, simultaneously
```

Or one-step from the menu: `Profiles → Open account isolated`.

---

### 📊 Live usage in the Claude Code statusline

```bash
claude switch statusline install
```

A discreet badge that turns **yellow at 75%** and **red at 90%**. You'll never be ambushed by a rate limit again.

---

### ⚙️ Configurable smart defaults

Open Settings (`g`) and tune:

| Default | What it does |
|---|---|
| **Auto-launch `claude` after switch** | drop straight into the REPL after picking an account |
| **Auto-toggle fallback on switch** | prevents stale `ANTHROPIC_API_KEY` leaks across accounts |
| **Always launch isolated** *(per account)* | this account always starts in its own terminal-scoped profile |

---

### 🔐 Security-first by design

> [!IMPORTANT]
> **No telemetry. No analytics. No phone-home.**
> Only network calls: Anthropic's usage endpoint and the npm registry.

- 📁 Credentials in `~/.claude/accounts/` with `0600` permissions
- 🔑 macOS: OAuth tokens in the login Keychain (same as Claude Code itself)
- 💾 All credential writes are atomic (`tmp + rename`) — a crash mid-write **cannot** corrupt your tokens
- 🚫 No `postinstall` scripts. The real `claude` binary is never modified.

---

### 🎛 Built on Ink — a real TUI

Full **React-for-the-terminal** UI: focus rings, live updates, hotkeys, in-place re-renders. `Tab` cycles sections, `↑↓` navigates, single-letter keys (`a` `k` `f` `c` `g` `p`…) are accelerators, `?` for inline help.

Plus: tab completion (`bash` · `zsh` · `fish` · `powershell`), one-shot `claude --as <alias> "task"`, and cross-platform CI on Linux + macOS + Windows × Node 20/22/24.

---

## 🪟 Run two Claude accounts in parallel

`claude switch work` flips the active account on the **whole machine** — what you want 90% of the time.

The other 10% — Terminal A on `@work` and Terminal B on `@personal` **at the same time** — that's what **profiles** are for.

| You want | Use |
|---|---|
| Switch the active account globally | `claude switch <account>` |
| One terminal on X, others on Y | **Profiles → Open account isolated** |
| Run a single command as another account | `claude --as <alias> "<task>"` |

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
│   [f] Toggle fallback                       flip OAuth ↔ API key      │
│   [c] Re-authenticate                       browser re-login          │
╰───────────────────────────────────────────────────────────────────────╯

╭─ General ─────────────────────────────────────────────────────────────╮
│   [a] Add account     [g] Settings     [p] Profiles                   │
│   [F] Auto-fallback   [u] Refresh usage [s] Setup wizard  [q] Quit    │
╰───────────────────────────────────────────────────────────────────────╯
```

</details>

Three sections: **Accounts** (roster + live usage), **Account** (actions for the highlighted row), **General** (cross-cutting). Orange border = focused section.

---

## ⚖️ Comparison

|  | **claude-switch** | `claude logout` + browser | manual `~/.claude.json` swap |
|---|:---:|:---:|:---:|
| ⏱ Switch time | **< 1 sec** | 30–60 sec | seconds (risky) |
| 👥 Multiple accounts | ✅ unlimited | 🚫 one at a time | ⚠️ manual |
| 🔋 API-key fallback w/ auto-revert | ✅ | 🚫 | 🚫 |
| 🪟 Parallel terminal sessions | ✅ profiles | 🚫 | 🚫 |
| 📊 Usage tracking | ✅ live | 🚫 | 🚫 |
| 🛡 Telemetry | **none** | n/a | n/a |

---

## ❓ FAQ

<details>
<summary><b>Does claude-switch send my data anywhere?</b></summary>

**No.** Only network calls are Anthropic's usage endpoint (your subscription quota) and the npm registry (update checks). No telemetry. The source is open — verify it.
</details>

<details>
<summary><b>Is it safe with my real Claude account?</b></summary>

Yes. Credentials live exactly where Claude Code already puts them. All writes are atomic. No `postinstall` scripts. ~40 KB of compiled JS, MIT-licensed. The real `claude` binary is never modified.
</details>

<details>
<summary><b>How do I add a second account?</b></summary>

`claude switch` → press `a`. Browser opens once. Sign in. Done.
</details>

<details>
<summary><b>Switching vs profile — what's the difference?</b></summary>

| | Switching | Profile |
|---|---|---|
| Scope | Whole machine | One terminal |
| Use for | Daily account toggling | Parallel sessions |
| Affects other terminals | Yes | No |
</details>

<details>
<summary><b>My API-key fallback didn't kick in mid-session.</b></summary>

Fallback injects `ANTHROPIC_API_KEY` into the env of the `claude` process it spawns. A REPL that's already running can't be hot-swapped. Exit it, turn fallback on, re-run `claude`.
</details>

---

## 🛠 Troubleshooting

| Symptom | Fix |
|---|---|
| `claude` not found after install | Open a new terminal. If still broken: `claude switch setup` |
| `Token: ✗ expired` in the dashboard | Highlight the row → press `c` (Re-authenticate) |
| Fallback is on but Claude still uses OAuth | First time Claude Code sees a new key it asks `Use this API key? [y/N]` — press **y** |
| Usage stats show nothing | Only available for Max/Pro subscribers |
| Anything else | [Open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) |

---

## 📦 What's new

- **v3.1.x** — 🎨 **Ink TUI rebuild.** Three-section dashboard, configurable smart defaults, cross-account API-key leak fixed.
- **v2.8.x** — 🔄 **Auto-update.** Silent background updates while you work.
- **v2.7.x** — 🪟 **Profiles.** One-step "Open account isolated" — parallel sessions on one machine.

📄 Full changelog: [`CHANGELOG.md`](CHANGELOG.md)

---

## 🤝 Contributing & license

PRs welcome — see [`CONTRIBUTING.md`](.github/CONTRIBUTING.md). Licensed under [**MIT**](LICENSE).

---

<div align="center">

### If claude-switch saved you 5 hours of waiting for a rate limit to reset…

### ⭐ [**Star it on GitHub**](https://github.com/SIRTHEO/claude-switch)

```bash
npm install -g @sirtheo/claude-switch
```

<sub><b>Keywords</b> — claude code multi account · claude account switcher · claude max rate limit bypass · anthropic api key fallback · claude code parallel sessions · claude code profiles · claude cli multiple accounts</sub>

</div>
