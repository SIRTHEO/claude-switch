// src/contract.ts
//
// Canonical CLI↔GUI boundary contract. The CLI is the single source of truth:
// every `--json` subcommand the GUI consumes emits one of the shapes below,
// and the matching handler is typed by it (see the `--json` emitters in
// src/commands/*). The GUI does NOT hand-declare these — a generator emits a
// standalone copy consumed by `claude-switch-gui` (see scripts/gen-gui-contract).
//
// INVARIANT: this module is import-free. Every type is self-contained
// (primitives, string unions, inline objects) so the generator is a dumb copy.
// Do not add an `import` here — inline any shared shape instead.

/** Runtime proxy mode exposed by the statusline. */
export type ProxyMode = 'oauth-first' | 'oauth-burst' | 'api-first';

/** Binary auth mode (back-compat field). */
export type AuthMode = 'oauth' | 'api';

/** Four-state effective mode the statusline renders. */
export type EffectiveMode = 'oauth' | 'oauth-burst' | 'api-auto' | 'api';

/** `claude switch list --json` — one entry per saved account. */
export interface AccountSummary {
  email: string;
  /** Primary alias, or null when the account has none. */
  alias: string | null;
  /** All aliases pointing at this account. */
  aliases: string[];
  active: boolean;
}

/** Optional cache-health block embedded in the statusline payload. */
export interface StatuslineCacheHealth {
  hitRatio: number;
  flushCount: number;
  effectiveInputTokens: number;
  turns: number;
}

/** `claude switch sl --json` — full statusline snapshot. */
export interface StatuslineSnapshot {
  email: string | null;
  shortName: string | null;
  mode: AuthMode;
  effectiveMode: EffectiveMode;
  proxyRuntimeMode: ProxyMode | null;
  fallback: boolean;
  fallbackAutoEngaged: boolean;
  hasApiKey: boolean;
  fiveHour: number | null;
  sevenDay: number | null;
  profile: string | null;
  /** Present only when an active Claude Code session JSONL is detectable. */
  cacheHealth?: StatuslineCacheHealth;
}

/** `claude switch usage-snapshot <email> --json`. */
export interface UsageSnapshot {
  email: string;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  ageSec?: number | null;
  fetchedAt?: number | null;
}

/** `claude switch alias --list --json` — one entry per alias. */
export interface AliasEntry {
  alias: string;
  email: string;
}

/** `claude switch fallback status --json`. */
export interface FallbackStatus {
  enabled: boolean;
  autoRevert: { enabled: boolean; threshold: number };
  autoEngage: { enabled: boolean; threshold: number };
}

/** `claude switch profile list --json` — one entry per profile. */
export interface ProfileEntry {
  name: string;
  /** Email the profile is logged into, or null when it needs login. */
  account: string | null;
  hasLogin: boolean;
}

/** `claude switch route list --json` — one entry per routing rule. */
export interface RouteRule {
  pattern: string;
  target: string;
  kind: 'email' | 'alias';
}

/** `claude switch cache-health --json` — standalone cache-health report. */
export interface CacheHealthSnapshot {
  sessionPath: string | null;
  summary: {
    turns: number;
    hitRatio: number;
    flushCount: number;
    effectiveInputTokens: number;
  } | null;
  flushCount: number;
}

/**
 * `claude switch route test [<cwd>] --json` — routing resolution for a path.
 * Named `RouteTestResult` (not `RoutingDecision`) to avoid colliding with the
 * internal `RoutingDecision` in src/routing.ts, which is a different shape.
 */
export interface RouteTestResult {
  cwd: string;
  activeAccount: string | null;
  savedAccounts: string[];
  decision: null | {
    email: string;
    source: string;
    banner: string | null;
    warning: string | null;
    wouldSwitch: boolean;
  };
}
