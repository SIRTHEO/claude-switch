# Security policy

## Threat model

claude-switch handles credentials Anthropic considers sensitive:

- OAuth access + refresh tokens for Claude Pro / Max accounts
- Personal Anthropic API keys (`sk-ant-…`)
- Per-profile session state for parallel claude sessions

The package never sends these to a third-party. They live under
`~/.claude/` (mode `0600`) and, on macOS, in the system Keychain
under `Claude Code-credentials*`. The local fallback proxy speaks
directly to `api.anthropic.com` over TLS — no telemetry, no analytics,
no `postinstall` script.

## Silent API-key risk (claude.json snapshot leak)

### The attack path

When the Anthropic Console "extra usage" feature is enabled on an account, or when a user accepts a one-off API key prompt inside the claude binary, the claude binary writes an `apiKey` field into `~/.claude.json`. Before Phase 14.2, `accounts.save()` captured that field as `_claudeJsonApiKey` inside the per-account snapshot (`~/.claude/accounts/<email>.json`). On every subsequent `accounts.load()` (triggered by `claude switch <account>`), that key was silently re-injected back into `~/.claude.json`. The claude binary reads the field and routes all traffic through the API tier — not OAuth subscription — without any visible prompt or banner. The result is unexpected API billing even on accounts that `claude switch apikey list` reports as having no key configured.

The gap: `getApiKey(email)` reads only the claude-switch-managed store (macOS Keychain entry `claude-switch-apikey/<email>` or the `_apiKey` field in the snapshot). It does **not** read `_claudeJsonApiKey`. So the CLI confirms "no key" while the claude binary silently uses one.

### How claude-switch handles it (Phase 14.2 + 14.3)

**Phase 14.2 — automatic purge on load (v3.6.x+):** `accounts.load()` now calls `getApiKey(email)` before restoring `data.apiKey`. If no key is tracked by claude-switch, both `data.apiKey` and `data.customApiKeyResponses` are deleted from `~/.claude.json`. This closes the silent re-injection path.

**Override (one-release back-compat):** Set `CLAUDE_SWITCH_KEEP_UNTRACKED_APIKEY=1` to disable the purge. Use this only if you intentionally manage an API key outside claude-switch and want to preserve the previous behaviour. This env escape will be removed in a future release.

**Phase 14.3 — transitional warning:** `passthrough.ts` emits a stderr banner if `~/.claude.json` carries an `apiKey` that `getApiKey()` does not recognise:

```
⚠ claude-switch: ~/.claude.json carries an API key NOT tracked by claude-switch.
  claude binary may use it silently. To register it: claude switch apikey set
  To suppress billing: unset the key in Anthropic Console, then re-run claude switch.
```

This warning fires once per process and is suppressed in test mode.

### Detecting exposure (3 commands)

```bash
# 1. Does claude-switch track any key for this account?
claude switch apikey list

# 2. Does the account snapshot carry a leaked key?
jq '{has_claudeJsonApiKey: (._claudeJsonApiKey != null), has_customApiKeyResponses: (._customApiKeyResponses != null)}' \
  ~/.claude/accounts/sirtheo.work@example.com.json

# 3. Is the live claude.json currently carrying an apiKey?
jq '{apiKey_set: (.apiKey != null), apiKey_prefix: (.apiKey // "" | .[0:8])}' \
  ~/.claude.json
```

If command 1 reports no key but command 2 or 3 shows a key present, you were exposed to silent billing before upgrading to v3.6.x. After upgrading, command 3 will return `apiKey_set: false` on the next account load.

Full root-cause analysis: `.claude/docs/reports/2026-05-13-silent-apikey-after-subscription-exhaustion.md` (internal, not committed to the public repo).

## Credential exposure via process arguments

### The window

Writing a credential to the macOS Keychain shells out to the system
`security` tool, and the secret travels as a command-line argument:

```
security add-generic-password -s <service> -a <account> -w <SECRET> -T … -U
```

