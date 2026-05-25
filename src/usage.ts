// src/usage.ts
// Subscription usage tracking. The implementation is split across:
//   - usage-cache.ts    per-account cache layer (paths, guards, read/write, staleness)
//   - usage-fetch.ts    /api/oauth/usage network access + cache-aware wrapper
//   - usage-account.ts  per-account OAuth token read/refresh
//   - usage-headers.ts  realtime usage push from proxy response headers
// This module re-exports the public surface (so importers keep using
// `./usage.js`) and owns the detached background-refresh spawn.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ProcessPort, nodeProcessAdapter } from './process.js';

export type { UsageCache } from './usage-cache.js';
export {
  isUsageCacheStale,
  parseRetryAfter,
  readUsageCache,
  readUsageCacheFor,
  readUsageCacheForAccount,
  shouldTriggerUsageRefreshAfterSwitch,
} from './usage-cache.js';
export { fetchUsage, fetchUsageCached } from './usage-fetch.js';
export { getAccessTokenFromKeychain, refreshUsageForAccount } from './usage-account.js';
export { parseUsageHeadersIfPresent, updateUsageCacheFromHeaders } from './usage-headers.js';

/**
 * Spawn a fully-detached background process that refreshes the usage cache,
 * then exits. Used by the statusline so the foreground call can return
 * immediately — Claude Code renders the line as soon as we return, and the
 * next redraw picks up the freshly-written cache.
 */
export function triggerBackgroundUsageRefresh(deps: { process?: ProcessPort } = {}): void {
  let selfPath: string;
  try {
    selfPath = fileURLToPath(import.meta.url);
  } catch { // import.meta unavailable in some contexts → skip background refresh
    return;
  }
  // selfPath is .../dist/src/usage.js; the CLI entry sits at .../dist/bin/cli.js
  const cliPath = path.resolve(path.dirname(selfPath), '..', 'bin', 'cli.js');
  const proc = deps.process ?? nodeProcessAdapter;
  try {
    // Detached background process MUST NOT raise a Keychain password
    // dialog. There is no user attached to consent. A stalled prompt
    // here holds an accountsDir lock indefinitely and cascades into the
    // spawning-zombie regression observed 2026-05-22 (every subsequent
    // swap spawns another refresh process that piles up on the same
    // blocked Keychain read). The no-prompt env var makes readOAuth
    // return null instead of blocking the process.
    const child = proc.spawn(process.execPath, [cliPath, 'switch', 'usage', '--refresh-only'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_SWITCH_NO_KEYCHAIN_PROMPT: '1' },
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}
