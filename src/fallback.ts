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

function markerPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, MARKER);
}

export function isFallbackEnabled(accountsDirPath: string): boolean {
  return fs.existsSync(markerPath(accountsDirPath));
}

export function setFallbackEnabled(accountsDirPath: string, enabled: boolean): void {
  const file = markerPath(accountsDirPath);
  if (enabled) {
    fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '');
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o600);
    }
  } else {
    try { fs.unlinkSync(file); } catch { /* already off */ }
  }
}
