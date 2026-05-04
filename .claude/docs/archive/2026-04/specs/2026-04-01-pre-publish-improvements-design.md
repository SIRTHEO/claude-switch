# claude-switch: Pre-Publish Improvements Design Spec

## Overview

Fix edge cases, improve error handling, and add polish before the first npm publish of claude-switch v2.0.0.

## Goals

- Make all business logic functions testable (no `process.exit` in libraries)
- Handle corrupted `~/.claude.json` gracefully
- Add `--version` flag
- Sanitize email filenames against unsafe characters
- Improve first-account messaging in `switch add`
- Add integration tests covering full account lifecycle

## Non-Goals

- New features beyond what's listed
- Refactoring module boundaries (current structure is fine)

## Changes

### 1. ExitError Pattern

**New file:** `src/errors.ts`

```ts
export class ExitError extends Error {
  constructor(message: string, public code: number = 1) {
    super(message);
  }
}
```

**Modify:** `src/switcher.ts` — replace all `process.exit(1)` calls with `throw new ExitError(message)`.

Affected functions:
- `switchInteractive()` — invalid choice
- `addAccount()` — login failed

**Modify:** `bin/cli.ts` — wrap `main()` in try/catch:
```ts
try {
  await main();
} catch (e) {
  if (e instanceof ExitError) {
    console.error(e.message);
    process.exit(e.code);
  }
  throw e;
}
```

Remove `process.exit()` calls from `main()` switch cases too — convert them to `throw new ExitError(...)`.

### 2. JSON Error Handling

**Modify:** `src/accounts.ts`

In `save()` — catch `SyntaxError` from `JSON.parse`, throw clear error:
```
~/.claude.json contains invalid JSON. Please fix or delete it.
```

In `load()` — same treatment for both the account file and claude.json reads.

In `getCurrent()` — already returns `''` on error, no change needed.

**Tests:** Write JSON invalido in tmpfile, verify clear error message.

### 3. `--version` Flag

**Modify:** `bin/cli.ts`

Add to `parseCommand`:
- `switch --version` and `switch -v` → `{ action: 'version' }`

Add to `main()` switch:
- Read version from a constant (hardcoded `2.0.0` or read from a generated version file at build time)

Simple approach: export `VERSION` constant from `src/version.ts`:
```ts
export const VERSION = '2.0.0';
```

Update this manually on release (same as bumping package.json).

### 4. Email Filename Sanitization

**Modify:** `src/accounts.ts`

Add validation in `save()` before using email as filename:

```ts
const UNSAFE_CHARS = /[/\\:*?"<>|]/;
if (UNSAFE_CHARS.test(email)) {
  throw new Error(`Email contains characters unsafe for filenames: ${email}`);
}
```

This catches truly invalid characters. Normal email characters (`+`, `.`, `@`, `-`) are all filesystem-safe.

**Tests:** Verify safe emails work, verify emails with `/` or `\` are rejected.

### 5. First Account Messaging

**Modify:** `src/switcher.ts` `addAccount()`

After saving a new account, if it's the first one (no other accounts in the directory), print:
```
First account saved! Add another with: claude switch add
```

Check via `list(accountsDirPath).length === 1` after save.

### 6. Integration Tests

**New file:** `test/integration.test.ts`

Tests using tmpdir with fake `.claude.json`:

1. **Full lifecycle:** save account A → save account B → list (both shown) → switch to B → verify active → switch to A → verify active → remove B → list (only A)
2. **Fuzzy match integration:** save two accounts → fuzzy match by partial → verify correct switch
3. **First-run auto-save:** set up `.claude.json` with active account, no accounts dir → simulate passthrough → verify account auto-saved
4. **Error cases:** switch to non-existent account → verify error message, remove active account → verify rejection

These tests call the functions directly (not via CLI parsing) with custom paths, so no real filesystem pollution.

## Testing Strategy

- All new code gets unit tests
- ExitError pattern tested by verifying functions throw instead of exiting
- Integration tests cover multi-step flows
- Existing 46 tests must continue to pass
