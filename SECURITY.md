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
