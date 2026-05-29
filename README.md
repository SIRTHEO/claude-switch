  <div align="center">

<img src="docs/images/mark.svg" alt="claude-switch — multi-account manager for Claude Code" width="540"/>

### Bypass Claude Max rate limits. Auto-fallback to your API key. Auto-revert when the window resets.

**Drop-in for Claude Code: keep typing `claude`, never wait 5 hours again. Multi-account aware. No new CLI to learn, no aliases, no shell hacks.**

**macOS · Linux · Windows**

<p>
  <a href="https://www.npmjs.com/package/@sirtheo/claude-switch"><img alt="npm" src="https://img.shields.io/npm/v/@sirtheo/claude-switch?color=f0b429&label=npm&style=for-the-badge"></a>
  <a href="https://github.com/SIRTHEO/claude-switch/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/SIRTHEO/claude-switch/ci.yml?branch=main&label=CI&style=for-the-badge&color=3fb950"></a>
  <a href="https://www.npmjs.com/package/@sirtheo/claude-switch"><img alt="downloads" src="https://img.shields.io/npm/dm/@sirtheo/claude-switch?color=3fb950&style=for-the-badge"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-79c0ff?style=for-the-badge"></a>
  <a href="https://github.com/SIRTHEO/claude-switch"><img alt="stars" src="https://img.shields.io/github/stars/sirtheo/claude-switch?style=for-the-badge&color=f0b429"></a>
</p>

```bash
npm install -g @sirtheo/claude-switch && claude switch setup
```

