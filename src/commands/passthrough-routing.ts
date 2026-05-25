// src/commands/passthrough-routing.ts
// Project-aware routing for the passthrough hot path: resolve the routing
// decision INSIDE the snapshot lock and, when it picks a different account,
// perform the save+load swap directly (we already hold the accounts-dir lock,
// so we can't call switchTo which re-locks). routing.ts is the pure resolver;
// this is where the swap-and-update lifecycle lives.

import { load, save } from '../accounts.js';
import { getAlias } from '../aliases.js';
import { resolveAccountPrefs } from '../preferences.js';
import { type RoutingDecision, resolveRouting } from '../routing.js';
import { readState, updateStateInLock } from '../state-store.js';

/** Routing snapshot returned to the passthrough caller for banner emission. */
interface RoutingSnapshot {
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
