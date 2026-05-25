// src/switcher-pending.ts
// Pending-restore marker: persists "restore this account when the temporary
// switch ends", consumed atomically so two concurrent processes can't both
// claim the same restore.

import fs from 'node:fs';
import { load } from './accounts.js';
import { withLock } from './lock.js';
import { updateState, updateStateInLock } from './state-store.js';

/** Save a pending-restore marker. Acquires the lock itself.
 *  Use from contexts with no surrounding `withLock`. */
export function savePendingRestore(email: string, accountsDirPath: string): void {
  fs.mkdirSync(accountsDirPath, { recursive: true });
  updateState(accountsDirPath, (state) => ({ ...state, pendingRestore: email }));
}

/** Save a pending-restore marker INSIDE an existing `withLock`. */
export function savePendingRestoreInLock(email: string, accountsDirPath: string): void {
  fs.mkdirSync(accountsDirPath, { recursive: true });
  updateStateInLock(accountsDirPath, (state) => ({ ...state, pendingRestore: email }));
}

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

export function clearPendingRestore(accountsDirPath: string): void {
  // No-op when the state file doesn't exist yet — readState returns
  // EMPTY_STATE, the patch removes a field that wasn't there.
  if (!fs.existsSync(accountsDirPath)) return;
  updateState(accountsDirPath, (state) => {
    const { pendingRestore: _drop, ...rest } = state;
    return rest as typeof state;
  });
}
