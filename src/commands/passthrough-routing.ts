// src/commands/passthrough-routing.ts
// Project-aware routing for the passthrough hot path: resolve the routing
// decision INSIDE the snapshot lock. When a cwd rule picks a DIFFERENT account,
// routing is EPHEMERAL (decision B2): it launches that account ISOLATED in its
// own credential dir — it never rewrites the shared ~/.claude (the Phase-28
// token-mixing bug) and never touches the sticky default-pointer. routing.ts is
// the pure resolver; this module turns its decision into an isolated-launch
// signal. The synchronous resolver only DECIDES (and, when a logged-in overlay
// already exists, fully resolves the launch dir); minting a profile on demand
// is async (ensureProfileForAccount does a network token refresh) and therefore
// runs in the handler OUTSIDE this snapshot lock — see runIsolatedOrRefuse.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAlias } from '../switching/aliases.js';
import { resolveAccountPrefs } from '../switching/preferences.js';
import { type RoutingDecision, resolveRouting } from '../routing/routing.js';
import { readState, updateStateInLock } from '../switching/state-store.js';
import { globalBoundSessions, listLiveSessions } from '../sessions/session-registry.js';

/** Routing snapshot returned to the passthrough caller. */
export interface RoutingSnapshot {
  decision: RoutingDecision | null;
  /** B2: launch the routed account in its own isolated dir instead of swapping
   *  the global account. Set when an existing logged-in overlay was found by the
   *  (sync) resolver. The caller spawns claude with `CLAUDE_CONFIG_DIR=configDir`. */
  launchIsolated?: { email: string; configDir: string };
  /** B2 create-on-demand: routing picked a different account with no existing
   *  overlay. The async handler mints the profile via `ensureProfileForAccount`
   *  (off the snapshot lock) then launches it isolated — or refuses if the minted
   *  profile still needs a login. */
  mintIsolated?: { email: string };
  /** Banner to print before the isolated launch. Set alongside `launchIsolated`
   *  or `mintIsolated`. */
  launchIsolatedBanner?: string;
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
  cwd: string;
  initialEmail: string | null;
  savedEmails: string[];
}

/**
 * Resolve project-aware routing INSIDE the passthrough snapshot lock and turn a
 * "different account" decision into an isolated-launch signal (decision B2 —
 * routing never swaps the global account). Stays SYNCHRONOUS: it decides, runs
 * the conflict/banner reads, updates routing memory, and — when a logged-in
 * overlay already exists — fully resolves the launch dir. When no overlay
 * exists it emits `mintIsolated` so the (async) handler can create the profile
 * on demand off the lock.
 *
 * Skip rules (return decision-only — caller proceeds with the active account):
 *   - CLAUDE_CONFIG_DIR set externally → user is in a profile, don't override
 *   - resolver returns null → no opinion
 *   - target email == active → resolver matched the active (surface any warning)
 *   - target email not saved → defensive guard (resolver should already have
 *     filtered, but listing can race with this read in pathological cases)
 */
export function resolveRoutingForPassthrough(input: RoutingForPassthroughInput): RoutingSnapshot {
  const { accountsDirPath, cwd, initialEmail, savedEmails } = input;

  // Hard skip: user already chose a profile via CLAUDE_CONFIG_DIR. Profile
  // is an explicit choice; routing must not override it.
  if (process.env.CLAUDE_CONFIG_DIR) {
    return { decision: null };
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
    return { decision: null };
  }

  // Resolver matched the active account — nothing to launch isolated, but pass
  // through any warning (e.g. 0-match fallback) so the caller can surface it.
  if (decision.email === initialEmail) {
    return { decision };
  }

  // Defensive: only act on accounts we actually have on disk.
  if (!savedEmails.includes(decision.email)) {
    return { decision };
  }

  // A cwd rule picked a DIFFERENT, saved account. B2: launch it ISOLATED — never
  // swap the global ~/.claude (which would corrupt a concurrent global session's
  // tokens) and never touch the sticky default-pointer.
  // Update lastUsedByDomain (routing memory, NOT the pointer) so future N-match
  // decisions stabilise on the account the user routes to for this domain. This
  // records the routing INTENT regardless of the target's login state — a routed
  // account that still needs a login is re-prompted, not silently skipped.
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

  const launchIsolatedBanner = isolatedLaunchBanner(decision, accountsDirPath);

  // Prefer an existing logged-in overlay (sync, cheap on the hot path). Else
  // signal the handler to mint the profile on demand — ensureProfileForAccount
  // is async (network token refresh) and lives in the heavy profiles module, so
  // it must run OUTSIDE this lock and off the eager import graph.
  const overlayDir = findLoggedInOverlayDir(decision.email);
  if (overlayDir) {
    return {
      decision,
      launchIsolated: { email: decision.email, configDir: overlayDir },
      launchIsolatedBanner,
    };
  }
  return {
    decision,
    mintIsolated: { email: decision.email },
    launchIsolatedBanner,
  };
}

/**
 * Banner shown before an isolated launch, flavoured by why we isolated:
 *   - another account is live global-bound → token-clash avoidance
 *   - the target opted into "always isolated"
 *   - plain cwd routing → the routing-source banner from routing.ts
 * Read-only: the conflict/prefs reads here never mutate state.
 */
function isolatedLaunchBanner(decision: RoutingDecision, accountsDirPath: string): string {
  const conflict = globalBoundSessions(listLiveSessions(accountsDirPath)).some(
    (s) => s.account !== null && s.account !== decision.email,
  );
  if (conflict) {
    return `🛡  ${decision.email} → isolated session (another account is live as the global login — avoiding a token clash)`;
  }
  if (resolveAccountPrefs(decision.email, accountsDirPath).defaultIsolated) {
    return `🔑 ${decision.email} (isolated · "always isolated" setting)`;
  }
  return decision.banner ?? `🎯 ${decision.email} → isolated session (routed)`;
}
