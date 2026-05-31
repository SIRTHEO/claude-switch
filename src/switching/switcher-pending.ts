// src/switcher-pending.ts
// MIGRATION-ONLY pending-restore drain. Up to v4 the temporary `--as` runner
// swapped the global ~/.claude and left a `pendingRestore` marker so the next
// `claude` could restore the previous account (crash anchor). The unified
// profile model retired that swap: `--as` now launches isolated and never
// touches the global, so NOTHING writes this marker anymore.
//
// We keep the READ side for one release: an interrupted pre-upgrade `--as`
// left ~/.claude holding the WRONG account, and under the unified model
// ~/.claude is the permanent frozen default — so we must restore the correct
// account on the first `claude` after upgrade, before the default is read.
// `handlePassthrough` calls this first (on-read migration, no migration script).
// Remove this module once the upgrade window has passed.

import { load } from '../accounts/accounts.js';
import { withLock } from '../platform/lock.js';
import { updateState } from './state-store.js';

export function checkPendingRestore(claudeJsonPath: string, accountsDirPath: string): string | null {
  // Atomically: read the pending email AND clear it in one locked pass.
  // If we read first and clear later, two concurrent claude-switch
  // processes could both consume the same restore. The lambda captures
  // the prior value into a closure variable before returning the cleared
  // state to the writer.
  let extracted: string | undefined;
  updateState(accountsDirPath, (state) => {
    extracted = state.pendingRestore;
    if (!extracted) return state;
    const { pendingRestore: _drop, ...rest } = state;
    return rest as typeof state;
  });
  if (!extracted) return null;

  // The restore step takes its own lock — the marker has been cleared
  // already so a failed restore won't loop on the next invocation.
  try {
    withLock(accountsDirPath, () => {
      load(extracted!, claudeJsonPath, accountsDirPath);
    });
    return extracted;
  } catch { // capture+load failed → no snapshot produced
    return null;
  }
}
