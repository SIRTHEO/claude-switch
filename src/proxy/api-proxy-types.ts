// src/api-proxy-types.ts
// Types for the fallback proxy (see api-proxy.ts). ProxyRuntimeState is kept
// file-private — it is only referenced by ProxyHandle below.

/** Modes externally chosen by the caller (per-account `authMode`).
 *  `oauth-only` is not a proxy mode — when there's no API key the caller
 *  doesn't start the proxy at all. */
export type ProxyMode = 'oauth-first' | 'api-first';

/** Snapshot of the proxy's runtime state, exposed to callers for diagnostics
 *  and statusline display. */
interface ProxyRuntimeState {
  mode: ProxyMode;
  /** True when oauth-first has temporarily downgraded to API key only after
   *  N consecutive OAuth failures. False in `api-first` mode (always). */
  burstActive: boolean;
  /** How many OAuth attempts in a row have failed without an intervening
   *  successful response. */
  consecutiveOauthFailures: number;
  /** Cumulative request counters since proxy start. Surfaced in
   *  `claude switch status` so the user can confirm whether the proxy
   *  has actually been routing (and how the OAuth ↔ API-key split is
   *  going) instead of having to trust a banner that shows up once. */
  counters: {
    totalRequests: number;
    oauthAttempts: number;
    oauthSuccesses: number;
    oauthFailures: number;
    apiKeyDirectRequests: number;
    apiKeyRetries: number;
    upstreamErrors: number;
    bodySniffsTriggered: number;
    /** Requests dropped by the auth gate (DNS rebinding or browser Origin). */
    rejectedAuth: number;
  };
  /** Reason of the most recent OAuth → API-key retry (e.g. "subscription
   *  returned 429" or "subscription error in response body"). Null when
   *  no retry has happened. */
  lastRetryReason: string | null;
}

export interface ProxyHandle {
  port: number;
  close: (cb?: () => void) => void;
  /** Read the current runtime state (mode + burst flag + counter). */
  state(): ProxyRuntimeState;
}

export interface BurstConfig {
  failureThreshold: number;
  probeIntervalMs: number;
}

export interface StartFallbackProxyOptions {
  apiKey: string;
  mode: ProxyMode;
  upstreamBase?: string;
  maxRequestBodyBytes?: number;
  burstConfig?: Partial<BurstConfig>;
  /** Wall-clock provider for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** When set, the final state snapshot is persisted to this path on
   *  `close()` so the next `claude switch status` can render the
   *  most recent session's counters. */
  persistStatsTo?: string;
  /** Enables realtime usage tracking from upstream response
   *  headers. When BOTH fields are set, the proxy parses
   *  `anthropic-ratelimit-{five-hour,seven-day}-percent-used` (and
   *  documented aliases) from every 2xx upstream response and merges the
   *  values into the per-account cache at `<accountsDirPath>/.usage-cache.<hash>.json`.
   *  Either field unset → header parsing is a no-op (proxy still works
   *  unchanged for callers that don't care about usage). */
  accountsDirPath?: string;
  /** Email of the account whose token authorises this proxy session.
   *  Used as the cache key when `accountsDirPath` is also set. */
  account?: string;
}
