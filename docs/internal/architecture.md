# claude-switch — architecture overview

This is the bird's-eye view of the codebase, intended for someone
about to make a non-trivial change. It deliberately doesn't repeat
the user-facing README; the audience here is the contributor who
needs to know "where does the OAuth refresh live?" or "what
guarantees does the proxy give claude?"

## The three layers

```
┌─────────────────────────────────────────────────────────────────┐
│  bin/cli.ts                                                     │
│    parses argv → Command discriminated union → handleX(...)     │
│    no business logic; pure dispatcher                           │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  src/commands/*.ts   (handlers — one file per top-level verb)   │
│    handleAdd, handleSwitchTo, handleStatus, handleApikey, ...   │
│    each is a thin orchestrator: read CommandContext, call       │
│    domain functions, format output, raise ExitError on failure  │
└────────────────┬────────────────────────────────────────────────┘
                 │  uses
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Domain (src/*.ts)                                              │
│    accounts.ts · profiles.ts · keychain.ts · oauth-refresh.ts · │
│    api-proxy.ts · routing.ts · usage.ts · auto-fallback.ts ·    │
│    fallback.ts · state-store.ts · setup.ts · update-check.ts    │
│                                                                 │
│    Pure(ish) functions: read disk → mutate disk under withLock  │
│    → return values. No console output, no process.exit.         │
└────────────────┬────────────────────────────────────────────────┘
                 │  spawned-and-passed-to (CLAUDE_CONFIG_DIR)
                 ▼
                                  ┌─────────────────┐
                                  │  real claude    │
                                  │  (Anthropic     │
                                  │   binary)       │
                                  └─────────────────┘
```

The UI layer (`src/ui/`) sits parallel to commands: when a verb is
interactive (`claude switch`, `claude switch profile`,
`claude switch settings`) the handler delegates to an Ink screen
under `src/ui/screens/` instead of producing line-based output.

```
┌───────────────────────────────────────────────────┐
│  src/ui/run-app.ts (orchestrator)                 │
│    while-true: renderHome() → action → handleX() │
└────────────┬──────────────────────────────────────┘
             │  uses
             ▼
┌───────────────────────────────────────────────────┐
│  src/ui/screens/*.tsx                             │
│    home, manage-account, profiles, settings, ... │
│    each spawns its own Ink tree, returns a       │
│    typed exit value to the orchestrator          │
└───────────────────────────────────────────────────┘
```

## The proxy lifecycle (live OAuth ↔ API-key fallback)

The most non-obvious piece of the runtime. Lives in
`src/api-proxy.ts` and is started from
`src/commands/passthrough.ts` whenever the active account has an API
key saved.

```
user runs `claude foo bar`
        │
        ▼
bin/cli.ts → handlePassthrough(ctx, ['foo', 'bar'])
        │
        ▼
[lock] read active account, run auto-disable + auto-engage
[lock] decide effective auth mode (oauth-first | api-first | oauth-only | error)
        │
        ▼
if effective ∈ {oauth-first, api-first}:
    proxy = startFallbackProxy({ apiKey, mode })   ← localhost:<rand>
    spawn(claude, args, env={
        ...env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:<port>',
        ANTHROPIC_API_KEY: '',                     ← prevent claude bypass
    })
    on exit → proxy.close() → persist counters to .proxy-stats.json
else:
    spawn(claude, args, env)                       ← no proxy at all
```

Inside the proxy, every request claude sends to
`api.anthropic.com` arrives as a local HTTP request. The request
handler then:

```
oauth-first mode:
  shouldTryOauth() ?
    YES → forward(OAuth headers)
          on 402/403/429 status                 → retryWithApiKey
          on 200, peek 16KB body for error envelope:
              looksLikeErrorBody() ?
                YES → retryWithApiKey
                NO  → recordOauthSuccess + pipe through
    NO  → forward(API key headers)              ← inside burst, between probes

api-first mode:
  forward(API key headers) — always

retryWithApiKey:
  recordOauthFailure                            ← counter feeds burst state
  forward(API key headers)
  pipe response through
```

The burst state machine (in oauth-first only): N consecutive OAuth
failures push us into api-burst — every subsequent request goes
straight at the API key, except for one OAuth probe every M minutes.
A successful probe drops us back to oauth-first. This gives live
recovery the moment the subscription's 5-hour window resets.

## The on-read migration story

`~/.claude/accounts/` accumulates compatibility cruft over time
(legacy state markers, pre-Keychain `_apiKey` fields, pre-routing
preferences, etc.). claude-switch never runs an explicit migration
on upgrade. Instead, every reader is responsible for handling both
the new and the legacy shape, and the next writer always writes the
canonical shape:

