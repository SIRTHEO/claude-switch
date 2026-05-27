// src/commands/passthrough.ts
// Default `claude <anything else>` flow — claude-switch's hot path.
//
// 1. Recover from a previous interrupted `--as` session if needed.
// 2. Atomically snapshot (active email, fallback env, auto-revert decision)
//    inside one `withLock` so a concurrent `claude switch B` can't race
//    these reads and pair email-B with email-A's API key.
// 3. Print transition banners (auto-revert / auto-engage / update available).
// 4. Decide proxy mode via `resolveEffectiveAuthMode` and either:
//    - start the local fallback proxy (oauth-first or api-first) and route
//      claude through it, or
//    - spawn claude directly with `extraEnv` (legacy ANTHROPIC_API_KEY
//      injection for accounts without saved keys).
//
// The untracked-key warning, project-aware routing swap, and usage pre-warm
// live in sibling modules (passthrough-warn / passthrough-routing /
// passthrough-prewarm); the public surface is re-exported here.

import { withLock } from '../platform/lock.js';
import { ExitError, errMessage } from '../platform/errors.js';
import { VERSION } from '../setup/version.js';
import { formatUpdateNotice } from '../setup/update-check.js';
import { getCurrent, save, list as listAccounts, syncActiveSnapshotIfStale } from '../accounts/accounts.js';
import { checkPendingRestore } from '../switching/switcher.js';
import { run as proxyRun } from '../proxy/proxy.js';
import { getApiKey } from '../credentials/apikey.js';
import { getTokenHealth } from '../credentials/token.js';
import { fallbackEnvFor } from '../fallback/fallback-env.js';
import {
  maybeAutoDisableFallback,
  maybeAutoEngageFallback,
  maybeInitSmartFallback,
} from '../fallback/auto-fallback.js';
import { readUsageCacheForAccount } from '../usage/usage.js';
import { startFallbackProxy } from '../proxy/api-proxy.js';
import { resolveAccountPrefs, resolveEffectiveAuthMode } from '../switching/preferences.js';
import { findClaude } from './_helpers.js';
import { warnUntrackedApiKeyIfNeeded } from './passthrough-warn.js';
import { resolveRoutingForPassthrough } from './passthrough-routing.js';
import { preWarmUsageForAutoEngage } from './passthrough-prewarm.js';
import type { CommandContext } from './context.js';

export { __resetWarnedOnceForTests, warnUntrackedApiKeyIfNeeded } from './passthrough-warn.js';
export { resolveRoutingForPassthrough } from './passthrough-routing.js';
export type { RoutingForPassthroughInput } from './passthrough-routing.js';

