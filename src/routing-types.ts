// src/routing-types.ts
// Shared types for project-aware account routing. See routing.ts for the
// resolver and the resolution order.

export interface ClaudeSwitchMatch {
  email?: string;
  emailDomain?: string;
  any?: ClaudeSwitchMatch[];
  disable?: boolean;
}

export interface ClaudeSwitchFile {
  match?: ClaudeSwitchMatch;
}

export interface RoutingFile {
  version: 1;
  rules: RoutingRule[];
}

export interface RoutingRule {
  match: string;
  account?: string;
  alias?: string;
}

type RoutingSource =
  | 'env'
  | 'claude-switch-file'
  | 'global-rules';

export interface RoutingDecision {
  /** Canonical email of the chosen account. */
  email: string;
  source: RoutingSource;
  /** stderr-friendly banner line (without trailing newline). Optional —
   *  the env source is silent when it matches the active account. */
  banner?: string;
  /** Warning to surface in addition to the chosen email — used for the
   *  0-match fallback case to make the misalignment visible. */
  warning?: string;
}

export interface ResolveRoutingInput {
  cwd: string;
  accountsDirPath: string;
  env: NodeJS.ProcessEnv;
  /** Currently active email (from getCurrent()) or null. */
  activeEmail: string | null;
  /** All locally saved account emails. */
  savedEmails: string[];
  /** Snapshot from state.json: emailDomain → email of the last account
   *  routed to under that domain. Empty object is fine. */
  lastUsedByDomain: Record<string, string>;
  /** Optional resolver for local aliases → email. Used by global rules
   *  whose `alias` field needs to be canonicalised before matching against
   *  `savedEmails`. Returns null when the alias is unknown. */
  resolveAlias?: (alias: string) => string | null;
}
