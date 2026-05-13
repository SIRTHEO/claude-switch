# Error handling — the audit and the rules

This document is the output of the Phase 11.4 audit: a 1-by-1 walk
through every `try/catch` block in `src/`, classified into one of four
patterns, with the rules contributors should follow when writing new
ones.

> **Audit date**: 2026-05-08 — 135 `catch` blocks across 32 files.
> The audit re-confirmed that no block is a bug-masking silent
> swallow. A handful were missing inline justifying comments; those
> have been annotated. The taxonomy below is what the codebase
> already does — captured here so future patches stay consistent.

## The four patterns we use

Every `catch` block in `src/` falls into exactly one of these. If a
new patch introduces a `catch` that doesn't fit a pattern below, add
the pattern explicitly to this doc rather than picking a generic one.

### 1. **Re-throw with sanitized context**

The error is real, the user needs to see it, but the original
`Error.message` is too noisy or leaks internals (Keychain stderr,
argv, file paths). Catch, sanitize, re-throw.

Example: `src/keychain.ts:116` (the `writeKeychainAtService` body).
The Keychain CLI's stderr can include the OAuth token bytes; we
catch, extract a short detail, and re-throw a clean Error.

```ts
} catch (e) {
  const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
  const detail = stderr ? `: ${stderr}` : '';
  throw new Error(`Failed to write to macOS Keychain${detail}. ...`);
}
```

**Rule for new code**: prefer this over swallowing whenever the
caller is a user-driven flow (CLI command, screen action) and the
underlying error tells the user *something they could fix*.

### 2. **Distinguish-and-propagate**

The error _kind_ matters. Only some classes are recoverable; the
others propagate. Standard pattern when reading user files.

Example: `src/accounts.ts:36` (`getCurrent`).

```ts
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'EISDIR') return '';
  throw e;
}
```

**Rule**: when a `catch` recovers, document _which_ subset of errors
is being recovered. The `code === 'ENOENT'` check is the contract;
without it, future contributors might widen the recovery to cover
permission errors that the user must actually fix.

### 3. **Surface via UI / output, then continue**

Used inside Ink screen handlers and inside the run-app dispatcher.
The error doesn't crash the program — it becomes a `Notice`, an
inline `setError(...)` call, or a fallback string in the rendered
output.

Example: `src/ui/run-app.ts:297`:

```ts
} catch (e) {
  notice = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
}
```

**Rule**: if the catch is in event-loop / dispatcher code, this is
the correct pattern. Don't substitute a `throw`: it would unwind the
whole Ink session and lose state the user expects to keep.

### 4. **Best-effort, intentionally silent**

The path is a UX nicety, not a correctness path. Failure here is
recoverable on the next explicit operation. Examples:

- `syncActiveSnapshotIfStale` (every catch returns `false`)
- `triggerBackgroundUsageRefresh` (detached spawn — caller doesn't
  await; error in the spawn is logged inside the child or invisible)
- `readUsageCache` (returns `null` on parse error → next refresh
  will rewrite cleanly)
- `readProfile` (returns `null` `userID` / `null` `emailAddress` —
  caller's logic handles "no metadata yet")
- The rollback `catch` inside `accounts.ts:save` (`/* best-effort
  rollback */` — we tried to restore a previous JSON; if THAT
  fails, the next save() will overwrite again)

**Rule for adding new ones**:
1. Every silent catch MUST have a 1-line `// ...` justifying comment
   on the catch line itself or immediately inside the body.
2. The comment must answer "why is it correct that we lose this
   error?" — not "what does the catch do" (the code already says
   that).
3. Never use this pattern for write paths the user is paying
   attention to (CLI command output, snapshot writes during
   `claude switch`). Use pattern 1 or 2 there.

## Ink screen reject path

Every Ink screen that calls `render(...)` + `waitUntilExit()` must propagate
rejections to the caller. The naive pattern below is dangerous because
`Promise.prototype.then` with no rejection handler creates an unhandled
rejection — Node discards it silently (or crashes in `--unhandled-rejections=throw`).

**No** — unhandled rejection, silently swallowed:

