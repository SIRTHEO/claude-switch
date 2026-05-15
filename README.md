  <div align="center">

<img src="docs/images/mark.svg" alt="claude-switch — multi-account manager for Claude Code" width="540"/>

### Bypass Claude Max rate limits — auto-fallback to your API key, auto-revert when the window resets.

**Drop-in for Claude Code: keep typing `claude`, but never wait 5 hours again. Multi-account aware. No new CLI to learn, no aliases, no shell hacks.**

**macOS · Linux · Windows**

<p>
  <a href="https://www.npmjs.com/package/@sirtheo/claude-switch"><img alt="npm" src="https://img.shields.io/npm/v/@sirtheo/claude-switch?color=f0b429&label=npm&style=for-the-badge"></a>
  <a href="https://www.npmjs.com/package/@sirtheo/claude-switch"><img alt="downloads" src="https://img.shields.io/npm/dm/@sirtheo/claude-switch?color=3fb950&style=for-the-badge"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-79c0ff?style=for-the-badge"></a>
  <a href="https://github.com/SIRTHEO/claude-switch"><img alt="stars" src="https://img.shields.io/github/stars/sirtheo/claude-switch?style=for-the-badge&color=f0b429"></a>
</p>

```bash
npm install -g @sirtheo/claude-switch && claude switch setup
```

