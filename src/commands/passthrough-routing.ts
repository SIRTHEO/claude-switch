// src/commands/passthrough-routing.ts
// Project-aware routing for the passthrough hot path: resolve the routing
// decision INSIDE the snapshot lock and, when it picks a different account,
// perform the save+load swap directly (we already hold the accounts-dir lock,
// so we can't call switchTo which re-locks). routing.ts is the pure resolver;
// this is where the swap-and-update lifecycle lives.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, save } from '../accounts/accounts.js';
import { getAlias } from '../switching/aliases.js';
import { resolveAccountPrefs } from '../switching/preferences.js';
import { type RoutingDecision, resolveRouting } from '../routing/routing.js';
import { readState, updateStateInLock } from '../switching/state-store.js';
import { globalBoundSessions, listLiveSessions } from '../sessions/session-registry.js';

/** Routing snapshot returned to the passthrough caller for banner emission. */
export interface RoutingSnapshot {
  decision: RoutingDecision | null;
  /** True when we actually flipped the active account inside the snapshot
   *  lock. False for: same-as-active, 0-match warnings, isolated-target
   *  (which gets its own hint / isolated launch instead). */
  flipped: boolean;
  /** Set when routing wanted to flip but the target is `defaultIsolated` and no
   *  ready overlay exists — we emit a hint rather than silently overriding the
   *  isolation intent. */
  isolatedHint?: string;
  /** 28.4: launch the target in its own isolated overlay (its `configDir`)
   *  instead of a global swap — set when a global swap would clash with a live
   *  session, or the target is `defaultIsolated`, AND a logged-in overlay
   *  exists. The caller spawns claude with `CLAUDE_CONFIG_DIR=configDir`. */
  launchIsolated?: { email: string; configDir: string };
  /** Banner to print before the isolated launch. */
  launchIsolatedBanner?: string;
  /** 28.4: a global swap would corrupt a live session's tokens and no ready
   *  overlay exists — refuse the launch with this actionable message rather
   *  than mix tokens or run the wrong account. */
  conflictRefusal?: string;
}

/** Marker file written by `createOverlayProfile`. */
const OVERLAY_MARKER = '.cs-overlay';

/**
 * Find a logged-in OVERLAY profile dir for `email`, reading the profiles tree
 * directly via fs. Deliberately NOT routed through `profiles.ts` — that module
 * is heavy (Keychain, oauth-refresh, …) and importing it here would pull it
 * onto the passthrough hot path's eager import graph. An overlay shares the
 * global skills + projects (symlinks), so launching it isolated costs ~nothing
 * in UX. Returns null when no logged-in overlay for `email` exists.
 */
function findLoggedInOverlayDir(email: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'profiles');
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null; // no profiles dir → none
  }
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(path.join(dir, OVERLAY_MARKER)).isFile()) continue; // not an overlay
    } catch {
      continue; // no marker → skip
    }
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf-8')) as {
        oauthAccount?: { emailAddress?: unknown };
      };
      if (cfg.oauthAccount?.emailAddress === email) return dir; // logged-in overlay for this account
    } catch {
      // missing/invalid config → not logged in, skip
    }
  }
  return null;
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

  const targetPrefs = resolveAccountPrefs(decision.email, accountsDirPath);

  // 28.4 — token-mixing prevention. A global swap rewrites the shared
  // ~/.claude/.credentials.json; if another account is ALREADY running
  // global-bound, swapping now corrupts both sessions' tokens (the "one token
  // good, the other bad" breakage). Read the live registry BEFORE the swap —
  // this process records itself only AFTER routing (in handlePassthrough), so
  // we see other sessions, not ourselves. `defaultIsolated` takes the same
  // isolation path even without a live clash (the user's explicit intent; this
  // also unifies the formerly hint-only behaviour with run-app's auto-isolate).
  const conflict = globalBoundSessions(listLiveSessions(accountsDirPath)).some(
    (s) => s.account !== null && s.account !== decision.email,
  );
  const forceSwap = process.env.CLAUDE_SWITCH_FORCE_SWAP === '1';

  if ((conflict || targetPrefs.defaultIsolated) && !forceSwap) {
    const overlayDir = findLoggedInOverlayDir(decision.email);
    if (overlayDir) {
      return {
        decision,
        flipped: false,
        launchIsolated: { email: decision.email, configDir: overlayDir },
        launchIsolatedBanner: conflict
          ? `🛡  ${decision.email} → isolated session (another account is live as the global login — avoiding a token clash)`
          : `🔑 ${decision.email} (isolated · "always isolated" setting)`,
      };
    }
    if (conflict) {
      // A live session would be corrupted and there is no ready overlay to fall
      // back to. Refuse rather than mix tokens or silently run the wrong
      // account. (Auto-creating the overlay here is deferred to 28.4b.)
      return {
        decision,
        flipped: false,
        conflictRefusal:
          `Refusing to switch to ${decision.email}: another account is already running as the ` +
          `global login, and swapping now would corrupt both sessions' tokens. Give ` +
          `${decision.email} its own isolated overlay once:\n` +
          `  claude switch profile create <name> --as-global\n` +
          `  claude switch profile login <name>\n` +
          `then re-run here. (Override at your own risk: CLAUDE_SWITCH_FORCE_SWAP=1.)`,
      };
    }
    // defaultIsolated, no live clash, no ready overlay → non-destructive hint
    // (nothing dangerous is live, so don't block — just suggest the profile flow).
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