For the lifetime of that `security` subprocess (sub-second), `<SECRET>`
is visible in the process argument vector — i.e. to anything that can
read `ps`/`proc`-style process listings. The same shape applies to the
OAuth token blob and the API key.

### What is mitigated, and how

- **Error messages never echo the argv.** Node's default
  `Error.message` for a failed `execFileSync` embeds the full command
  line — which here contains the token. Both write paths in the
  `KeychainAdapter` (`credential-store.ts`, OAuth and API-key) capture
  the child's stderr separately (`stdio: [.., .., 'pipe']`) and throw a
  hand-written message that contains only the child's diagnostic, never
  the argv. This is the applied in-adapter mitigation.
- **The CLI never logs a key in clear.** `apikey show` / `apikey set`
  only ever print `maskApiKey(...)`; read paths return the value to the
  caller but do not log it. Verified across `commands/apikey.ts`.
- **No clear text on the GUI-captured stdout/stderr.** The CLI emits
  masked output only; the secret reaches the GUI solely through the
  explicit `apikey show` contract, by design.

### What is deferred, and why

The argv window of the `security` subprocess itself is **not** closed.
`security add-generic-password` has no stdin/file route for the password
— the only alternatives are the inline `-w <value>` (what we use) or an
interactive tty prompt, neither of which removes argv exposure in a
scriptable context. Closing it would require replacing the `security`
CLI with a native Keychain binding (Node-API / `keytar`-style), an
architectural change out of scope here.

The residual risk is low under this project's threat model: modern macOS
only exposes another process's argv to the same user or to root, and a
same-user attacker already has `security` CLI access to the very
Keychain entries in question.

### GUI sidecar API-key passing (resolved)

The desktop GUI used to save an API key by spawning the CLI as
`apikey set <email> --key <key>`, placing the key in the **sidecar
process** argv (a second, GUI-side exposure window). This was also
broken: the CLI argument parser does not read a `--key` flag — `apikey
set` takes the key from stdin (or the interactive screen) only — so the
flag was both an exposure and functionally ignored.

Fixed by piping the key to the CLI over **stdin** and dropping the flag,
so no key value ever reaches the command line. The CLI's non-interactive
`promptSecret` was also hardened to resolve on stdin EOF (empty stdin no
longer hangs the process).

## Loopback proxy authentication

### The exposure

While `claude` runs, claude-switch starts a local HTTP proxy on
`127.0.0.1:<random-port>` that forwards every request to
`api.anthropic.com` with the user's OAuth token or API key attached.
The bind is loopback-only, but loopback is reachable from two sources
that are not the `claude` CLI:

1. **Other processes running as the same user**, which can connect to
   the port and have requests forwarded with the user's credentials.
2. **Browsers, via DNS rebinding** — a malicious site whose DNS resolves
   to `127.0.0.1` becomes "same-origin" with the proxy and can fetch it
   cross-origin without CORS preflight (for simple requests) or with
   bypassed checks (no-cors mode).

### What is mitigated

Two header checks at the top of the request handler:

- **`Origin` must be absent.** Browsers always set `Origin` on
  cross-origin fetches; the `claude` CLI does not. An `Origin` header
  alone is a reliable "this came from a browser" signal, regardless of
  whether DNS rebinding shifted same-origin to loopback.
- **`Host` must match `127.0.0.1:<port>` or `localhost:<port>`.** The
  `claude` CLI is configured with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
  and sends that hostname in `Host`. A DNS-rebinding browser sends the
  original site's hostname (e.g. `attacker.com:<port>`) and is rejected.

Rejections return HTTP 403 with a structured JSON error and increment
the `rejectedAuth` counter surfaced in `claude switch status`.

### What is **not** mitigated

