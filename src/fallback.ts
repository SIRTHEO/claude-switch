// src/fallback.ts
// Global toggle for "API key fallback" mode. When on, claude-switch injects
// the active account's saved Anthropic API key as ANTHROPIC_API_KEY when
// spawning the real claude binary, which makes Claude Code bill against API
// credits instead of the OAuth subscription quota.
//
// Storage: this used to live in two marker files (.fallback-enabled and a
// .fallback-auto-engaged sidecar). Since v3.4 both live in a single
// state.json (see state-store.ts) so the flip + auto-engage flag can no
// longer drift on a crash.

import { readState, updateState, updateStateInLock, type State } from './state-store.js';

export function isFallbackEnabled(accountsDirPath: string): boolean {
  return readState(accountsDirPath).fallback.enabled;
}

/**
 * True only when fallback is ON AND it was flipped on by `auto-engage`
 * (not by the user manually). Returns false when fallback is off OR
 * when fallback is on for any other reason.
 */
export function isFallbackAutoEngaged(accountsDirPath: string): boolean {
  const { fallback } = readState(accountsDirPath);
  return fallback.enabled && fallback.autoEngaged;
}

interface SetFallbackOpts {
  /** When true, also marks the flag as engaged-by-auto. Used by
   *  `maybeAutoEngageFallback`. Manual toggles leave it false (default)
   *  so the statusline shows them as "manual API". */
  byAutoEngage?: boolean;
}

function nextState(
  state: State,
  enabled: boolean,
  byAutoEngage: boolean,
): State {
  return {
    ...state,
    fallback: enabled
      // Manual ON clears the auto flag — user intent overrides any
      // prior auto-engage state.
      ? { enabled: true, autoEngaged: byAutoEngage }
      : { enabled: false, autoEngaged: false },
  };
}

/** Toggle fallback; takes the lock itself. Call from CLI handlers /
 *  settings UI / anywhere outside an existing `withLock`. */
export function setFallbackEnabled(
  accountsDirPath: string,
  enabled: boolean,
  opts: SetFallbackOpts = {},
): void {
  updateState(accountsDirPath, (state) => nextState(state, enabled, !!opts.byAutoEngage));
}

/** Toggle fallback INSIDE an existing `withLock`. Used by callers that
 *  must keep the flip atomic with surrounding state mutations
 *  (passthrough's auto-revert / auto-engage, switcher's switch+flip). */
export function setFallbackEnabledInLock(
  accountsDirPath: string,
  enabled: boolean,
  opts: SetFallbackOpts = {},
): void {
  updateStateInLock(accountsDirPath, (state) => nextState(state, enabled, !!opts.byAutoEngage));
}
