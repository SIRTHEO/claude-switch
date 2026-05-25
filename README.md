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

The hidden gem. Run `@work` in Terminal A and `@personal` in Terminal B **at the same time**, fully isolated. Each profile gets its own `CLAUDE_CONFIG_DIR`, dedicated `.credentials.json`, and separate session history. No interference, no copy-pasting tokens.

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

> 💡 **Tip** — **Already installed?** claude-switch checks for new versions in the background once a day and offers a one-keypress install on your next `claude switch`. Or run `claude switch update`. Nothing is ever installed without your `y`.

---

## ✨ Features

### 🪄 Drop-in wrapper

`claude` is still `claude`. claude-switch ships its `bin` as `claude`, so your existing scripts, IDE integrations, shell history and aliases keep working untouched. Unknown subcommands forward straight to the real Claude Code binary. The **only** new word in your vocabulary is `switch`.

```bash
claude --version       # → real Claude Code, just as before
claude switch          # → our dashboard
claude --as work "…"   # → run a one-shot as a different account
```

---

### 🔁 Sub-second account switching

Type `claude switch`. Highlight a row. Hit `Enter`. Done.

<img src="docs/images/switch.gif" alt="claude switch dashboard — highlight a row, press Enter, the active account flips" width="800" />

- ⚡ **Atomic swap** of OAuth token + active account in `~/.claude.json`, protected by a file lock so two terminals can't race.
- 🌐 **No browser.** Tokens in a `0600` file vault (`~/.claude/.credentials.json`), every platform.
- 🔄 **No logout/login loop.** The next session simply starts as the new account.

---

### 🔋 Rate-limit bypass with auto-revert

Stop losing 5 hours of momentum to the Max cap.

- 🎚 **Per-account fallback.** Each account has its own Anthropic API key, stored `0600` in `~/.claude-switch/apikeys.json`.
- 🚦 **Auto-engage thresholds.** Switches to API key at ≥95% on 5h or 7d window.
- ↩️ **Auto-revert.** When both windows drop back below 80%, you're back on OAuth.
- 🔥 **Burst mode.** After 3 consecutive OAuth failures, the proxy goes API-first until the next probe succeeds.

```text
📈 Subscription back online (5h:30%, 7d:15%) — switched back to OAuth
```

**No external relay.** A local HTTP proxy starts on a loopback port, sets `ANTHROPIC_BASE_URL`, and terminates when `claude` exits. Your traffic goes straight to Anthropic.

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

Resolution order: `CLAUDE_SWITCH_ACCOUNT` env > `.claude-switch` > `.routing.json` > active.

---

### 💾 Cache-health monitor

