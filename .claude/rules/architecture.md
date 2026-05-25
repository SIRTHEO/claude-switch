# Architecture — `claude-switch` (CLI)

Loaded by the cross-repo rule at `../../../.claude/rules/hexagonal-architecture.md`.
This file pins the CLI-side specifics so future sessions don't re-discover them.

## The four canonical ports — do not invent more

| Port | Module | Production adapter | Test fake pattern |
|---|---|---|---|
| `CredentialStore` | `src/credential-store.ts` | `KeychainAdapter` (darwin) / `NoopCredentialStore` (everywhere else) | inline `CredentialStore` object literal, see `test/accounts-rollback.test.ts` |
| `AccountRepository` | `src/account-repository.ts` | `fsAccountRepo` | inline impl that captures `write` args |
| `HttpPort` | `src/http.ts` | `fetchHttpAdapter` (wraps `globalThis.fetch`) | `fakeFetch(impl)` returning a `Response` |
| `ProcessPort` | `src/process.ts` | `nodeProcessAdapter` | inline `ProcessPort` literal returning `{status, stdout, stderr}` |
| `now: () => number` *(functional)* | passed as `deps.now` | real `Date.now` | fixed value |

Each port is consumed via `deps: { repo?, credentials?, http?, process?, now? }`
on the domain function. Default = the production adapter, so the existing call
sites stay short. Tests inject explicitly.

## What MUST NOT become a port

- `lock.ts` (concurrency primitive; the lock itself is the boundary)
- `atomic-write.ts` (helper of `AccountRepository`)
- `paths.ts` (path roots travel as arguments: `accountsDirPath`, `claudeJsonPath`)
- `errors.ts` (utility module)
- `logger / stderr` (write directly via `process.stderr.write` in CLI surface
  code, never in domain)

## File layout — feature folders

Since 2026-05-25 (Phase 26.5, commit `411829d`) `src/` is organised **by
feature**, not flat and not by technical layer:

```
src/
  accounts/    credentials/  proxy/      routing/   usage/      fallback/
  switching/   profiles/     sessions/   statusline/ setup/     platform/
  commands/    ui/           contract.ts (GUI-contract SSOT, kept at root)
```

A feature folder co-locates that capability's domain logic, its adapters, and
its types. `platform/` holds the shared primitives + ports that **must not**
become domain modules (`lock`, `atomic-write`, `paths`, `errors`, `http`,
`process`). `commands/` (CLI surface) and `ui/` (Ink screens/components) keep
their existing sub-structure. `contract.ts` stays at `src/` root because
`scripts/gen-gui-contract.mjs` reads it by path.

Rules:
- **By feature, not by technical type.** Do **NOT** introduce `src/domain/`,
  `src/ports/`, `src/adapters/` layer folders — that was deliberately rejected
  (it fights the by-feature convention). The naming convention (`*-store`,
  `*-repository`, `*-adapter`, port modules `http.ts`/`process.ts`) still
  carries the hexagonal intent within each feature folder.
- **Imports are plain relative, no barrel `index.ts`.** Barrels risk
  reintroducing import cycles in this interdependent code and force eager
  loading of a whole folder on the CLI startup hot path (which uses lazy
  `await import()` deliberately).
- **Moving a module deeper breaks depth-relative runtime paths.** `dist`
  mirrors the tree, so any `dirname(fileURLToPath(import.meta.url)) + '..'`-walk
  must match the file's depth (see `usage.ts` → `cli.js`, `version.ts` →
  `package.json`). Audit those when relocating a file, and verify on the
  **built** CLI, not just `tsc`.

## Core invariant — enforce by review, not by build

Domain modules do not import:
- `node:fs` (use `AccountRepository`)
- `node:child_process` (use `ProcessPort`)
- `node:https`, `globalThis.fetch` (use `HttpPort`)
- the `security` CLI (use `CredentialStore`)
- `@tauri-apps/*` (GUI-only)

The `hex-boundary gate` (task 20.0) was deferred because the flat layout makes
the allow-list arbitrarily large; the invariant is enforced by code review at
PR time.

## When extending — follow the existing injection style

`oauth-refresh.ts` `deps.http`, `api-proxy.ts` `opts.now`, `switcher.ts`
`SwitcherDeps`, `commands/update.ts` `deps.fetch`, `accounts.ts`
`deps?: { repo?, credentials? }`. **Do not** introduce a DI container or
decorator-based DI.
