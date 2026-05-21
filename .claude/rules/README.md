# `claude-switch` (CLI) — rules for future sessions

These rules consolidate what Phase 20 and the security audit established as
the project conventions. They are read by future Claude Code sessions before
touching code in this repo. Treat them as load-bearing.

| File | Scope |
|---|---|
| [`architecture.md`](./architecture.md) | Hexagonal layout: ports, adapters, the four canonical ports for the CLI, what is **not** a port, file organisation. Cross-repo rule at `../../../.claude/rules/hexagonal-architecture.md` is canonical; this file pins the CLI-side specifics. |
| [`commits-and-privacy.md`](./commits-and-privacy.md) | Conventional Commits, privacy-gate scripts (pre-commit + pre-push), the maintainer-identity policy, fixture conventions, the two historical leak incidents kept as concrete warnings. |
| [`testing.md`](./testing.md) | `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` global flag, test-against-`dist/` discipline, characterization-test pattern, worker test verification protocol, the "Case A" precedent. |
| [`housekeeping.md`](./housekeeping.md) | File size targets, dead-code workflow (knip + jscpd), lint discipline, silent-catch annotation rule. |

When a session reads `CLAUDE.md` at the repo root, it also implicitly carries
these rules (CLAUDE.md links them by name where relevant).
