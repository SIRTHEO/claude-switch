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
  /** Canonical account email (field is named `account`, not `email`). */
  account: string;
  fetchedAt: number | null;
  ageSec: number | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  sevenDayOpusPct: number | null;
  sevenDaySonnetPct: number | null;
  rateLimitedUntil: number | null;
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
  activeAccount: string | null;
  hasApiKey: boolean;
}

/** `claude switch profile list --json` — one entry per profile. */
export interface ProfileEntry {
  name: string;
  /** Email the profile is logged into, or null when it needs login. */
  account: string | null;
  hasLogin: boolean;
  /** Absolute config directory for the profile (`~/.claude/profiles/<name>`).
   *  Consumers spawn an isolated `claude` by setting `CLAUDE_CONFIG_DIR` to
   *  this path. */
  path: string;
}

/** `claude switch skills list --json` — one entry per globally installed skill. */
export interface SkillEntry {
  name: string;
  /** First line of the SKILL.md description, or null when absent. */
  description: string | null;
  /** Origin of the skill. Currently only the user skills dir is inventoried. */
  source: 'user';
  /** Absolute path to the skill directory. */
  path: string;
}

/** `claude switch profile skills list <p> --json` — one entry per skill known
 *  to the profile (global skills, linked or available, plus broken links). */
export interface ProfileSkillEntry {
  name: string;
  /** A symlink for this skill exists in the profile's skills dir. */
  linked: boolean;
  /** The link exists but its global target is gone. */
  broken: boolean;
  /** Absolute path of the global skill dir (the link target). */
  path: string;
}

/** Transport an MCP server speaks. */
export type McpTransport = 'stdio' | 'sse' | 'http';

/** `claude switch profile mcp list <p> --json` — one entry per MCP server
 *  known to the profile: configured in it, available in the global config to
 *  compose, or both. */
export interface ProfileMcpEntry {
  name: string;
  /** Present in this profile's `.claude.json` `mcpServers`. */
  configured: boolean;
  /** Present in the global `~/.claude.json` `mcpServers` (composable). */
  inGlobal: boolean;
  /** Configured AND in global, but the composed copy differs from the current
   *  global definition — it has gone stale. False otherwise. */
  globalDrift: boolean;
  /** Transport of the effective definition (the profile's when configured,
   *  else the global one), or null when neither resolves. */
  transport: McpTransport | null;
  /** One-line summary of the effective definition: the command (stdio) or the
   *  url (sse/http). Null when neither resolves. */
  detail: string | null;
}

/** `claude switch route list --json` — one entry per routing rule. */
export interface RouteRule {
  pattern: string;
  target: string;
  kind: 'email' | 'alias';
}

/**
 * Full cache-health summary. Mirrors the domain `CacheHealthSummary` in
 * src/cache-health.ts — kept structurally identical so the handler's emit
 * type-checks against this contract (the enforcement seam).
 */
export interface CacheHealthSummary {
  turns: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalInput: number;
  hitRatio: number;
  flushCount: number;
  effectiveInputTokens: number;
  lastFlushAt: number | null;
}

/** One detected cache-flush turn in the cache-health report. */
export interface FlushEvent {
  turn: number;
  line: number;
  timestamp: string | null;
}

/** `claude switch cache-health --json` — standalone cache-health report. */
export interface CacheHealthReport {
  summary: CacheHealthSummary;
  sessionPath: string;
  flushes: FlushEvent[];
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
