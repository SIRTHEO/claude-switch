// src/switching/repoint.ts
// Re-point core for the unified-profile model (slice 4b): `claude switch
// <email>` (and the interactive picker / dashboard) SET the default-pointer
// instead of overwriting ~/.claude. This is the heart of the breaking flip —
// landed inert here (no entry point wired yet); the switch verb's three entry
// points (CLI handleSwitchTo, non-TTY switchInteractive, the Ink dashboard)
// wire to it together as one coherent unit so the verb never means two things.
//
// Behaviour vs the retired swap (switchToAndSyncFallback):
//   - The account frozen in ~/.claude IS the `default` workspace → point at the
//     'default' sentinel; NEVER ensureProfileForAccount it (that would mint a
//     second home + .credentials.json for the one account — the §1 invariant).
//   - Any other account → ensure an isolated profile for it and point there.
//     The global ~/.claude is NOT overwritten — that is the whole point of the
//     re-point (concurrent terminals keep their pinned dirs; no mixing).
//   - Fallback-on-switch is dropped (owner decision A1): switch is a pure
//     re-point now; per-profile fallback is later work.
//   - No single withLock wraps the whole op (the swap held one to serialise the
//     shared ~/.claude write). There is no shared write anymore: setDefaultPointer
//     is atomic and ensureProfileForAccount is idempotent, so the swap-era race
//     guard is intentionally gone.

import { getCurrent } from '../accounts/accounts.js';

interface RepointOutcome {
  /** Human-readable status line for the caller to print. */
  message: string;
  /** True when the target has no usable login yet — the caller must refuse to
   *  launch and tell the user to log the profile in, not run a broken session. */
  needsLogin: boolean;
  /** The pointer value written ('default' or a profile name), or null when
   *  needsLogin (nothing was pointed). */
  pointer: string | null;
}

/**
 * Re-point the default-pointer at `targetEmail`. `targetEmail` must already be
 * a resolved account email (the caller resolves any alias first).
 */
export async function repointToDefault(
  targetEmail: string,
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<RepointOutcome> {
  const { setDefaultPointer } = await import('../profiles/workspaces.js');

  // §1 short-circuit: the account frozen in ~/.claude is the `default`
  // workspace itself — point at the sentinel, never mint a profile for it.
  const current = getCurrent(claudeJsonPath);
  if (targetEmail === current) {
    setDefaultPointer(accountsDirPath, 'default');
    return {
      message: `Default workspace is ${targetEmail} (global ~/.claude).`,
      needsLogin: false,
      pointer: 'default',
    };
  }

  const { ensureProfileForAccount } = await import('../profiles/profiles.js');
  const ensured = await ensureProfileForAccount(targetEmail, accountsDirPath);
  if (ensured.needsLogin) {
    return {
      message:
        `Account ${targetEmail} has no usable login yet. ` +
        `Run: claude switch profile login ${ensured.profileName}`,
      needsLogin: true,
      pointer: null,
    };
  }

  setDefaultPointer(accountsDirPath, ensured.profileName);
  return {
    message:
      `Switched default to ${targetEmail} (profile: ${ensured.profileName}). ` +
      'Bare `claude` now launches it.',
    needsLogin: false,
    pointer: ensured.profileName,
  };
}
