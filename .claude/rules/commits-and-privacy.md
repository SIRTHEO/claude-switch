# Commits & privacy — `claude-switch` (CLI)

Two hard gates run on every commit/push. Future sessions must respect both.

## Conventional Commits — strict

| Type | Use |
|---|---|
| `feat` | new user-visible feature |
| `fix` | bug fix |
| `refactor` | restructure with no behaviour change |
| `chore` | maintenance, deps, dead code |
| `docs` | documentation only (incl. inline comments) |
| `test` | tests only |
| `perf` | performance |

**Style**: `<type>(<scope>): <subject>` — lowercase, no period, imperative.
Subject ≤ 72 chars and describes WHAT changes in the code.
Body (optional) describes WHY (the diff already shows the WHAT).

### Subject — concrete, not vague

- ✗ `chore(suite): boost code health to 9.5+`
- ✓ `refactor(profile): extract resolveActiveProfile helper`
- ✗ `refactor: cleanup`
- ✓ `fix(oauth): cap refresh response body at 1MB`

### Multi-area changes

Split into multiple commits by area when the diff crosses scopes. If you
must keep one commit, write a body with WHY-focused bullets (not a
shopping list).

### Banned words and patterns in commit messages (subject + body)

- Italian (project switched to English-only commits regardless of chat
  language)
- Maintainer real names and emails (the actual ban list lives in the
  privacy-gate scripts below; do not enumerate the real strings in this
  file)
- Local paths (`/Users/<username>/…`)
- Phase references: `Phase N.M`, `Phase 12.6`, `H5 defense`, `Stage 3`
- AI-tooling enumeration: `.claude*`, `.harness*`, `CLAUDE.md`, `AGENTS.md`,
  `harness.toml`, skill names, agent IDs, harness task IDs
  (`HRD-WAP-9`, `MOT-A`, `CLM-7`)
- `Co-Authored-By: Claude` trailer or "Generated with Claude Code"
- Narrative scoring (`boost to 9.5`, `code health`)
- Emoji
- "future Claude sessions" → use "new contributors" instead

## Privacy gates — run BEFORE every commit / push

Note: the patterns below use a single-char `[x]` regex class on the first
letter of each banned string so the literal pattern inside this rule file
does not self-match when a gate scans a diff that includes this file.
Functionally `[m]atteo19` matches the literal email prefix the same way the
unbracketed pattern would, but the file content `[m]atteo19` (with brackets)
does not contain the bare string as a contiguous substring.

### Pre-commit (looks at staged hunks)

```bash
git diff --cached | grep -E '([m]atteo19|[d]imattia|[g]yver|/[U]sers/theo)' \
  && echo "LEAK — abort commit" && exit 1 \
  || echo "privacy ok"
```

### Pre-push (looks at additions + commit bodies for the whole interval)

```bash
git log origin/main..HEAD -p | grep -E '^\+' | \
  grep -E '([m]atteo19|[d]imattia|[g]yver|/[U]sers/theo)' \
  && echo "LEAK in additions" && exit 1 \
  || echo "privacy ok"

git log origin/main..HEAD --pretty=format:"%h %s%n%b" | \
  grep -iE '[m]atteo19|[d]imattia|[g]yver|/[U]sers/theo|[P]hase [0-9]|[H][0-9] defense|[h]arness|[A]GENTS\.md' \
  && echo "INTERNALS in messages" && exit 1 \
  || echo "messages ok"
```

Pre-commit gate only looks at `diff --cached` — it does not catch commit
messages or the body of already-made commits. That is what the pre-push
gate is for.

## Fixtures

Use **only** these for fixture data in tracked files:

- Emails: `sirtheo.work@example.com`, `sirtheo.personal@example.com`
- Home/path: `/tmp/sirtheo-home`
- Maintainer handle: `sirtheo`

Do **not** improvise with real maintainer data "because it's at hand" —
that is precisely the mode in which the May-2026 leaks happened. See the
two incidents below as concrete reminders.

## Maintainer identity in repo

Use the handle `sirtheo` or only primitive GitHub identifiers (Security
Advisory link). Do not embed the real name.

## Historical leak incidents — learn, don't repeat

- **2026-05-17** — pushed test fixture commit using real maintainer emails.
  Sanitised after the fact. Lesson: read this rule **before** writing any
  test/fixture, not after.
- **2026-05-20** — cherry-picked 12 commits to main carrying bodies with
  real emails, local paths, "Phase 12.6 — H5 defense" and AI-tooling
  enumeration. Pre-push scan caught it. Lesson: pre-commit gate sees only
  the diff, not the body — the pre-push gate is the body backstop.

## Commit message hygiene — body example

Good:

```
refactor(query): centralize taxonomy invalidation

Two functions previously duplicated the same query-key list with only one
extra invalidation. Consolidated into a parametrised helper to avoid drift
when a new query key joins the group.
```

Bad:

```
chore: improvements
```
