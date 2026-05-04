// src/fallback.ts
// Global toggle for "API key fallback" mode. When on, claude-switch injects
// the active account's saved Anthropic API key as ANTHROPIC_API_KEY when
// spawning the real claude binary, which makes Claude Code bill against API
// credits instead of the OAuth subscription quota.
//
// Toggle is global (one flag for all accounts) and persisted as the presence
// of a marker file in the accounts dir, alongside .pending-restore.

import fs from 'node:fs';
import path from 'node:path';

const MARKER = '.fallback-enabled';
// Sidecar marker that records "fallback is ON because auto-engage flipped
// it ON for me" — distinct from the user's manual toggle. Used by the
// statusline to surface the difference (so the user knows their session
// is paying for API credits because of the rate-limit guard, not because
// they asked for it).
const AUTO_MARKER = '.fallback-auto-engaged';

function markerPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, MARKER);
}

function autoMarkerPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, AUTO_MARKER);
}

export function isFallbackEnabled(accountsDirPath: string): boolean {
  return fs.existsSync(markerPath(accountsDirPath));
}

/**
 * True only when fallback is ON AND it was flipped on by `auto-engage`
 * (not by the user manually). Returns false when fallback is off OR
 * when fallback is on for any other reason.
 */
export function isFallbackAutoEngaged(accountsDirPath: string): boolean {
  return fs.existsSync(markerPath(accountsDirPath))
    && fs.existsSync(autoMarkerPath(accountsDirPath));
}

export interface SetFallbackOpts {
  /** When true, also writes the auto-engage sidecar marker. Used by
   *  `maybeAutoEngageFallback`. Manual toggles leave it false (default)
   *  so the statusline shows them as "manual API". */
  byAutoEngage?: boolean;
}

export function setFallbackEnabled(
  accountsDirPath: string,
  enabled: boolean,
  opts: SetFallbackOpts = {},
): void {
  const file = markerPath(accountsDirPath);
  const autoFile = autoMarkerPath(accountsDirPath);
  if (enabled) {
    fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '');
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o600);
    }
    if (opts.byAutoEngage) {
      fs.writeFileSync(autoFile, '');
      if (process.platform !== 'win32') {
        fs.chmodSync(autoFile, 0o600);
      }
    } else {
      // Manual ON clears the auto marker — the user's intent overrides
      // any prior auto-engage state.
      try { fs.unlinkSync(autoFile); } catch { /* not present */ }
    }
  } else {
    try { fs.unlinkSync(file); } catch { /* already off */ }
    try { fs.unlinkSync(autoFile); } catch { /* not present */ }
  }
}