export async function handlePassthrough(
  ctx: CommandContext,
  passthroughArgs: string[],
  deps: { startProxy?: typeof startFallbackProxy; runClaude?: typeof proxyRun } = {},
): Promise<void> {
  const { claudeJsonPath, accountsDirPath, updateInfo } = ctx;
  const startProxy = deps.startProxy ?? startFallbackProxy;
  const runClaude = deps.runClaude ?? proxyRun;

  const restored = checkPendingRestore(claudeJsonPath, accountsDirPath);
  if (restored) {
    console.log(`Restored account: ${restored} (from interrupted --as)\n`);
  }

  // Warn BEFORE any load() call that may purge the key.
  warnUntrackedApiKeyIfNeeded(claudeJsonPath, accountsDirPath);

  const claudeBin = findClaude(ctx.selfUrl);

  // Pre-warm the usage cache when we're approaching auto-engage territory,
  // so maybeAutoEngageFallback below makes a decision based on the actual
  // current quota state. Critical for the "claude said `out of extra usage`
  // mid-session, user re-launches" scenario: without this, the cached
  // value is whatever was last fetched (possibly hours ago, well below the
  // engage threshold), the decision misfires, and the relaunched session
  // hits the same wall again.
  //
  // We only force-fetch when ALL of these hold:
  //   - fallback is currently OFF (otherwise auto-engage is a no-op),
  //   - the active account has an API key (no key → no engage possible),
  //   - the cache is genuinely stale (older than the statusline freshness
  //     window, or belongs to a different account, or never fetched),
  //   - we have an OAuth access token to authenticate the request with.
  //
  // Cost: one HTTPS round-trip (~300-800ms) on the relevant invocation.
  // For a session that's already burning ~5 minutes of inference per
  // exchange, the extra second is invisible. For the cold-start case
  // (cache fresh, no engage needed) we skip entirely — no slowdown.
  await preWarmUsageForAutoEngage(claudeJsonPath, accountsDirPath);

  // Snapshot (active email, fallback env, auto-revert decision) atomically.
  // Without the lock a concurrent `claude switch B` could swap the active
  // email between getCurrent() and fallbackEnvFor(), pairing email-B's
  // identity with email-A's API key — billing the wrong account.
  // Auto-disable runs inside this lock so its setFallbackEnabled(false) is
  // reflected by the fallbackEnvFor() read.
  //
  // Project-aware routing runs FIRST inside this lock. If a
  // .claude-switch / .routing.json / CLAUDE_SWITCH_ACCOUNT decides on a
  // different account, we perform the swap (save+load) before the rest of
  // the snapshot reads, so they all see the final active. Routing is
  // skipped when CLAUDE_CONFIG_DIR is set externally (we are inside an
  // explicit profile chosen by the user — don't override).
  const snapshot = withLock(accountsDirPath, () => {
    // Capture any token the claude binary rotated into `.credentials.json`
    // during the previous session BEFORE any routing swap, so the active
    // account's snapshot keeps a usable refresh token. Without this the
    // snapshot only updated on an explicit `switch`, drifted stale during
    // normal passthrough use, and a later switch-back restored an expired
    // token → re-login. Best-effort + mtime-gated, so it's a no-op (no write)
    // unless the live credentials are actually newer than the snapshot.
    syncActiveSnapshotIfStale(claudeJsonPath, accountsDirPath);

    const initial = getCurrent(claudeJsonPath);
    const accounts = listAccounts(accountsDirPath);

    // Routing resolution + optional in-lock swap
    const routing = resolveRoutingForPassthrough({
      accountsDirPath,
      claudeJsonPath,
      cwd: process.cwd(),
      initialEmail: initial || null,
      savedEmails: accounts,
    });

    const e = routing.flipped ? routing.decision!.email : initial;
    if (!e) return null;

    const wasUnsaved = !accounts.includes(e);
    if (wasUnsaved) save(e, claudeJsonPath, accountsDirPath);
    // Lazy-init smart fallback the first time a key-bearing account is
    // seen with no config file (migrates existing users automatically).
    if (getApiKey(e, accountsDirPath)) maybeInitSmartFallback(accountsDirPath);
    const auto = maybeAutoDisableFallback(accountsDirPath, claudeJsonPath);
    // Auto-engage runs after auto-disable in the same lock so the
    // fallbackEnvFor() read below sees the final flag state. The config
    // invariant `engageThreshold > threshold` guarantees a single call
    // cannot both disable and engage (windows can't be < threshold AND
    // >= engageThreshold simultaneously).
    const engage = maybeAutoEngageFallback(accountsDirPath, claudeJsonPath);
    return {
      email: e,
      wasUnsaved,
      auto,
      engage,
      extraEnv: fallbackEnvFor(e, accountsDirPath),
      routing,
    };
  });
  if (!snapshot) {
    throw new ExitError('No account connected. Run: claude switch add');
  }
  const { email, wasUnsaved, auto, engage, extraEnv, routing } = snapshot;

  // Routing banners — emitted BEFORE the standard "🔑 <email>" banner so
  // the user sees the cause-and-effect chain.
  if (routing.flipped && routing.decision?.banner) {
    process.stderr.write(`${routing.decision.banner}\n\n`);
  } else if (routing.isolatedHint) {
    process.stderr.write(`${routing.isolatedHint}\n\n`);
  }
  if (routing.decision?.warning) {
    process.stderr.write(`${routing.decision.warning}\n\n`);
  }

  if (wasUnsaved) {
    process.stderr.write(`Detected account: ${email} (saved automatically)\n\n`);
  }
  if (auto.disabled) {
    const sevenStr = auto.sevenPct !== undefined ? `, 7d:${auto.sevenPct.toFixed(0)}%` : '';
    process.stderr.write(
      `📈 Subscription back online (5h:${auto.fivePct!.toFixed(0)}%${sevenStr}, ` +
      `threshold ${auto.threshold}%) — switched back to OAuth\n\n`,
    );
  }
  if (engage.engaged) {
    const win = engage.reason === '5h'
      ? `5h:${engage.fivePct!.toFixed(0)}%`
      : `7d:${engage.sevenPct!.toFixed(0)}%`;
    process.stderr.write(
      `📉 Subscription near cap (${win}, threshold ${engage.threshold}%) — ` +
      `switched to API key fallback\n\n`,
    );
  } else if (engage.blocked) {
    process.stderr.write(`⚠ auto-engage wanted to switch to API key but ${engage.blocked}\n\n`);
  }
  if (updateInfo) {
    // Critical updates escalate to a loud banner even here on the hot path
    // (a known security/data-loss bug must not be lost in a quiet hint);
    // routine updates stay a one-liner. Never blocks — claude still launches.
    process.stderr.write(
      formatUpdateNotice(updateInfo, VERSION, { color: process.stderr.isTTY === true }) + '\n',
    );
  }
  // Banner on stderr so we don't pollute structured stdout (e.g. when
  // claude is piped into jq with --output-format json).
  process.stderr.write(`🔑 ${email}\n\n`);
  if (extraEnv) {
    process.stderr.write('(fallback on — using saved API key)\n\n');
  } else {
    // Read-only check: if a recent usage snapshot says we're near the
    // limit and smart fallback isn't enabled (no config + key exists),
    // remind the user to save an API key to unlock auto-switching.
    // Never fetches — only consults whatever the user already cached.
    const cache = readUsageCacheForAccount(accountsDirPath, email);
    if (cache?.payload && cache.payload.five_hour.utilization >= 85 && getApiKey(email, accountsDirPath)) {
      process.stderr.write(
        `⚠ subscription 5h window at ${cache.payload.five_hour.utilization.toFixed(0)}%. ` +
        `Smart fallback will switch to your API key automatically.\n\n`,
      );
    }
  }

  // If the active account has an API key, start the local proxy so the
  // session can transition between OAuth and API live, in BOTH directions.
  //
  // Proxy mode resolution (per-account `authMode` preference + token
  // health, see `resolveEffectiveAuthMode`):
  //   oauth-first  → OAuth first, retry API on 429/error per request,
  //                  enter API-burst sub-state after N consecutive OAuth
  //                  failures + periodic OAuth probe to recover.
  //   api-first    → API key always.
  //   oauth-only   → no proxy needed (no key) — fall through.
  //   error        → no auth available — fall through (claude will fail).
  const activeApiKey = getApiKey(email, accountsDirPath);

  if (activeApiKey) {
    const prefs = resolveAccountPrefs(email, accountsDirPath);
    const tokenHealth = getTokenHealth(claudeJsonPath);
    const oauthHealthy = tokenHealth.status === 'valid' || tokenHealth.status === 'present';
    const effective = resolveEffectiveAuthMode({
      authMode: prefs.authMode,
      oauthHealthy,
      hasApiKey: true,
    });
    // `oauth-only` and `error` mean "don't use the API key" — handled
    // below by falling through to the no-key branch.
    if (effective === 'oauth-first' || effective === 'api-first') {
      let proxy: Awaited<ReturnType<typeof startFallbackProxy>>;
      try {
        proxy = await startProxy({
          apiKey: activeApiKey,
          mode: effective,
          // Persist final counters next to the accounts dir so the next
          // `claude switch status` can render the previous session's
          // proxy stats. Lets the user verify the proxy actually saw
          // traffic / fired retries instead of guessing from a banner.
          persistStatsTo: `${accountsDirPath}/.proxy-stats.json`,
          // Enable realtime usage push from upstream response headers AND
          // runtime-mode marker for the statusline. Both wired together:
          // the marker tells the statusline what mode the proxy is in
          // (oauth-first / oauth-burst / api-first);
          // the header push keeps the per-account usage cache fresh
          // without polling /api/oauth/usage.
          accountsDirPath,
          account: email,
        });
      } catch (e) {
        // The loopback proxy failed to bind/start (port exhaustion, a broken
        // network stack, sandbox without loopback). Degrade gracefully: a
        // wrapper must keep `claude` usable. Fall through to a direct OAuth
        // spawn — the live API-key fallback won't be available this run, so
        // say so instead of silently dropping the capability or hard-failing
        // the whole invocation.
        process.stderr.write(
          `⚠ claude-switch: could not start the fallback proxy (${errMessage(e)}) — ` +
          `running claude on OAuth directly; live API-key fallback is off this session.\n`,
        );
        runClaude(claudeBin, passthroughArgs, extraEnv);
        return;
      }
      process.on('exit', () => proxy.close());

      // Visible confirmation that the live-fallback proxy is in front of
      // claude. Without it, the only signal the user gets is when the
      // proxy actually fires (subscription returned 429 → retried with
      // API key) — and if that path never trips, there's no way to tell
      // if it would. One terse line on stderr makes the architecture
      // legible, so when something goes wrong (or doesn't fall back as
      // expected) the user can debug.
      const modeLabel = effective === 'oauth-first'
        ? 'OAuth subscription, API-key on rate-limit'
        : 'API key';
      process.stderr.write(`⚡ claude-switch proxy active — ${modeLabel}\n`);

      // Clear any inherited ANTHROPIC_API_KEY so the binary uses the proxy
      // and cannot bypass ANTHROPIC_BASE_URL.
      runClaude(claudeBin, passthroughArgs, {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
        ANTHROPIC_API_KEY: '',
      });
      return;
    }
  }
  runClaude(claudeBin, passthroughArgs, extraEnv);
}