Your Max/Pro plan is draining 3× faster than it should? You're probably hitting [Anthropic's documented billing bugs](#-why-is-my-maxpro-plan-exhausting-faster-than-expected), not a usage problem.

```bash
claude switch statusline install     # live 💾 N% 🚨X badge in Claude Code statusline
claude switch cache-health           # CLI report: turns, hit ratio, flush count, billed tokens
```

A high flush count (>2-3 in a short session) is the signal that the word-substitution cache-flush bug is active. File the JSONL as evidence on the upstream Anthropic thread.

The same badge doubles as a **live usage gauge** — discreet, turns **yellow at 75%** and **red at 90%**, so a rate limit never ambushes you. You see *why* your plan is draining, not just *that* it is.

---

### 🎛 Built on Ink, a real TUI

Full **React-for-the-terminal** UI: focus rings, live updates, hotkeys, in-place re-renders. `Tab` cycles sections, `↑↓` navigates, single-letter keys (`a` `k` `f` `c` `g` `p`…) are accelerators, `?` for inline help.

Plus: tab completion (`bash` · `zsh` · `fish` · `powershell`), one-shot `claude --as <alias> "task"`, cross-platform CI on Linux + macOS + Windows × Node 20/22/24.

---

## 🔐 Security model

Narrow and worth stating clearly so you can decide whether claude-switch fits your environment.

### What is protected ✅

- **Atomic, symlink-safe writes.** Every credential file is written to `<file>.tmp` with mode `0600` *before* `rename`. On POSIX the temp file is opened with `O_CREAT|O_EXCL`, so a symlink pre-planted at the `.tmp` path **cannot** redirect the write to an attacker-controlled location. A crash mid-write cannot corrupt the existing snapshot or leave a world-readable temp file. (`src/platform/atomic-write.ts`)
- **Single-writer lock.** Every account swap and fallback flip is wrapped in `withLock(accountsDirPath)`. Two terminals running `claude switch` simultaneously serialize on a `.lock` file with PID + 30s stale reclaim. (`src/platform/lock.ts`)
- **File-based credential vault (`0600`, every platform).** OAuth tokens land in `~/.claude/.credentials.json` — the file Claude Code itself reads when no Keychain item is present. Per-profile tokens live in `<CLAUDE_CONFIG_DIR>/.credentials.json`; per-account archives in `~/.claude/accounts/<email>.json` (`_keychain` block); registered API keys in `~/.claude-switch/apikeys.json`. All written via the atomic, symlink-safe path above, mode `0600`, parent dir `0700`. Token values are never embedded in error messages. (`src/credentials/file-credential-store.ts`)
- **No password dialogs.** claude-switch never invokes the macOS `security` binary in the swap/read path, so macOS never prompts. This replaced the Keychain integration (and its partition-list prompts) in v4.0.0. On macOS a reconcile step drains Claude Code's own Keychain item into the file vault and removes it, so the binary reads our file from then on. (`src/credentials/keychain-reconcile.ts`)
- **Credential-write rollback.** If the vault write fails *after* `~/.claude.json` was already rewritten, the JSON is rolled back to its pre-switch state so the snapshot and the vault can't drift out of sync. (`src/accounts/accounts.ts`)
- **Silent-billing defense.** If `~/.claude.json` carries an `apiKey` field claude-switch doesn't track, a one-time stderr banner warns you on the next `claude` run, *then* the key is purged on the next switch. (See [SECURITY.md](SECURITY.md#silent-api-key-risk-claudejson-snapshot-leak).)
- **No telemetry, no `postinstall`, no external relay.** Outbound traffic: Anthropic API, Anthropic OAuth refresh, npm registry update check. Source is open: `grep -r 'https' src/` and verify.

### What is **not** protected ⚠️

We're being explicit so you can decide.

- **Tokens at rest are plaintext (`0600`), every platform.** OAuth tokens, refresh tokens and API keys live in `0600`-permissioned JSON under `~/.claude/` and `~/.claude-switch/`. Anyone who can read your home directory **as your user** can read them. This is the same model as `gh`, `aws`, `npm` and `docker` CLIs, and the same exposure surface as Claude Code itself (which reads `~/.claude/.credentials.json`). We protect against backup/sync leakage only insofar as file permissions are honoured; we do **not** protect against a malicious process running as your own user. Optional encryption-at-rest (machine-bound key) is under evaluation.
- **Refresh-token drift across switches.** The official `claude` binary may rotate the OAuth refresh token mid-session. claude-switch syncs the latest credentials back to the snapshot on every interaction (best-effort `syncActiveSnapshotIfStale` + `captureLiveCredentialsForActiveAccount`). Worst case (concurrent rotation across two terminals): the swapped-away snapshot lags one rotation; the next switch back triggers a refresh, in the rare edge case a re-login. **No data corruption.** This is the structural trade-off of the swap approach vs. fully-isolated `CLAUDE_CONFIG_DIR` per account. We chose swap because it preserves your shared `~/.claude.json` history.
- **Fallback proxy on loopback — browser/cross-origin defence, residual same-user risk.** During a `claude` session the proxy listens on `127.0.0.1:<random-port>`. It rejects requests with an `Origin` header set (every browser cross-origin fetch carries one) and requests whose `Host` header doesn't match the loopback bind (defence against DNS-rebinding sites that resolve their domain to `127.0.0.1`). What remains is the same-user threat: any local process that mimics the `claude` CLI exactly (no `Origin`, correct `Host`) can still reach the proxy. The proxy caps request bodies at **32 MB** (`413` past that). Don't run untrusted code as your user during a session. Same advice as any local dev server.

**Reporting a vulnerability**: [GitHub Security Advisory](https://github.com/SIRTHEO/claude-switch/security/advisories/new). Full policy in [`SECURITY.md`](SECURITY.md).

---

## 📉 Why is my Max/Pro plan exhausting faster than expected?

Not a claude-switch bug. Known issues in the Claude Code client / Anthropic billing pipeline (community-investigated Dec 2025 – Jan 2026):

- **Word-substitution cache flush (10-20× cost amplification).** Cache invalidates per turn under certain conditions; full prompt re-sent and re-billed. POC: [cc-cache-monitor](https://github.com/AlexZan/cc-cache-monitor).
- **`--resume` / `--continue` invalidate cache on turn 1.** Resumed sessions get billed at full price for the first turn even though context already existed.
- **Telemetry coupling.** Claude Code's 1-hour cache TTL is silently tied to telemetry opt-in. Disabling telemetry drops the TTL and degrades cache reuse.
- **Peak-hour throttling, ≈13:00-19:00 UTC.** Anthropic confirmed (after press contact) that subscription inference is throttled in this window.

**Mitigations you can apply:** avoid `--resume`/`--continue`; avoid peak-hour for long sessions; one session at a time per account; keep telemetry enabled (yes, really).

**Detect with claude-switch:** `claude switch cache-health` for the active session, or `--session <jsonl-path>` for any historical file. A high flush count is the signal. File the JSONL upstream as evidence.

---

## 🛠 Troubleshooting

| Symptom | Fix |
|---|---|
| `claude` not found after install | Open a new terminal. Still broken: `claude switch setup` |
| `Token: ✗ expired` in the dashboard | Highlight the row, press `c` (re-authenticate) |
| Swap says "no saved credentials" / statusline numbers look frozen | Run `claude switch doctor` to diagnose (token collision, rate-limited cache), then `claude switch doctor --fix` and re-login the affected account |
| Fallback on but Claude still uses OAuth | First time Claude Code sees a new key it asks `Use this API key? [y/N]`, press **y** |
| Usage stats show nothing | Available for Max/Pro subscribers only |
| Unsure whether claude is billed via OAuth or API key | [SECURITY.md, Silent API-key risk](SECURITY.md#silent-api-key-risk-claudejson-snapshot-leak): 3 `jq` commands to verify |
| macOS used to ask for the keychain password on every `claude switch` | Fixed in v4.0.0 — credentials moved to a `0600` file vault. On macOS claude-switch drains Claude Code's Keychain item into the vault and deletes it, silently while the login keychain is unlocked (a locked keychain prompts once). No more `setup-keychain` command. |
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

It writes the same files Claude Code itself writes. It does not modify the `claude` binary. Writes are atomic, lock-protected. ~40 KB of compiled JS, Apache-2.0-licensed, no `postinstall`. Worst case if something breaks: re-login.
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

(1) IDE integrations and CI scripts already invoke `claude`. Changing them every time you add a tool is friction. (2) Your shell history of `claude …` invocations stays runnable. (3) `claude switch setup` records the absolute path of the real binary on install so `PATH` ordering stays correct.
</details>

<details>
<summary><b>My API-key fallback didn't kick in mid-session.</b></summary>

Fallback injects `ANTHROPIC_BASE_URL` into the env of the `claude` process at spawn. A REPL already running can't be hot-swapped. Exit it, turn fallback on, re-run `claude`.
</details>

<details>
<summary><b>Will this break when Anthropic ships native multi-account?</b></summary>

If/when [#24963](https://github.com/anthropics/claude-code/issues/24963) ships, the wrapper layer stays useful for things outside multi-account: API-key fallback, project-aware routing, cache-health. If first-party support obviates the swap layer entirely, we'll deprecate that path and keep the rest.
</details>

---

## 📦 What's new

- **v4.0.0** — 🔐 **File-vault credential storage** replaces the macOS Keychain integration: `0600` JSON on every platform, **no more password dialogs** on swap. On macOS a reconcile step drains Claude Code's own Keychain item into the vault. 🩺 New **`claude switch doctor`** health check (`--fix`) for credential-store problems. Honest threat model in SECURITY.md. **Breaking**: `setup-keychain` command removed; first run after upgrade migrates your existing Keychain credentials automatically.
- **v3.8.x** — 🔌 **`--json` contract** on `list`, `profile list`, `route test`, `alias-list`, fallback status (stable machine-readable output). 🪟 Per-profile launch in any detected terminal emulator. 📊 Per-account usage refresh for any saved account + embedded statusline format. 🔐 atomic-write symlink-safety hardening.
- **v3.7.x** — 🪟 **Profile fresh-install fix**: `claude switch profile use <name>` now enters the REPL directly with stored credentials on Claude Code 2.x. Auto-propagated Keychain ACL + `hasCompletedOnboarding` + statusline config on import.
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
