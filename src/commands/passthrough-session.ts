// src/commands/passthrough-session.ts
// Live-session recording + the 28.4 isolate/refusal launch, split out of
// passthrough.ts to keep that hot-path handler within the file-size budget.

import { ExitError } from '../platform/errors.js';
import type { run as proxyRun } from '../proxy/proxy.js';
import { markSessionLive } from '../sessions/session-registry.js';
import type { RoutingSnapshot } from './passthrough-routing.js';

/**
 * Record this wrapper process as a live claude session (best-effort). The pid
 * is `process.pid`, which lives for the spawned claude's lifetime on the
 * spawn-and-wait paths; prune-on-read reclaims it on exit. `configDir` null =
 * global-bound; a profile shell's CLAUDE_CONFIG_DIR marks it isolated.
 *
 * NB for 28.4: in passthrough this is called AFTER the routing swap (fine for
 * observability); the prevention decision reads the registry BEFORE the swap
 * inside `resolveRoutingForPassthrough`.
 */
export function recordPassthroughSession(
  accountsDirPath: string,
  account: string,
  configDir: string | null,
): void {
  markSessionLive(accountsDirPath, { account, configDir, cwd: process.cwd() });
}

/**
 * 28.4 — act on routing's token-mixing decision. Either launches the target's
 * isolated overlay (its own credential file → immune to global swaps) and never
 * returns, or throws an actionable refusal. Reached only when the routing
 * snapshot carries `launchIsolated` or `conflictRefusal`.
 */
export function runIsolatedOrRefuse(
  routing: RoutingSnapshot,
  claudeBin: string,
  args: string[],
  accountsDirPath: string,
  runClaude: typeof proxyRun,
): void {
  // No ready overlay → refuse rather than mix tokens / run the wrong account.
  if (!routing.launchIsolated) {
    throw new ExitError(routing.conflictRefusal ?? 'No account connected. Run: claude switch add');
  }
  if (routing.launchIsolatedBanner) {
    process.stderr.write(`${routing.launchIsolatedBanner}\n\n`);
  }
  recordPassthroughSession(accountsDirPath, routing.launchIsolated.email, routing.launchIsolated.configDir);
  // `runClaude` (proxyRun) never returns in production; the caller adds an
  // explicit `return` so a non-blocking test fake can't fall through.
  runClaude(claudeBin, args, { CLAUDE_CONFIG_DIR: routing.launchIsolated.configDir });
}

/**
 * Default-pointer divert (unified-profile model, slice 4a). When bare `claude`
 * resolves to a NON-default workspace, run that profile isolated — its OWN
 * credential file via `CLAUDE_CONFIG_DIR` — bypassing the global-account
 * snapshot, and never return. Refuses (ExitError) when the pointed profile has
 * no login rather than launching a broken session.
 *
 * No api-key fallback proxy on this path: it runs on the profile's OAuth only
 * (same as `runIsolatedOrRefuse`). Generalizing the fallback proxy to profiles
 * is later work — named here so it isn't a silent gap.
 */
export async function launchPointedWorkspace(
  pointed: { name: string; configDir: string },
  claudeBin: string,
  args: string[],
  accountsDirPath: string,
  runClaude: typeof proxyRun,
): Promise<void> {
  const { readProfile } = await import('../profiles/profiles.js');
  const info = readProfile(pointed.name);
  if (!info.hasLogin) {
    throw new ExitError(
      `Default workspace "${pointed.name}" has no login yet. ` +
      `Run: claude switch profile login ${pointed.name}`,
    );
  }
  recordPassthroughSession(accountsDirPath, info.emailAddress ?? pointed.name, pointed.configDir);
  runClaude(claudeBin, args, { CLAUDE_CONFIG_DIR: pointed.configDir });
}