```ts
// ❌ do not do this
return new Promise<ScreenExit>((resolve) => {
  const instance = render(<MyScreen onExit={(e) => { result = e; }} />);
  instance.waitUntilExit().then(resolve); // rejection path missing
});
```

**Yes** — use `awaitInkScreen` from `src/ui/utils/ink-screen.ts`:

```ts
// ✓ correct
import { awaitInkScreen } from '../utils/ink-screen.js';

const instance = render(<MyScreen onExit={(e) => { result = e; }} />);
return awaitInkScreen(instance, () => result);
// awaitInkScreen does: await instance.waitUntilExit(); return getResult();
```

**Rule**: always use `awaitInkScreen` whenever you write a function that
renders an Ink component and awaits its exit. Do not write inline
`.then(resolve)` chains without a matching `.catch` / `await`.

## process.exit() inside Ink render path

Calling `process.exit()` from within an Ink event handler or render
function is fragile: Ink's TTY restore and the caller's `finally` blocks
do not run, leaving the terminal in raw/alternate-buffer mode.

**No** — raw `process.exit` inside an Ink handler:

```ts
// ❌ do not do this
function onLaunch() {
  const result = spawnSync(cmd, args, opts);
  process.exit(result.status ?? 1); // TTY restore skipped, finally blocks skipped
}
```

**Yes** — throw `ExitError`, caught by `handleError` in `bin/cli.ts`:

```ts
// ✓ correct — use spawnClaudeAndExit from src/ui/screens/profiles.tsx
import { spawnClaudeAndExit } from './screens/profiles.js';

// inside runProfilesScreen (outside Ink render, after unmount):
spawnClaudeAndExit(command, args, options);
// spawnClaudeAndExit runs spawnSync then throws new ExitError('', exitCode)
// ExitError propagates up through run-app.ts → bin/cli.ts → handleError
// handleError prints the message (if any) and calls process.exit(code)
```

**Rule**: never call `process.exit()` directly inside an Ink screen
component or its event handlers. Return or throw to the nearest
non-Ink boundary. Use `ExitError` for clean exits; use `spawnClaudeAndExit`
when you need to transfer process control to a subprocess. The caller's
`finally` block (TTY buffer restore) runs correctly either way.

## Anti-patterns to avoid

These do not appear in the codebase as of the audit. If you find one
during review, reject it.

- `} catch {}` (truly empty body, no comment)
- `} catch (e) { console.log(e); }` — masquerades as logging but
  hides the error from anything that could act on it (CI, status
  command). Use pattern 1, 2, or 3 instead.
- Generic `} catch { return; }` inside a sync flow that the user
  invoked explicitly (e.g. inside `claude switch <alias>`). The user
  is waiting for an answer; a silent return looks like success.

## How to write a new catch

1. Start by deciding which of the four patterns you want.
2. If you can't pick one, the catch is probably hiding a design
   problem upstream — surface that decision before writing the catch.
3. Add the inline comment BEFORE the body, not as an afterthought.
4. If you're touching `src/api-proxy.ts`, `src/profiles.ts`, or
   `src/keychain.ts`, also confirm with the maintainer — those
   modules carry credential-sensitive failure modes where a silent
   swallow can hide a real security regression.

## Tooling

The audit predicate that shipped the inline comments is:

```bash
grep -rn '} catch' src --include='*.ts' --include='*.tsx' \
  | while IFS=: read -r file lineno _; do
      next=$(sed -n "$((lineno+1))p;$((lineno+2))p" "$file")
      body=$(sed -n "$((lineno+1)),$((lineno+5))p" "$file")
      # Skip catches with comment on header or first body line
      grep -qE '/\*|//' <<<"$content" && continue
      grep -qE '^\s*//|^\s*/\*' <<<"$next" && continue
      # Skip catches whose first body line throws / returns / exits
      head -1 <<<"$body" | grep -qE 'throw|return|process\.exit' && continue
      echo "$file:$lineno"
    done
```

Run it before opening a PR that adds new `try/catch` to confirm the
new ones are either annotated or properly raise/return. The
predicate is intentionally noisy (it flags catches that surface
errors via setError/setNotice the same as truly silent ones) — read
each hit.