| Module | Reads (legacy) | Writes (canonical) |
|---|---|---|
| `state-store.ts` | `.fallback-enabled` + `.fallback-auto-engaged` + `.pending-restore` markers | `.claude-switch-state.json` (single versioned blob) |
| `apikey.ts` (darwin) | JSON `_apiKey` field | macOS Keychain entry under `claude-switch-apikey` |
| `accounts.ts save()` | top-level `.claude.json` mutations | per-email JSON snapshot under `accounts/` |
| `profiles.ts` | userID-keyed Keychain entry (pre-v3.5) | per-config-dir Keychain entry (`Claude Code-credentials-<sha8>`) |

The contract for new migrations: read both shapes, prefer canonical,
write canonical. Don't add an explicit migration command — adoption
is opportunistic and idempotent.

## The lock-discipline invariant

`accounts/.lock` is the single mutex protecting every write to
`~/.claude/accounts/` AND to `~/.claude.json`. Two reasons:

1. `claude switch <other>` and `claude` (passthrough) can race —
   without the lock, the active-email read and the API-key write
   can pair email-A's identity with email-B's tokens, billing the
   wrong account.
2. The Keychain write that `accounts.load()` performs after
   updating `~/.claude.json` is rolled back if it fails. The
   rollback only works correctly if it's atomic with the JSON
   write — both must be inside the same lock acquisition.

Helper: `withLock(accountsDirPath, fn)` in `src/lock.ts`. Functions
that already run inside a lock (e.g. `setFallbackEnabledInLock`,
`updateStateInLock`, `savePendingRestoreInLock`) have an `InLock`
suffix; the lock-acquiring variants drop the suffix. Cross-calling
between the two would deadlock — see the v3.4 incident docs in
`docs/internal/error-handling.md` for the canonical example.

## Cross-cutting concerns

### Errors

Two helpers in `src/errors.ts`:
- `ExitError(message, code = 1)` — caller should print message and
  exit with code. Pretty-printed by `bin/cli.ts:handleError`.
- `errMessage(e)`, `errnoCode(e)` — collapse the catch-clause `as`
  cast into one place. See `docs/internal/error-handling.md` for
  the four `try/catch` patterns the codebase uses.

### Tests

`node:test` directly, no Jest / vitest. Conventions:

- `tmpdir` fixtures (every test gets a fresh `os.mkdtempSync(...)`),
  no global mocks.
- Coverage runs in CI via `--experimental-test-coverage`, gated at
  60% line on `ubuntu-latest, 22.x` only (see
  `.github/workflows/ci.yml`).
- macOS Keychain is process-global; tests that would touch it run
  with `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` set, which forces the
  JSON-only path. The dedicated `apikey-keychain.test.ts` and
  `profiles-keychain.test.ts` opt back in for darwin-only smoke
  with unique test-suite-scoped userIDs.
- Real claude integration is exercised via `test/fixtures/claude-mock.mjs`,
  a stub binary that mirrors the real claude's credential lookup
  contract. Spawned by `test/profile-spawn-integration.test.ts`.

### Locks vs lockfile

`src/lock.ts` uses Node's `O_CREAT | O_EXCL` open as a primitive
mutex — if the file exists, the lock is taken. Stale locks (process
died holding the lock) are auto-cleared after 30s via mtime check.
Not appropriate for high-frequency contention; perfectly fine for
the once-per-`claude switch` cadence.

## Where things live (cheat-sheet)

| You want to change… | Edit |
|---|---|
| The CLI parser | `bin/cli.ts` (Command union + `parseCommand`) |
| What `claude switch <verb>` prints | `src/commands/<verb>.ts` |
| The Ink dashboard layout | `src/ui/screens/home.tsx` |
| The OAuth ↔ API-key proxy | `src/api-proxy.ts` |
| Anthropic error matching | `src/api-proxy.ts:looksLikeErrorBody` + the corpus in `test/fixtures/anthropic-errors/` |
| Project-aware routing | `src/routing.ts` (pure resolver) + `src/commands/passthrough.ts` (the swap-and-banner site) |
| OAuth refresh-token client | `src/oauth-refresh.ts` |
| What gets written to `.claude.json` on switch | `src/accounts.ts:load()` |
| The Keychain service-name formula | `src/keychain.ts:claudeKeychainServiceFor` |
| Lock semantics | `src/lock.ts` |
| Migration from a legacy on-disk shape | the consuming module's reader; never write a separate "migrate" verb |

## Things NOT to change without a maintainer review

- The Keychain service-name formula. It's reverse-engineered from
  the production claude binary; getting it wrong means claude can't
  find the credentials at all (silent fallback miss — see the v3.5
  incident).
- The lock-acquiring vs in-lock helper split. Renaming or merging
  them risks deadlocks the test suite won't catch (locks are
  acquired in production but not under contention in unit tests).
- The `looksLikeErrorBody` matcher. Changing the regex set without
  also updating `test/fixtures/anthropic-errors/` makes the proxy
  silently let real Anthropic errors through — see the v3.4
  incident.
- The shape of `~/.claude/accounts/<email>.json`. Several modules
  read it; introducing a new mandatory field needs a migration in
  the reader (the on-read pattern above), not a one-shot upgrade.
