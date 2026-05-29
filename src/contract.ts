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

/** Severity of a single doctor finding. `ok` = healthy, `warn` = degraded but
 *  usable, `error` = will break a swap or show stale data until fixed. */
export type DoctorSeverity = 'ok' | 'warn' | 'error';

/** One credential-health finding from `claude switch doctor --json`. */
export interface DoctorFinding {
  /** Stable machine id so the GUI can map a finding to a fix action /
   *  localized string. e.g. 'snapshot-token-collision', 'usage-rate-limited'. */
  code: string;
  severity: DoctorSeverity;
  /** Human-readable one-liner (English; the GUI may localize off `code`). */
  message: string;
  /** Whether `claude switch doctor --fix` can remediate this automatically. */
  fixable: boolean;
}

/**
 * `claude switch doctor --json` — credential-store health snapshot. Read-only;
 * surfaces the conditions that silently break swaps or freeze the statusline
 * (snapshot token collisions, provenance mismatches, a rate-limited usage
 * cache, an undrained Keychain item on macOS). The GUI renders findings and
 * offers `--fix` for the `fixable` ones.
 */
export interface DoctorReport {
  /** Worst severity across all findings — drives the GUI's overall badge. */
  status: DoctorSeverity;
  /** Active account email per `~/.claude.json`, or null when none. */
  activeAccount: string | null;
  findings: DoctorFinding[];
  /** True on macOS when a `Claude Code-credentials` Keychain item is still
   *  present (reconcile will drain it on the next foreground command). */
  keychainItemPresent: boolean;
}

// ---------------------------------------------------------------------------
// Versions / update-availability surface (claude switch versions)
// ---------------------------------------------------------------------------

/** How the binary was installed on this machine. Drives both the latest-version
 *  lookup channel and the eventual update command (SH-UPD-2). */
export type VersionSource = 'npm' | 'brew' | 'manual' | 'unknown';

/** One row in the versions report — same shape for all three targets so the
 *  GUI table renders uniformly. */
export interface VersionTarget {
  /** Installed version (no leading `v`), or null when not installed / not
   *  detected. The `gui` target is always null here — the GUI overrides it
   *  with its own `package.json` version in the hook layer (the CLI has no
   *  reliable way to know which GUI build the user is running). */
  current: string | null;
  /** Latest known version from the source registry (no leading `v`), or null
   *  when the registry was unreachable / not applicable. */
  latest: string | null;
  /** Where the binary lives — drives the upgrade channel. `unknown` means
   *  the install method couldn't be sniffed; `manual` means it was sniffed
   *  but we don't automate updates for that channel in v1. */
  source: VersionSource;
  /** True when `current` and `latest` are both set and `latest` is strictly
   *  semver-greater than `current`. Pre-releases never count as upgrades. */
  upgradable: boolean;
  /** ISO timestamp of the last successful registry lookup feeding `latest`.
   *  Lets the GUI render "checked 12 min ago". */
  lastCheckedAt: string;
  /** Human-readable URL to consult when `source === 'manual'` (or when
   *  automated upgrade is otherwise unavailable). Omitted otherwise. */
  manualUrl?: string;
}

/** Shape of `claude switch versions --json`. */
export interface VersionsReport {
  claude: VersionTarget;
  switch: VersionTarget;
  gui: VersionTarget;
}

/** The three things `claude switch update <target>` can act on. */
export type UpdateTarget = 'claude' | 'switch' | 'gui';

/** Shape of `claude switch update <target> --json` — one line the GUI consumes.
 *  A discriminated union over the five emit paths so a field rename in the
 *  command handler breaks the compiler instead of silently drifting from the
 *  GUI parser. `from`/`to` are versions (no leading `v`), null when unknown. */
export type UpdateResult =
  | { ok: true; target: UpdateTarget; from: string | null; to: string | null }
  | { ok: true; target: UpdateTarget; check: true; command: string; from: string | null; to: string | null }
  | { ok: true; target: UpdateTarget; manualUrl: string; from: string | null; to: string | null }
  | { ok: false; target: UpdateTarget; error: string; exitCode: number | null }
  | { ok: false; target: UpdateTarget; error: string; source: VersionSource; manualUrl: string; exitCode: number };
