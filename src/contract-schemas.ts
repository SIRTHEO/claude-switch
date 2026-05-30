// src/contract-schemas.ts
// Runtime zod schemas for a subset of the CLI↔GUI boundary shapes declared in
// contract.ts. CLI-ONLY: the GUI never imports this (it stays types-only /
// zero-dep — the generated contract carries plain types). These schemas let the
// CLI validate its OWN `--json` output before emit, catching a handler that
// drifts from the contract at the source.
//
// contract.ts stays the import-free type SSOT; here we mirror a subset and pin
// the two together with a compile-time drift guard (see `_contractSchemaParity`)
// so a schema and its type can never silently diverge. Add a schema here only
// when an emitter is wired to validate against it (or extend the guard).

import { z } from 'zod';
import type * as C from './contract.js';

/** `claude switch list --json` — one entry per saved account. */
export const AccountSummarySchema = z.object({
  email: z.string(),
  alias: z.string().nullable(),
  aliases: z.array(z.string()),
  active: z.boolean(),
});

/** `claude switch alias --list --json` — one entry per alias. */
export const AliasEntrySchema = z.object({
  alias: z.string(),
  email: z.string(),
});

/** `claude switch fallback status --json`. */
export const FallbackStatusSchema = z.object({
  enabled: z.boolean(),
  autoRevert: z.object({ enabled: z.boolean(), threshold: z.number() }),
  autoEngage: z.object({ enabled: z.boolean(), threshold: z.number() }),
  activeAccount: z.string().nullable(),
  hasApiKey: z.boolean(),
});

/** `claude switch route list --json` — one entry per routing rule. */
export const RouteRuleSchema = z.object({
  pattern: z.string(),
  target: z.string(),
  kind: z.enum(['email', 'alias']),
});

// ── Compile-time drift guard ────────────────────────────────────────────────
// `Exact<A, B>` resolves to `true` only when A and B are mutually assignable
// (structurally equal), and to `never` otherwise. Assigning `true` to a `never`
// field is a type error, so tsc fails the build the moment a schema and its
// contract type drift in either direction. Exported so it is not flagged as an
// unused local; it carries no runtime behaviour.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const _contractSchemaParity: {
  accountSummary: Exact<z.infer<typeof AccountSummarySchema>, C.AccountSummary>;
  aliasEntry: Exact<z.infer<typeof AliasEntrySchema>, C.AliasEntry>;
  fallbackStatus: Exact<z.infer<typeof FallbackStatusSchema>, C.FallbackStatus>;
  routeRule: Exact<z.infer<typeof RouteRuleSchema>, C.RouteRule>;
} = {
  accountSummary: true,
  aliasEntry: true,
  fallbackStatus: true,
  routeRule: true,
};