A local process running as the same user that mimics the CLI's HTTP
shape exactly (no `Origin`, correct `Host`) still passes the gate and
will get requests forwarded. The threat model here is the same as any
local dev server: don't run untrusted code as your user during a
`claude` session. A shared-secret token between proxy and CLI was
considered and rejected for now — the `claude` binary doesn't expose a
hook to forward a header we'd inject, so the secret would have to live
in the URL path, which means it'd also live in `ANTHROPIC_BASE_URL`, an
env var the same-user attacker can already read.

## macOS Keychain partition-list prompts

### The symptom

On macOS, every `claude switch <account>` may pop up the system password
dialog (`security wants to use the Confidential Information stored in
"Claude Code-credentials"`). Even clicking **Always Allow** doesn't make
it stop — the next swap prompts again.

### Why it happens

macOS Sierra+ adds a second access gate to every Keychain item alongside
the classic ACL: `kSecAttrPartitionList`. An item is locked to the
code-signing identities listed there. The `claude` binary creates the
`Claude Code-credentials*` entries with a partition restricted to
Anthropic's team-ID, so `/usr/bin/security` (Apple team, what claude-switch
shells out to) is **outside the partition list** and prompts every time.
Clicking "Always Allow" sticks the ACL entry but not the partition list,
so it doesn't persist across the next prompt.

### Fix (one-time, requires the macOS user password once)

For each Claude Keychain item, expand the partition list to include
Apple-signed CLI tools. Replace `<acct>` with `Claude Code-credentials`
for the global item, and with your macOS username for any per-config-dir
items (`Claude Code-credentials-<hash>`):

```bash
# 1. global entry
security set-generic-password-partition-list \
  -S "apple-tool:" \
  -s "Claude Code-credentials" \
  -a "Claude Code-credentials"

# 2. discover per-config-dir entries (if any) and run the same for each
security dump-keychain 2>/dev/null | \
  grep -oE '"Claude Code-credentials-[0-9a-f]{8}"' | sort -u
# For each one returned, run:
#   security set-generic-password-partition-list \
#     -S "apple-tool:" -s "<service>" -a "<your-username>"
```

You'll be asked for your macOS login password once per item. After that,
swaps no longer prompt.

### What's the security trade-off

The partition list previously locked the item to a single team-ID. After
the change, `apple-tool:` (the category that includes `/usr/bin/security`)
can also unlock it. If you'd rather be more permissive (e.g. allow
Apple-signed GUI apps too, useful only if some third-party tool on your
Mac legitimately needs to read the entry), use `-S "apple-tool:,apple:"`.
**Do not** add `unsigned:` unless you understand that this category
covers arbitrary unsigned binaries running as your user — i.e. a local
malware would no longer be prompted before reading the entry.

The blast radius is narrow: only the three (or so) `Claude Code-credentials*`
entries are touched, not the rest of your Keychain.

### Why claude-switch doesn't do this automatically

`security set-generic-password-partition-list` needs `-k <keychain-password>`
to run non-interactively; without it macOS prompts for the password
itself. Automating the fix would mean either prompting the user for their
macOS password during a swap (worse UX than the current "one annoying
dialog" cycle) or shipping a one-off setup helper. The maintainer's
current call is to document the procedure rather than automate it; a
contribution that wires it into an opt-in `claude switch setup-keychain`
command would be welcome.

## Reporting a vulnerability

If you find a security issue — credential leak, privilege escalation,
proxy MITM, anything that touches the credentials we handle — **please
do not open a public issue**.

Instead, open a private **GitHub Security Advisory** at
<https://github.com/SIRTHEO/claude-switch/security/advisories/new>.
Only the maintainer sees it; the report stays private until the fix
is published.

We acknowledge within 72 hours and aim to ship a fix within 7 days
for HIGH/CRITICAL severity. Lower severity bugs ship with the next
scheduled release.

## Supported versions

The latest minor on the `3.x` line. Older minors receive security
fixes only on a best-effort basis. The `2.x` line is end-of-life;
upgrade.

## Disclosure expectations

After a fix ships we credit the reporter (with permission) in the
release notes. We do not run a paid bug bounty.
