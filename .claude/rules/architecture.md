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

## File layout — pragmatic flat, not folder-split

Current state: every domain module lives directly under `src/*.ts`. Sub-folders
exist only for genuine sub-systems: `src/commands/*.ts` (the CLI surface),
`src/ui/screens/*.tsx` (Ink screens), `src/ui/components/`.

**Do not** introduce `src/domain/`, `src/ports/`, `src/adapters/` folder split
unless a future task explicitly approves it. Reason: the flat layout is
load-bearing for existing imports across ~70 modules; a move would invalidate
~150 import paths for no behavioural gain. The naming convention (`*-store`,
`*-repository`, `*-adapter`, port modules: `http.ts`, `process.ts`) carries
the architectural intent without a folder split.

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
