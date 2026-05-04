# CHANGELOG preview — 2.7.0

**Source**: `git log main..experiment/per-terminal-isolation` @ HEAD on 2026-05-04
**Plans.md task**: 6.3
**Predicted bump**: 2.6.1 → **2.7.0** (minor — 2 `feat:` commits ahead of main)
**Predicted release flow**: release-please opens release PR on next merge of `experiment/per-terminal-isolation` → main; merging that PR triggers the npm publish job.

## Draft entry (release-please will produce roughly this)

```markdown
## [2.7.0](.../compare/v2.6.1...v2.7.0) (2026-05-XX)

### Features

* **profiles:** isolated per-terminal profiles via CLAUDE_CONFIG_DIR (eef0f0c)
* **profiles:** import legacy accounts into isolated profiles without browser re-login (55c041a)

### Refactors

* enable noUncheckedIndexedAccess + fix 19 type errors (376deb5)

### Documentation

* (9 docs commits — see git log; release-please includes them under "Documentation")
```

## User-facing release notes (suggested addendum to release-please's auto draft)

The auto-CHANGELOG is accurate but terse. Suggested manual addendum to the GH Release body (NOT to CHANGELOG.md — release-please owns that file):

> **2.7.0 — "Profiles"**
>
> Per-terminal isolation has landed. Two new flows that coexist with the existing `claude switch <account>`:
>
> - `claude switch profile create <name>` — make a fresh isolated profile
> - `claude switch profile login <name>` — sign in to it (browser opens)
> - `claude switch profile use <name>` — start `claude` using only that profile
>
> Each profile gets its own user ID, its own macOS Keychain entry, its own session history. Open two terminals with two different profiles and they will not interfere with each other.
>
> Already have saved accounts? `claude switch profile import <email> --as <profile>` re-keys them into a profile without forcing a re-login.
>
> macOS is verified end-to-end. Linux works in static analysis (tokens land in `<profile>/.claude.json`); a live confirmation is on the roadmap.
>
> See the new "Profiles" section in the README for the full UX.

## Supporting evidence

23 commits ahead of main, distribution by type:

| Prefix | Count | Visible in CHANGELOG? |
|---|---|---|
| `feat:` | 2 | yes (Features) |
| `fix:` | 0 | n/a |
| `refactor:` | 1 | yes (Refactors) |
| `docs:` | 9 | yes (Documentation) |
| `test:` | 5 | hidden |
| `chore:` | 3 | hidden |
| `ci:` | 2 | hidden |

The two `feat:` commits map to two release-note bullets. The one `refactor:` (TS strict flag) is worth a Refactors mention. The 9 `docs:` will appear as a long bullet list — that's the release-please default.

## Risks before merge (from Plans.md)

| Risk | Mitigation status |
|---|---|
| Interactive smoke (3a.1b) — login + use flow not yet verified end-to-end | **OPEN** — needs user OAuth |
| Linux not verified live (3a.4) | **OPEN** — needs Docker spike OR explicit "macOS verified, Linux best-effort" note in README |
| Concurrency (two terminals same profile) (3a.5) | **OPEN** — needs two physical terminals |
| README "Profiles" section not yet drafted (6.2) | **OPEN** — should land in same PR as merge |
| FAQ entry on multi-terminal drift not updated (6.1) | **OPEN** — should land in same PR |

## Closure

6.3 closed as a draft. Final wording will be polished when 6.1 + 6.2 land and the PR description is written.
