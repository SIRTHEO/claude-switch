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

import { withLock } from '../lock.js';
import { ExitError } from '../errors.js';
import { VERSION } from '../version.js';
import { getCurrent, save, load, list as listAccounts } from '../accounts.js';
import { checkPendingRestore } from '../switcher.js';
import { run as proxyRun } from '../proxy.js';
import { getApiKey } from '../apikey.js';
import { getTokenHealth } from '../token.js';
import { fallbackEnvFor } from '../fallback-env.js';
import {
  maybeAutoDisableFallback,
  maybeAutoEngageFallback,
  maybeInitSmartFallback,
} from '../auto-fallback.js';
import { readUsageCache } from '../usage.js';
import { startFallbackProxy } from '../api-proxy.js';
import { resolveAccountPrefs, resolveEffectiveAuthMode } from '../preferences.js';
import { resolveRouting, type RoutingDecision } from '../routing.js';
import { readState, updateStateInLock } from '../state-store.js';
import { getAlias } from '../aliases.js';
import { findClaude } from './_helpers.js';
import type { CommandContext } from './context.js';

export async function handlePassthrough(
  ctx: CommandContext,
  passthroughArgs: string[],
): Promise<void> {
  const { claudeJsonPath, accountsDirPath, updateInfo } = ctx;

  const restored = checkPendingRestore(claudeJsonPath, accountsDirPath);
  if (restored) {
    console.log(`Restored account: ${restored} (from interrupted --as)\n`);
  }

  const claudeBin = findClaude(ctx.selfUrl);

  // Snapshot (active email, fallback env, auto-revert decision) atomically.
  // Without the lock a concurrent `claude switch B` could swap the active
  // email between getCurrent() and fallbackEnvFor(), pairing email-B's
  // identity with email-A's API key — billing the wrong account.
  // Auto-disable runs inside this lock so its setFallbackEnabled(false) is
  // reflected by the fallbackEnvFor() read.
  //
  // Phase 10c: project-aware routing runs FIRST inside this lock. If a
  // .claude-switch / .routing.json / CLAUDE_SWITCH_ACCOUNT decides on a
  // different account, we perform the swap (save+load) before the rest of
  // the snapshot reads, so they all see the final active. Routing is
  // skipped when CLAUDE_CONFIG_DIR is set externally (we are inside an
  // explicit profile chosen by the user — don't override).
  const snapshot = withLock(accountsDirPath, () => {
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
    process.stderr.write(
      `↥ claude-switch ${VERSION} → ${updateInfo.latestVersion} available\n` +
      `  Update manually: ${updateInfo.installCommand}\n\n`,
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
    const cache = readUsageCache(accountsDirPath);
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
      const proxy = await startFallbackProxy({
        apiKey: activeApiKey,
        mode: effective,
      });
      process.on('exit', () => proxy.close());
      // Clear any inherited ANTHROPIC_API_KEY so the binary uses the proxy
      // and cannot bypass ANTHROPIC_BASE_URL.
      proxyRun(claudeBin, passthroughArgs, {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
        ANTHROPIC_API_KEY: '',
      });
      return;
    }
  }
  proxyRun(claudeBin, passthroughArgs, extraEnv);
}

/** Routing snapshot returned to the passthrough caller for banner emission.
 *  Exported for tests; `routing.ts` is the pure resolver, this module is
 *  where the swap-and-update lifecycle lives. */
export interface RoutingSnapshot {
  decision: RoutingDecision | null;
  /** True when we actually flipped the active account inside the snapshot
   *  lock. False for: same-as-active, 0-match warnings, isolated-target
   *  (which gets its own hint instead). */
  flipped: boolean;
  /** Set when routing wanted to flip but the target is `defaultIsolated`
   *  — we emit a hint suggesting the user run the profile flow rather
   *  than silently overriding their isolation intent. */
  isolatedHint?: string;
}

export interface RoutingForPassthroughInput {
  accountsDirPath: string;
  claudeJsonPath: string;
  cwd: string;
  initialEmail: string | null;
  savedEmails: string[];
}

/**
 * Resolve routing INSIDE the passthrough snapshot lock and, if the resolver
 * decides on a different account, perform the in-lock swap by directly
 * calling `save` + `load` (the primitives `switchTo` wraps). We can't call
 * `switchTo` itself because it acquires its own `withLock`, and we already
 * hold the accounts-dir lock here.
 *
 * Skip rules:
 *   - CLAUDE_CONFIG_DIR set externally → user is in a profile, don't override
 *   - resolver returns null → no opinion, caller proceeds with active
 *   - target email == active → resolver matched the active, silent
 *   - target email not saved → defensive guard (resolver should already
 *     have filtered, but listing can race with this read in pathological
 *     cases)
 *   - target has `defaultIsolated: true` → emit hint, do NOT flip
 */
export function resolveRoutingForPassthrough(input: RoutingForPassthroughInput): RoutingSnapshot {
  const { accountsDirPath, claudeJsonPath, cwd, initialEmail, savedEmails } = input;

  // Hard skip: user already chose a profile via CLAUDE_CONFIG_DIR. Profile
  // is an explicit choice; routing must not override it.
  if (process.env.CLAUDE_CONFIG_DIR) {
    return { decision: null, flipped: false };
  }

  const lastUsedByDomain = readState(accountsDirPath).lastUsedByDomain ?? {};
  const decision = resolveRouting({
    cwd,
    accountsDirPath,
    env: process.env,
    activeEmail: initialEmail,
    savedEmails,
    lastUsedByDomain,
    resolveAlias: (a) => getAlias(a, accountsDirPath),
  });

  if (!decision) {
    return { decision: null, flipped: false };
  }

  // Resolver matched the active account — nothing to do, but pass through
  // any warning (e.g. 0-match fallback) so the caller can surface it.
  if (decision.email === initialEmail) {
    return { decision, flipped: false };
  }

  // Defensive: only swap to accounts we actually have on disk.
  if (!savedEmails.includes(decision.email)) {
    return { decision, flipped: false };
  }

  // Respect `defaultIsolated`: the user marked this account as
  // "always launch isolated" — we must not flip the global active. Tell
  // them how to launch via profile instead.
  const targetPrefs = resolveAccountPrefs(decision.email, accountsDirPath);
  if (targetPrefs.defaultIsolated) {
    return {
      decision,
      flipped: false,
      isolatedHint:
        `🎯 .claude-switch wants ${decision.email}, which is set to "isolated" — ` +
        `run: claude switch profile use <profile-for-${decision.email}>`,
    };
  }

  // Perform the in-lock swap (mirrors switchTo's body without re-locking).
  if (initialEmail) {
    save(initialEmail, claudeJsonPath, accountsDirPath);
  }
  load(decision.email, claudeJsonPath, accountsDirPath);

  // Update lastUsedByDomain so future N-match decisions stabilise on the
  // account the user actually uses for this domain.
  const domain = decision.email.includes('@')
    ? decision.email.slice(decision.email.lastIndexOf('@') + 1).toLowerCase()
    : null;
  if (domain) {
    updateStateInLock(accountsDirPath, (state) => ({
      ...state,
      lastUsedByDomain: {
        ...(state.lastUsedByDomain ?? {}),
        [domain]: decision.email,
      },
    }));
  }

  return { decision, flipped: true };
}
