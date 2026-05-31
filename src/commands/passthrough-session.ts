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
 * NB for 28.4: the routing conflict decision reads the registry BEFORE this
 * process records itself (inside `resolveRoutingForPassthrough`), so it sees
 * other sessions, not ourselves.
 */
export function recordPassthroughSession(
  accountsDirPath: string,
  account: string,
  configDir: string | null,
): void {
  markSessionLive(accountsDirPath, { account, configDir, cwd: process.cwd() });
}

/**
 * Seed a disposable per-session work dir from the resolved canonical profile,
 * record the live session against the WORK dir, and spawn claude there — never
 * in the canonical dir itself, so a future live migration can rewrite this
 * session's dir without corrupting the account's store. Shared by the routing
 * and default-pointer isolated launch paths (identical shape). `runClaude`
 * never returns in production.
 */
async function launchInSeededWorkDir(
  canonicalDir: string,
  account: string,
  accountsDirPath: string,
  claudeBin: string,
  args: string[],
  runClaude: typeof proxyRun,
): Promise<void> {
  const { prepareSessionWorkDir } = await import('../sessions/session-workdir.js');
  const workDir = prepareSessionWorkDir(canonicalDir, accountsDirPath);
  recordPassthroughSession(accountsDirPath, account, workDir);
  runClaude(claudeBin, args, { CLAUDE_CONFIG_DIR: workDir });
}

/**
 * 28.4 / B2 — turn routing's isolation decision into a launch. Resolves the
 * routed account to its own credential dir and spawns claude there
 * (CLAUDE_CONFIG_DIR set, no global swap) — minting the profile on demand when
 * no logged-in overlay exists yet (B2 create-on-demand). Throws an actionable
 * refusal when the minted profile still needs a login (don't launch a broken
 * session). Async because `ensureProfileForAccount` is (network token refresh)
 * and lives in the heavy profiles module — lazily imported here so it stays off
 * the passthrough hot path's eager import graph, and runs OUTSIDE the snapshot
 * lock. Reached only when the snapshot carries `launchIsolated` or `mintIsolated`.
 */
export async function runIsolatedOrRefuse(
  routing: RoutingSnapshot,
  claudeBin: string,
  args: string[],
  accountsDirPath: string,
  runClaude: typeof proxyRun,
): Promise<void> {
  let launch = routing.launchIsolated;

  // No existing overlay → mint the routed account's profile on demand (B2).
  if (!launch && routing.mintIsolated) {
    const { ensureProfileForAccount } = await import('../profiles/profiles.js');
    const result = await ensureProfileForAccount(routing.mintIsolated.email, accountsDirPath);
    if (result.needsLogin) {
      throw new ExitError(
        `${routing.mintIsolated.email} is routed here but its isolated profile ` +
        `has no login yet. Run: claude switch profile login ${result.profileName}`,
      );
    }
    launch = { email: routing.mintIsolated.email, configDir: result.profilePath };
  }

  if (!launch) {
    throw new ExitError('No account connected. Run: claude switch add');
  }
  if (routing.launchIsolatedBanner) {
    process.stderr.write(`${routing.launchIsolatedBanner}\n\n`);
  }
  // `runClaude` (proxyRun) never returns in production; the caller adds an
  // explicit `return` so a non-blocking test fake can't fall through.
  await launchInSeededWorkDir(launch.configDir, launch.email, accountsDirPath, claudeBin, args, runClaude);
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
  await launchInSeededWorkDir(
    pointed.configDir, info.emailAddress ?? pointed.name, accountsDirPath, claudeBin, args, runClaude,
  );
}
