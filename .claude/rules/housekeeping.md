# Housekeeping — `claude-switch` (CLI)

## File size targets

- **Target**: 100–200 lines per file.
- **Soft warning**: 200–280 — split when the file mixes concerns.
- **Hard limit**: 280 lines.

**Enforced by gate, not by review.** `scripts/check-file-sizes.mjs`
(`npm run check:file-sizes`, plus a CI step) fails any new file over 280 lines.
Files already over it are grandfathered in `scripts/file-size-baseline.json` at
their current count and may only **shrink** — never grow past that ceiling
(the coverage-floor / jscpd ratchet pattern). When a grandfathered file drops to
≤280, run `node scripts/check-file-sizes.mjs --update` to drop it from the
baseline so it can never regrow.

The current outliers and their split seams live in the baseline file and in
Plans Phase 26.3 — not duplicated here (single source of truth). Splits go in
their own branch, one file per branch; never bundle a split with a behaviour
change, so review can confirm behaviour is identical by re-reading moved chunks.

## Function size

- **Target**: ≤ 50 lines.
- **Hard limit**: 80 lines.

If a function crosses 50 lines it almost certainly does several things —
extract. Function size is review-guidance only — the ratchet gate counts file
lines, not function lines.

## Dead-code workflow

`knip` is the primary scanner. Run:

```bash
npx knip --no-progress
```

For each "unused export" knip reports, **verify before dropping**:

1. `grep -rln "\bSymbolName\b" src/ test/ bin/` — does anything reference it?
2. If only `src/<self>.ts` matches → safe to drop `export` (interface stays
   private to its file).
3. If `test/*` matches → keep the export; tests rely on it.
4. If nothing matches → drop the `export` keyword (do not delete the
   definition itself unless dead-end verified).

For unused **functions** (knip's "Unused exports — function"), the same
verification applies before deletion. A function with zero refs across
src + test + bin is safe to delete. **Always** check `bin/cli.ts`
specifically — knip sometimes misses bin/ entry points.

## Duplication policy (jscpd)

Enforced by gate: `npm run check:duplication` (jscpd over `src`, config in
`.jscpd.json`, threshold **1%**). Current measured baseline: **0.7%** total
(13 clones, 122 duplicated lines; typescript 0.55%, tsx 1.54%). Future PRs
should not raise this number — the 1% threshold is the hard ceiling, but treat
0.7% as the ratchet target. Concrete clones still in the repo are tracked in
Plans 20.13 as "minor / not worth extracting now":

- 3× Ink UI screen headers (`manage-account`, `profiles`,
  `auto-fallback`, `setup-wizard`) — extract `<ScreenHeader>` when the
  pattern gets a 4th instance.
- 1× `credential-store.ts` 9-line read-helper micro-pattern.
- 1× `auto-fallback.ts` 14-line threshold/window comparison.

The 21-line dup in `commands/profile.ts` was extracted as
`resolveActiveProfile` in 2026-05-22.

## Silent-catch policy (Phase 20.12)

Every `catch {}` or `catch (e) { /* return X */ }` block must carry a
one-line `// reason` comment explaining *why* this failure mode maps to
the fallback value. Examples:

```ts
try { fs.accessSync(f); return true; } catch { return false; } // not present → don't include
try { return JSON.parse(raw); } catch { return null; } // corrupt file → no token
```

When you see a bare empty catch with NO comment in this codebase, treat
it as a bug awaiting documentation. Either annotate it (probe pattern) or
narrow it (`if (errnoCode(e) === 'ENOENT')`-style).

**Do not** blanket-comment for the sake of passing a lint rule — that
defeats the audit. Each annotation must reflect the real semantic of the
swallow.

## Lint discipline

Biome is the formatter + linter (`npm run lint` → `biome lint src bin test`).
Run before every commit. Zero new errors or warnings.

`as any` is **banned**. The single allowed unsafe-cast in the codebase
is in `src/commands/_helpers.ts:54` (private readline API for mute-echo);
adding more requires PR justification.

## TypeScript discipline

- `strict: true`, no `any`.
- `as` casts only for `JSON.parse` return type narrowing and for
  `NodeJS.ErrnoException` — both routed through `errMessage` / `errnoCode`
  helpers in `errors.ts`.
- All public functions get explicit return types.
- Internal `interface Options` / `interface Result` types do NOT need
  `export` unless a sibling file uses them. Drop the `export` to keep
  the API surface tight (knip flags these).

## Cruft hygiene

Before commit, verify nothing tracked that should be in `.gitignore`:

```bash
git status --ignored --short | grep -v "^!! " | head     # untracked NOT ignored
git ls-files | grep -E "tsbuildinfo|\.d\.ts$|dist/|target/|vite\.config\.[dj]" | head
```

Neither command should return anything that looks like a build artefact.
If it does: add to `.gitignore` + `git rm --cached`.

## Documentation in code

- Inline comments explain **why**, not what — the diff and the names show
  what.
- File headers explain the module's purpose in 2-5 lines.
- A non-obvious choice (e.g. "we use `radix-ui` meta-package not
  individual sub-packages because shadcn") deserves a comment at the
  point of the choice.
