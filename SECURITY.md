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