[**🚀 Install**](#-install) · [**✨ Features**](#-features) · [**🔐 Security**](#-security-model) · [**❓ FAQ**](#-faq) · [**⭐ Star it**](https://github.com/SIRTHEO/claude-switch)

<img src="docs/images/dashboard.gif" alt="claude-switch dashboard — multi-account TUI with usage glyphs" width="800" />

</div>

**In 10 seconds:**

- 🪄 **You keep typing `claude`.** We install our binary *as* `claude` and forward everything to the real Claude Code, except `claude switch`, our dashboard.
- 🔋 **Hit your Max 5h cap?** claude-switch fails over to your Anthropic API key automatically, and **flips back** the moment the window resets.
- 🪟 **Two accounts at the same time?** One terminal as `@work`, another as `@personal`. Isolated profiles, zero interference. [Jump to the 3-command setup ↓](#-two-terminals-two-accounts)
- 🎯 **`cd` into your work repo, type `claude`** and it auto-routes to your work account. Drop a `.claude-switch` file in the repo, your team does the same.

> 🟢 **Note** — **Anthropic [issue #24963](https://github.com/anthropics/claude-code/issues/24963)** ([FEATURE] Support for multiple accounts / profiles) is open and unshipped. **claude-switch already solves it**, today, without modifying the official `claude` binary.

> 💬 **Feedback, bugs, ideas, requests?** [Open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose), start a [discussion](https://github.com/SIRTHEO/claude-switch/discussions), or ping **`sirtheo`** on Discord. I read everything.

> ⭐ **Find this useful?** [A star](https://github.com/SIRTHEO/claude-switch) helps other Max users find it before their next 5-hour wall.

---

## 😩 The pain

> **You have a Claude Max, a work Claude account, and an Anthropic API key.**
> Claude Code knows about **one at a time**.
>
> The official fix is `claude logout` → browser → `claude login`, every single time. The DIY fixes (shell aliases per account, swapping `~/.claude.json` by hand, juggling `CLAUDE_CONFIG_DIR` in `.zshrc`) push you off the `claude` command itself. **You lose your muscle memory.**

## ✅ The fix

**claude-switch installs itself *as* `claude`.** Your muscle memory stays. The original binary is still there, untouched. claude-switch just adds **one** subcommand: `claude switch`.

```bash
claude                 # works exactly like before, uses your active account
claude switch          # interactive dashboard: pick account, hit ↵
claude switch work     # one-shot: flip to "work" and you're done
```

That's the whole API. Nothing else to memorize.

|  | What you get on top |
|---|---|
| ⚡ | **Sub-second account switch.** No browser, no re-login. |
| 🔋 | **Bypass Max & Pro rate limits.** Auto-fallback to your API key, **auto-revert** when the window resets. |
| 🪟 | **Two accounts, two terminals, same machine.** Isolated profiles, zero interference. |
| 🎯 | **Project-aware routing.** Drop a `.claude-switch` in the repo, `claude` picks the right account based on `cwd`. |
| 💾 | **Cache-health monitor.** Detect Anthropic billing bugs (cache flushes, `--resume` cost amplification) in real time. |
| 🩺 | **`doctor` health check.** One command surfaces credential-store problems (token collisions, stale usage cache) and `--fix` repairs them. |
| 🔐 | **Zero telemetry.** Credentials in a `0600` file vault (no password dialogs), atomic symlink-safe writes, no `postinstall`. |

---

## 🪟 Two terminals, two accounts

The hidden gem. Run `@work` in Terminal A and `@personal` in Terminal B **at the same time**, fully separate. Each one keeps its own login and its own session history, so they never get in each other's way — no copy-pasting tokens between windows.

**One-time setup** (per account):

```bash
# bring an existing saved account into an isolated profile (macOS, no browser)
claude switch profile import work@acme.com --as work
claude switch profile import you@gmail.com --as personal

# or create a fresh profile and authenticate via browser
claude switch profile create work && claude switch profile login work
```

**Daily use** (one command per terminal):

```bash
# Terminal A
claude switch profile use work

# Terminal B (separate, simultaneous)
claude switch profile use personal
```

Or pick from the menu: `claude switch` → `p` → `Profiles → Open account isolated`.

<img src="docs/images/profiles.gif" alt="claude switch dashboard → press p → Profiles screen for per-terminal isolated sessions" width="800" />

---

## 🚀 Install

> ❗ **Important** — Requires **Node.js 20.12+** and Claude Code already installed.

```bash
npm install -g @sirtheo/claude-switch
claude switch setup
```

Then **open a new terminal** (the old one has a stale `PATH`) and verify:

```bash
claude switch --version
```

> 💡 **Tip** — **Already installed?** claude-switch checks for new versions in the background once a day and offers a one-keypress install on your next `claude` run. A release that fixes a security or data-loss bug is flagged with a louder notice so you don't miss it. Or run `claude switch update`. Nothing is ever installed without your `y`. Set `CLAUDE_SWITCH_NO_UPDATE_CHECK=1` (or run in CI) to silence the check entirely.

---

## ✨ Features

### 🪄 Drop-in wrapper

`claude` is still `claude`. claude-switch installs itself under the same name, so your existing scripts, editor integrations, shell history and aliases all keep working untouched. Anything that isn't `claude switch` is passed straight through to the real Claude Code. The **only** new word to learn is `switch`.

```bash
claude --version       # → real Claude Code, just as before
claude switch          # → our dashboard
claude --as work "…"   # → run a one-shot as a different account
```

---

### 🔁 Sub-second account switching

Type `claude switch`. Highlight a row. Hit `Enter`. Done.

<img src="docs/images/switch.gif" alt="claude switch dashboard — highlight a row, press Enter, the active account flips" width="800" />

- ⚡ **Instant swap.** Changing account takes under a second, and a lock keeps two terminals from clashing if they both switch at once.
- 🌐 **No browser.** Your logins are kept in a private vault on disk that only your own user can read — on every platform.
- 🔄 **No logout/login loop.** Your next session just starts as the new account.

---

### 🔋 Rate-limit bypass with auto-revert

Stop losing 5 hours of momentum to the Max cap.

- 🎚 **Per-account API key.** Each account can have its own Anthropic API key, kept in a private file only your own user can read.
- 🚦 **Auto-engage.** Once you've used **95%** of either your 5-hour or 7-day allowance, it switches over to the API key on its own.
- ↩️ **Auto-revert.** When both allowances drop back under **80%**, you're put back on your subscription.
- 🔥 **Burst mode.** If **3** subscription requests fail in a row, it leans on the API key until the subscription starts working again.

```text
📈 Subscription back online (5h:30%, 7d:15%) — switched back to OAuth
```

**Nothing sits in the middle.** A small helper runs only on your own computer while `claude` is open, and shuts down the moment you quit. Your traffic still goes straight to Anthropic — claude-switch never relays it through anywhere else.

---

### 🎯 Project-aware routing

Never `claude switch` again. The pain it kills:

> *"I `cd`'d into the work repo, typed `claude`, did half a session, and only then noticed the banner said `🔑 personal@gmail.com`. I'd been burning personal quota on a work task."*

**Per-repo, committable.** Drop a `.claude-switch` at the repo root:

```json
{ "match": { "emailDomain": "acme.com" } }
```

Commit it. Every teammate who `cd`s in and runs `claude` is routed to **whichever of their saved accounts** has an `@acme.com` email. The file expresses a **constraint** (any acme account), not a specific identity. Works regardless of how teammates aliased their accounts locally.

```bash
$ cd ~/work/payroll-service
$ claude "refactor the auth middleware"
🎯 routed to theo@acme.com via .claude-switch (repo requires @acme.com)
🔑 theo@acme.com
```

No match? Warning, not a crash. Falls back to active account, banner makes the misalignment obvious.

**Per-machine** (gitignored, in `~/.claude/accounts/.routing.json`):

```bash
claude switch route add  '~/work/**'        work@acme.com
claude switch route add  '~/clients/foo/**' foobar
claude switch route test ~/work/payroll-service     # dry-run
```

Order of priority (first match wins): a one-off `CLAUDE_SWITCH_ACCOUNT` override you set in your shell → the repo's `.claude-switch` file → your personal per-folder rules → your currently active account.

---

### 💾 Cache-health monitor

Your Max/Pro plan is draining 3× faster than it should? You're probably hitting [Anthropic's documented billing bugs](#-why-is-my-maxpro-plan-exhausting-faster-than-expected), not a usage problem.

```bash
claude switch statusline install     # live 💾 N% 🚨X badge in Claude Code statusline
claude switch cache-health           # CLI report: turns, hit ratio, flush count, billed tokens
```

If the "context wiped" count is high (more than 2–3 in a short session), that bug is active and draining your plan. Save the session file and attach it as evidence on the Anthropic issue thread.

The same badge doubles as a **live usage gauge** — discreet, turns **yellow at 75%** and **red at 90%**, so a rate limit never ambushes you. You see *why* your plan is draining, not just *that* it is.

---

### 🎛 A real interactive dashboard

Not a wall of text — a proper interactive screen right in your terminal: live updates, highlighted rows, keyboard shortcuts. `Tab` moves between sections, `↑↓` navigates, single letters (`a` `k` `f` `c` `g` `p`…) are shortcuts, and `?` shows inline help.

Plus: tab-completion for `bash`, `zsh`, `fish` and `powershell`; a one-shot `claude --as <alias> "task"`; and it's tested on Linux, macOS and Windows across Node 20, 22 and 24.

---

## 🔐 Security model

Narrow and worth stating clearly so you can decide whether claude-switch fits your environment.

### What is protected ✅

- **Your login is saved safely, all-or-nothing.** When claude-switch saves your credentials, it writes them to the side first and only then swaps them into place. If your computer crashes mid-save, your existing login stays intact — you never end up with a half-written or corrupted token, and no readable leftover is left behind. It also can't be tricked into writing your token somewhere it shouldn't go.
- **Two windows can't trip over each other.** Every account switch takes a short turn-based lock, so two terminals doing it at the same moment line up instead of clashing. If a window dies holding the lock, it's released automatically after about 30 seconds.
- **Credentials sit in a private vault only you can open.** They're stored in files your operating system marks as readable by *your user account only* — the same place Claude Code itself reads from. This works the same way on macOS, Linux and Windows. Your token is never printed inside an error message.
- **No password pop-ups.** Since v4.0.0, claude-switch no longer uses the macOS keychain, so macOS doesn't ask for your password every time you switch. The first time you run it after upgrading, it quietly moves your existing credentials into the vault for you.
- **If a save goes wrong, it undoes itself.** If anything fails partway through a switch, claude-switch puts things back exactly as they were, so your account and your saved login can never fall out of sync.
- **It warns you about surprise billing.** If your config ends up holding an API key that claude-switch isn't managing (which could quietly bill you per-use), it shows a one-time warning and then removes that key on the next switch. ([Details in SECURITY.md.](SECURITY.md#silent-api-key-risk-claudejson-snapshot-leak))
- **No tracking, no hidden scripts.** claude-switch sends no analytics and runs nothing behind your back at install time. The only outbound connections are your normal traffic to Anthropic, the routine login-refresh, and a once-a-day check for updates. The code is open — you can read it.

### What is **not** protected ⚠️

We'd rather tell you straight, so you can decide if it fits you.

- **Your saved credentials are not encrypted.** They're stored in files only your user account can read, but they are *not* scrambled. Anyone who can already use your computer **as you** can read them. This is exactly how other well-known tools store credentials (GitHub's, Amazon's, npm's, Docker's) and how Claude Code itself does it. We don't defend against a malicious program that's *already* running as you on your machine. Encrypting them with a key tied to your specific computer is something we're still considering — it isn't done yet. **This is the one real limitation still open.**
- **Switching accounts in two windows at the exact same instant.** Claude occasionally refreshes your login token in the background. claude-switch keeps the saved copy up to date on every use. In the rare case where two terminals refresh at the very same moment, the account you switched *away* from can lag by one refresh — when you switch back it simply refreshes again (very rarely, a quick re-login). **Nothing is ever lost or corrupted.** It's the trade-off we accept so your accounts can share one history instead of being walled off from each other.
- **The local helper that powers fallback — defended, with one residual.** While `claude` is running, claude-switch starts a small helper that listens only on your own computer. It already blocks web browsers and common network tricks from reaching it, and limits how large a request can be. What it *can't* stop is another program running as you, on your own machine, that perfectly imitates `claude` — that one could still reach it. The advice is the same as for any local tool: don't run code you don't trust while you're in a session.

**Reporting a vulnerability**: [GitHub Security Advisory](https://github.com/SIRTHEO/claude-switch/security/advisories/new). Full policy in [`SECURITY.md`](SECURITY.md).

---

## 📉 Why is my Max/Pro plan exhausting faster than expected?

Not a claude-switch bug. Known issues in the Claude Code client / Anthropic billing pipeline (community-investigated Dec 2025 – Jan 2026):

- **Saved context wiped mid-chat (10–20× more expensive).** Under certain conditions Claude Code throws away the context it already paid to cache, every turn — so your whole prompt is re-sent and re-billed. POC: [cc-cache-monitor](https://github.com/AlexZan/cc-cache-monitor).
- **`--resume` / `--continue` wipe the cache on the first turn.** Resumed sessions get charged full price for that first turn even though the context already existed.
- **Telemetry coupling.** Claude Code's saved context normally lasts an hour, but that's quietly tied to having telemetry on. Turn telemetry off and it expires sooner, so you re-pay for context more often.
- **Peak-hour throttling, ≈13:00-19:00 UTC.** Anthropic confirmed (after press contact) that subscription inference is throttled in this window.

**Mitigations you can apply:** avoid `--resume`/`--continue`; avoid peak-hour for long sessions; one session at a time per account; keep telemetry enabled (yes, really).

**Spot it with claude-switch:** run `claude switch cache-health` for the current session, or add `--session <file>` to check any past session. A high "context wiped" count is the giveaway — save that session file as evidence for the Anthropic thread.

---

## 🛠 Troubleshooting

| Symptom | Fix |
|---|---|
| `claude` not found after install | Open a new terminal. Still broken: `claude switch setup` |
| `Token: ✗ expired` in the dashboard | Highlight the row, press `c` (re-authenticate) |
| Swap says "no saved credentials" / statusline numbers look frozen | Run `claude switch doctor` to find the problem (e.g. two accounts sharing a login, or a stuck usage cache), then `claude switch doctor --fix` and log in again on the affected account |
| Fallback on but Claude still uses OAuth | First time Claude Code sees a new key it asks `Use this API key? [y/N]`, press **y** |
| Usage stats show nothing | Available for Max/Pro subscribers only |
| Unsure whether claude is billed via OAuth or API key | [SECURITY.md, Silent API-key risk](SECURITY.md#silent-api-key-risk-claudejson-snapshot-leak): 3 `jq` commands to verify |
| macOS used to ask for the keychain password on every `claude switch` | Fixed in v4.0.0 — logins now live in a private file instead of the keychain. On macOS your existing keychain login is moved into that file once, quietly (only a locked keychain asks once). The old `setup-keychain` command is gone. |
| Max/Pro window exhausting faster than expected | Run `claude switch cache-health` and see [above](#-why-is-my-maxpro-plan-exhausting-faster-than-expected) |
| Anything else | [Open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose) or ping **`sirtheo`** on Discord |

---

## ❓ FAQ

<details>
<summary><b>Does claude-switch send my data anywhere?</b></summary>

**No telemetry.** Only outbound calls are Anthropic API (your traffic, direct), Anthropic OAuth refresh endpoint, and the npm registry (daily update check). Source is open, verify it.
</details>

<details>
<summary><b>Is it safe with my real Claude account?</b></summary>

It writes the same files Claude Code itself writes, and it never changes the `claude` program. Saves are done safely — all-or-nothing, and guarded so two windows can't clash. It's a small, open-source tool (Apache-2.0 licensed, about 225 KB to download) that runs nothing behind your back when you install it. Worst case if something breaks: just log in again.
</details>

<details>
<summary><b>How do I add a second account?</b></summary>

`claude switch` then press `a`. Browser opens once. Sign in. Done.
</details>

<details>
<summary><b>Switching vs profile, what's the difference?</b></summary>

| | Switching | Profile |
|---|---|---|
| Scope | Whole machine | One terminal |
| Use for | Daily account toggling | Parallel sessions |
| Affects other terminals | Yes | No |
| Shares `~/.claude.json` history | Yes | No (isolated) |
</details>

<details>
<summary><b>Why a drop-in wrapper instead of a new command?</b></summary>

(1) Your editor and CI scripts already call `claude` — having to change them all would be a pain. (2) Your old `claude …` commands in your shell history still run. (3) During setup, claude-switch remembers exactly where the real `claude` lives, so it can always hand off to it correctly.
</details>

<details>
<summary><b>My API-key fallback didn't kick in mid-session.</b></summary>

The switch to your API key is set up at the moment `claude` starts. A session that's already open can't be changed on the fly — just exit it, turn fallback on, and run `claude` again.
</details>

<details>
<summary><b>Will this break when Anthropic ships native multi-account?</b></summary>

If/when [#24963](https://github.com/anthropics/claude-code/issues/24963) ships, claude-switch is still useful for everything beyond multi-account: API-key fallback, project-aware routing and cache-health. If the built-in support makes account-swapping unnecessary, we'll retire that one piece and keep the rest.
</details>

<details>
<summary><b>How do I check what versions I have installed?</b></summary>

`claude switch versions` prints a short table with the installed and latest version for each piece (the real `claude`, `claude-switch` itself, and the optional GUI). `--json` emits a machine-readable line for the GUI to consume; `--force` bypasses the 6-hour lookup cache.

To upgrade one of them, `claude switch update <target>`:

- `claude switch update claude` — runs `claude update` (Anthropic's built-in self-updater), which handles every install path internally (brew cask, npm global, standalone binary). The detected source is shown as a label only.
- `claude switch update switch` — `npm i -g @sirtheo/claude-switch@latest`. (Same effect as bare `claude switch update`, which keeps the interactive prompt for backwards compatibility.)
- `claude switch update gui` — prints the GitHub Releases URL (the desktop app has no automated installer yet).

Add `--check` to dry-run (prints the command without executing) and `--json` for a machine-readable result.
</details>

---

## 📦 What's new

- **v4.0.0** — 🔐 **New credential vault** replaces the macOS keychain: logins are kept in a private file (readable only by your user) on every platform, with **no more password pop-ups** when you switch. On macOS your existing keychain logins are moved over for you. 🩺 New **`claude switch doctor`** check (with `--fix`) for login problems. Plainly-written threat model in SECURITY.md. **Breaking**: the `setup-keychain` command is gone; the first run after upgrading migrates your old credentials automatically.
- **v3.8.x** — 🔌 **`--json` contract** on `list`, `profile list`, `route test`, `alias-list`, fallback status (stable machine-readable output). 🪟 Per-profile launch in any detected terminal emulator. 📊 Per-account usage refresh for any saved account + embedded statusline format. 🔐 atomic-write symlink-safety hardening.
- **v3.7.x** — 🪟 **Profile fresh-install fix**: `claude switch profile use <name>` now opens straight into Claude Code with your saved login on Claude Code 2.x. Importing an account also carries over its keychain access, onboarding state and statusline config.
- **v3.5.x** — 💾 **Cache-health monitor** (live `💾 N% 🚨X` statusline + CLI report) for Anthropic billing bugs. 🎯 **Project-aware routing** (`.claude-switch` + global rules). Silent-API-key billing leak fix. Per-account usage cache.
- **v3.4.x** — 🔐 API keys in macOS Keychain. On-read state migration.
- **v3.3.x** — 🔁 Live OAuth ↔ API transitions without re-launching `claude`.
- **v3.1.x** — 🎨 Ink TUI rebuild, three-section dashboard.
- **v2.8.x** — 🔔 Daily update notifier, opt-in 1-keypress install on `claude switch`.
- **v2.7.x** — 🪟 `CLAUDE_CONFIG_DIR`-isolated profiles for parallel sessions.

Full changelog: [`CHANGELOG.md`](CHANGELOG.md)

---

## 🤝 Contributing & license

PRs welcome, see [`CONTRIBUTING.md`](.github/CONTRIBUTING.md). Feedback and ideas: [open an issue](https://github.com/SIRTHEO/claude-switch/issues/new/choose), start a [discussion](https://github.com/SIRTHEO/claude-switch/discussions), or ping **`sirtheo`** on Discord. Licensed under [**Apache-2.0**](LICENSE); see [`NOTICE`](NOTICE) for attribution and trademark terms.

---

## ⚖️ Trademark notice

**claude-switch is an independent, community-built tool. It is not affiliated with, endorsed by, sponsored by, or in any way officially connected to Anthropic, PBC.**

"Claude" and "Claude Code" are trademarks of Anthropic, PBC. The names are used here in a strictly nominative/descriptive sense to indicate compatibility with the Claude Code CLI. This project does not redistribute, modify, or proxy Anthropic software or services. All credentials and API traffic stay between the user and Anthropic.

For Anthropic's official products: [anthropic.com](https://www.anthropic.com) · [claude.com/claude-code](https://www.claude.com/claude-code).

---

<div align="center">

### Two terminals. Two accounts. One `claude` command.

```bash
npm install -g @sirtheo/claude-switch
```

### ⭐ [**Star it on GitHub**](https://github.com/SIRTHEO/claude-switch)

</div>
