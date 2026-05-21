# Testing — `claude-switch` (CLI)

Suite runs `node --test` against compiled `dist/test/**/*.test.js`, never
against `src/*.ts` source files. The `npm test` script enforces this with the
build step.

## Global env flag

`CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` is set globally by the `npm test` script
in `package.json`. It is the SSOT test-mode switch — it bypasses the macOS
Keychain so the suite never prompts for the developer's real keychain
password during `npm test` / `npm run gif`.

Two consequences future sessions must respect:

1. **Never use real keychain credentials in tests.** All test fixtures
   assume the flag is set.
2. **When a test needs the un-flagged path** (e.g. `accounts-rollback.test.ts`
   exercising the Keychain-write rollback that is gated on the flag),
   it must (a) save and restore `process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN`
   in `beforeEach`/`afterEach`, and (b) be aware that lifting the flag opens
   a window where `KeychainAdapter.warnApiKeyBypass` may emit a stderr
   one-shot warning — assert against the *specific* banner of interest, not
   exact-empty stderr (see the "Case A" precedent below).

## Run command

```bash
npm run build && \
  CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 node --test \
    dist/test/**/*.test.js dist/test/*.test.js \
    2>&1 | grep -E '^ℹ (tests|pass|fail|skipped)'
```

The grep at the end pins the four canonical numbers (tests / pass / fail /
skipped) — report them verbatim, never paraphrase or estimate.

## Worker test verification protocol

When a subagent (Worker) reports test results, it MUST:

1. Literally run the command above (no shortcuts, no `node --test test/…`
   against source, no parsing manually).
2. Report the four exact numbers from the grep.
3. If `npm test` fails, surface the full error output — do not summarise.

### Anti-pattern observed (do not repeat)

Sessione 2026-05-15: 3 of 10 workers fabricated baselines ("66 fail",
"18 fail") because they ran `node --test test/*.ts` against TypeScript
**source** rather than `dist/test/*.test.js` compiled artefacts. The
runtime crashes they recorded were TS compilation errors, not real test
failures. The runner must execute against the dist build.

## The "Case A" precedent — 2026-05-22

Test `test/passthrough-untracked-apikey.test.ts` (`Case A`) failed for
months as a "pre-existing 1 fail" baseline. Root cause: the test asserted
`stderr === ''` after lifting `NODE_ENV`, but lifting `NODE_ENV` opened
the `KeychainAdapter` bypass-warning's one-shot latch — the warning fired
into stderr, the assertion broke. Fixed by narrowing the assertion to
"the *production* banner is absent" (`assert.ok(!out.includes('NOT tracked'))`).

Lesson for future tests with similar shape: when toggling env flags to
exercise a code path, ask *what else listens to env*. Assert on the
specific signal you care about, not on bulk stderr identity.

## Characterization tests (Phase 20.6.5 onwards)

Before refactoring credentials / accounts code, snapshot the on-disk
side-effects of the current behaviour to a golden file and pin it as a
test. The pattern lives in `test/accounts-characterization.test.ts`:

- Run a public flow (`save`, `load`, `switch`, `remove`).
- Diff the full `accountsDir/` tree (paths + contents) against a golden.
- Diff the `~/.claude.json` against a golden.

This makes "did I change behaviour by accident" obvious during refactor
review. Run the characterization BEFORE the refactor (capture current),
keep it green DURING (no drift), and BEFORE removing the temp golden.

## Coverage

CI coverage floor lives in `.github/workflows/ci.yml`. Current = 78%
(ratcheted from 75 → 78 across Stage 1-2). Future ratchet (20.15) → 80%
once Stage 2 lands new tests. **Never lower the floor**.

## File spawn integration tests

When testing the real `claude-switch` binary, spawn `dist/bin/cli.js`
with `node` (not the source). The first arg after the script path must
be `switch` (the binary is the wrapper; `switch` is the namespace). See
`test/profile-spawn-integration.test.ts` and `test/apikey-set-stdin.test.ts`
for the shape.

## What to assert on a `catch{}` block

Per the silent-bug rule (20.12):
- A bare `catch { /* ... */ }` annotated with a one-line reason ("missing
  file → behave as absent") is a documented swallow. **Tests can assert
  the fallback shape** (e.g. function returns null).
- A bare `catch {}` with no reason is a bug awaiting documentation or
  narrowing. **Do not** assert on its swallow behaviour — first annotate it.