[**🚀 Install**](#-install) · [**✨ Features**](#-features) · [**🪟 Profiles**](#-run-two-claude-accounts-in-parallel) · [**❓ FAQ**](#-faq) · [**⭐ Star it**](https://github.com/SIRTHEO/claude-switch)

<img src="docs/images/dashboard.gif" alt="claude-switch dashboard — multi-account TUI with usage glyphs" width="900" />

</div>

> [!NOTE]
> 🟢 **Anthropic [issue #24963](https://github.com/anthropics/claude-code/issues/24963)** — *"[FEATURE] Support for multiple accounts / profiles"* — is open and unshipped. **claude-switch already solves it**, today, without modifying the official `claude` binary. If you found this repo because that issue brought you here: you're in the right place.

**In 10 seconds:**

- 🪄 **You keep typing `claude`.** We install our binary as `claude` and forward everything to the real Claude Code, except `claude switch` — that's our dashboard.
- 🔋 **Hit your Max 5h cap?** claude-switch can fail over to your Anthropic API key automatically and **flip back** the moment your subscription window resets.
- 🪟 **Two accounts at once?** Open one terminal as `@work`, another as `@personal`, simultaneously. No interference.

> ⭐ **If this resonates** — [a star](https://github.com/SIRTHEO/claude-switch) helps other Max users find claude-switch before their next 5-hour wall.

---

## 😩 The pain

> [!TIP]
> **You have a Claude Max account, a work Claude account, and an Anthropic API key.**
> Claude Code only knows **one at a time**.
>
> The official answer is `claude logout` → browser → `claude login` → re-auth, every single time. The DIY answers (shell aliases per account, swapping `~/.claude.json` by hand, juggling `CLAUDE_CONFIG_DIR` in `.zshrc`) all push you off the `claude` command itself. **You stop using your muscle memory.** That's the wrong direction.

## ✅ The fix

**claude-switch installs itself *as* `claude`.** Your muscle memory stays. The original binary is still there, untouched — claude-switch just adds **one** subcommand: `claude switch`.

```bash
claude                 # works exactly like before — uses your active account
claude switch          # interactive dashboard: pick account, hit ↵, you're in
claude switch work     # one-shot: flip to "work" and you're done
```

That's the whole API. Nothing else to memorize.

|  | What you get on top |
|---|---|
| ⚡ | **Sub-second account switch** — no browser, no re-login |
| 🔋 | **Bypass Max & Pro rate limits** — auto-fallback to your API key, **auto-revert** when the window resets |
| 🪟 | **Two accounts, two terminals, same machine** — isolated profiles, zero interference |
| 🔐 | **Zero telemetry, zero analytics** — credentials in your OS keychain, atomic writes, no `postinstall` |
| 🎯 | **Project-aware routing** — drop a `.claude-switch` in the repo and `claude` automatically picks the right account based on `cwd`. [See below.](#-project-aware-routing--never-claude-switch-again) |
| 🔔 | **Update notifier** — checks npm once a day, prompts you on the next interactive `claude switch`. **Never installs silently.** No telemetry sent — only the registry version check. |

---

## 🎯 Project-aware routing — never `claude switch` again

> [!TIP]
> The README promised *"keep typing `claude`"*. With routing, that's now **literal**: you stop running `claude switch` entirely. The right account is selected from the directory you're in.

The pain it kills:

> *"I `cd`'d into the work repo, typed `claude`, did half a session, and only then noticed the banner said `🔑 personal@gmail.com` — I'd been burning personal quota on a work task."*

Two ways to set it up. Pick whichever fits.

### A. Per-repo, committable: `.claude-switch`

Drop a file at the repo root:

```json
{ "match": { "emailDomain": "acme.com" } }
```

Commit it. From now on, every teammate that `cd`s into this repo and runs `claude` is auto-routed to **whichever of their saved accounts** has an `@acme.com` email. The committed file expresses a **constraint** (any acme account), not a specific identity — so it works regardless of how each teammate aliased their accounts locally.

The flow:

```bash
$ cd ~/work/payroll-service
$ claude "refactor the auth middleware"
🎯 routed to theo@acme.com via .claude-switch (repo requires @acme.com)
🔑 theo@acme.com

… session runs as @acme, not @gmail …
```

Don't have a matching account saved? You get a **warning, not a crash** — `claude` falls back to your active account so the session still runs, but the banner makes the misalignment obvious before you waste a turn:

```
⚠ this repo expects @acme.com — no saved account matches.
  Run: claude switch add. Falling back to active: personal@gmail.com
```

### B. Per-machine, gitignored: `claude switch route`

For routing rules that are **yours**, not the team's — global glob → account map:

```bash
claude switch route add  '~/work/**'      work@acme.com
claude switch route add  '~/clients/foo/**'  foobar          # alias works too
claude switch route list
claude switch route test ~/work/payroll-service              # debug: dry-run
claude switch route remove '~/clients/foo/**'
```

Stored in `~/.claude/accounts/.routing.json`, never committed.

### Override knobs

| Want | How |
|---|---|
| One-off run as a different account | `claude --as personal "..."` *(unchanged)* |
| Global override for one shell | `CLAUDE_SWITCH_ACCOUNT=work claude` |
| Disable routing for a specific repo | `.claude-switch` with `{ "match": { "disable": true } }` |
| Stay in your own profile, ignore routing | Already-set `CLAUDE_CONFIG_DIR` is respected — routing skips |
| Keep the account always isolated | Mark it `defaultIsolated: true` in Settings — routing won't flip global, it points you at the profile flow instead |

### Resolution order

`CLAUDE_SWITCH_ACCOUNT` env > `.claude-switch` in the repo (walk-up bounded by `.git/`) > `.routing.json` global rules > active account *(today's behavior)*.

When routing has no opinion, behavior is **identical** to without routing. Don't create either file → nothing changes.

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
> **Already installed?** Since v2.8 claude-switch checks for new versions in the background once a day and offers a one-keypress install on your next interactive `claude switch` invocation. Or run `claude switch update` whenever you want — nothing is ever installed without your `y`.

---

## ✨ Features

### 🪄 Drop-in wrapper — `claude` is still `claude`

claude-switch ships its `bin` as `claude`. After install, your existing scripts, IDE integrations, shell history, and aliases keep working untouched. We delegate every unknown subcommand straight to the real Claude Code binary. The **only** new word in your vocabulary is `switch`.

```bash
claude --version       # → real Claude Code, just as before
claude switch          # → our dashboard
claude --as work "…"   # → run a one-shot as a different account
```

---

### 🔁 Sub-second account switching

Type `claude switch`. Highlight a row. Hit `Enter`. Done.

<img src="docs/images/switch.gif" alt="claude switch dashboard — highlight a row, press Enter, the active account flips" width="800" />

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

<img src="docs/images/profiles.gif" alt="claude switch dashboard → press p → Profiles screen for per-terminal isolated sessions" width="800" />

| You want | Use |
|---|---|
| Switch the active account globally | `claude switch <account>` |
| One terminal on X, others on Y | **Profiles → Open account isolated** |
| Run a single command as another account | `claude --as <alias> "<task>"` |

---

## ⚖️ How it compares

|  | **claude-switch** | `claude logout` + browser | manual `~/.claude.json` swap | shell aliases + `CLAUDE_CONFIG_DIR` |
|---|:---:|:---:|:---:|:---:|
| 🧠 Command you type | **`claude`** *(unchanged)* | `claude` | `claude` | new alias per account |
| ⏱ Switch time | **< 1 sec** | 30–60 sec | seconds (risky) | seconds |
| 🎯 Auto-routes by `cwd` (repo-aware) | ✅ `.claude-switch` + global rules | 🚫 | 🚫 | 🚫 |
| 👥 Multiple accounts | ✅ unlimited | 🚫 one at a time | ⚠️ manual | ✅ |
| 🔋 API-key fallback + auto-revert | ✅ | 🚫 | 🚫 | 🚫 |
| 🪟 Parallel terminal sessions | ✅ profiles | 🚫 | 🚫 | ✅ *(if hand-rolled)* |
| 📊 Live usage in statusline | ✅ | 🚫 | 🚫 | 🚫 |
| 💥 Risk of corrupting credentials | none — atomic writes | n/a | high | medium |
| 🛡 Telemetry | **none** | n/a | n/a | n/a |
| 🔧 `postinstall` scripts | **none** | n/a | n/a | n/a |

> The differentiator isn't "we switch accounts" — `CLAUDE_CONFIG_DIR` + shell aliases can do that too. It's that **claude-switch disappears into `claude` itself**, with safe writes, fallback, profiles and live usage on top, so you're not maintaining your own homemade tool.

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
| Unsure if claude is being billed via API key (not OAuth) | See [SECURITY.md — Silent API-key risk](SECURITY.md#silent-api-key-risk-claudejson-snapshot-leak): 3 jq commands to verify and the Phase 14.2 / 14.3 mitigations |
| Anything else | [Open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) |

---

## 📦 What's new

- **v3.5.x** *(upcoming)* — 🎯 **Project-aware routing.** `.claude-switch` per-repo + `claude switch route` global rules pick the right account from `cwd`.
- **v3.4.x** — 🔐 **API keys in macOS Keychain.** Plus unified ephemeral state with on-read migration.
- **v3.3.x** — 🔁 **Live OAuth ↔ API transitions.** Per-account `authMode`, swap modes without re-launching.
- **v3.2.x** — 🪶 **`auto-revert`** renamed from `fallback auto` (legacy alias preserved).
- **v3.1.x** — 🎨 **Ink TUI rebuild.** Three-section dashboard, configurable smart defaults.
- **v2.8.x** — 🔔 **Update notifier** — daily npm version check + opt-in 1-keypress install on `claude switch`.
- **v2.7.x** — 🪟 **Profiles** — parallel sessions on one machine.

📄 Full changelog: [`CHANGELOG.md`](CHANGELOG.md)

---

## 🤝 Contributing & license

PRs welcome — see [`CONTRIBUTING.md`](.github/CONTRIBUTING.md). Licensed under [**MIT**](LICENSE).

---

## ⚖️ Trademark notice

**claude-switch is an independent, community-built tool. It is not affiliated with, endorsed by, sponsored by, or in any way officially connected to Anthropic, PBC.**

"Claude" and "Claude Code" are trademarks of Anthropic, PBC. The names are used here in a strictly nominative/descriptive sense to indicate compatibility with the Claude Code CLI — this project does not redistribute, modify, or proxy Anthropic software or services. All credentials and API traffic stay between the user and Anthropic.

For Anthropic's official products visit [anthropic.com](https://www.anthropic.com) and [claude.com/claude-code](https://www.claude.com/claude-code).

---

<div align="center">

### Stop alt-tabbing to a browser. Stop memorizing wrapper commands.

### Keep typing `claude`. We'll handle the rest.

### ⭐ [**Star it on GitHub**](https://github.com/SIRTHEO/claude-switch)

```bash
npm install -g @sirtheo/claude-switch
```

<sub><b>Keywords</b> — claude code profile · claude code profiles · claude --profile · claude code multi account · claude account switcher · claude code login switch · claude code work personal · claude max 5h limit · claude weekly limit · anthropic oauth switcher · CLAUDE_CONFIG_DIR · claude isolated session · claude code parallel sessions · anthropic api key fallback · drop-in claude wrapper · project-aware account routing · cwd-based claude switch · .claude-switch repo file · automatic account selection</sub>

</div>
