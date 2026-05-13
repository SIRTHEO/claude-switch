// src/commands/statusline.ts
// `claude switch statusline …` — render the one-line account/mode summary
// for shell prompts and Claude Code's `statusLine.command`, plus the
// install / uninstall / status sub-commands that wire the badge into
// Claude Code's settings.
//
// `renderStatusline` is hot-path: Claude Code calls it on every redraw,
// so it must return in <100ms. It only reads local state, never blocks
// on the network — a stale cache triggers a detached background refresh
// and the next redraw picks up the fresh value.

import path from 'node:path';
import { getCurrent } from '../accounts.js';
import { isFallbackEnabled, isFallbackAutoEngaged } from '../fallback.js';
import { getApiKey } from '../apikey.js';
import { getAliasesForEmail } from '../aliases.js';
import {
  readUsageCacheForAccount,
  readUsageCacheFor,
  isUsageCacheStale,
  triggerBackgroundUsageRefresh,
} from '../usage.js';
import { profilesDir } from '../profiles.js';
import { readProxyMode } from '../proxy-mode.js';
import type { CommandContext } from './context.js';

// --------------------------------------------------------------------------
// Render — read-only, hot-path
// --------------------------------------------------------------------------

export interface StatuslineOptions {
  format: 'compact' | 'full' | 'json';
  color: boolean;
}

export function handleStatusline(ctx: CommandContext, options: StatuslineOptions): void {
  renderStatusline(options.format, options.color, ctx.claudeJsonPath, ctx.accountsDirPath);
}

/**
 * Resolve the `.claude.json` path that reflects the actual identity of
 * THIS shell. When `CLAUDE_CONFIG_DIR` is set to a profile dir, the
 * spawned claude session uses the profile's local `.claude.json` for
 * everything — but the statusline was reading from the global one,
 * silently showing the main account's email/usage while the session
 * actually ran as a different account. Phase 13.1 fix: route the
 * lookup through CCD when it points into the profiles tree.
 *
 * Non-profile CCDs (custom config dirs the user set for their own
 * reasons) fall through to the global path. The profile-tree guard
 * keeps the override scoped to identities claude-switch owns —
 * matching the `activeProfile` badge derivation below.
 */
function effectiveClaudeJsonPath(globalPath: string): string {
  const ccd = process.env.CLAUDE_CONFIG_DIR;
  if (!ccd) return globalPath;
  const base = profilesDir() + path.sep;
  if (!ccd.startsWith(base)) return globalPath;
  return path.join(ccd, '.claude.json');
}

function renderStatusline(
  format: 'compact' | 'full' | 'json',
  useColor: boolean,
  claudeJsonPathStr: string,
  accountsDirPath: string,
): void {
  const c = (code: string, s: string): string => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
  const dim = (s: string): string => c('2', s);
  const yellow = (s: string): string => c('33', s);
  const green = (s: string): string => c('32', s);
  const red = (s: string): string => c('31', s);
  const cyan = (s: string): string => c('36', s);

  const identityPath = effectiveClaudeJsonPath(claudeJsonPathStr);
  let email: string;
  try {
    email = getCurrent(identityPath);
  } catch {
    email = '';
  }
  if (!email) {
    process.stdout.write(format === 'json' ? '{"email":null,"mode":null}' : dim('claude: no account'));
    process.stdout.write('\n');
    return;
  }

  const fallbackOn = isFallbackEnabled(accountsDirPath);
  const apiKey = getApiKey(email, accountsDirPath);
  const usingApiKey = fallbackOn && !!apiKey;
  // Only show usage from the active account's quota — caches from a
  // previous account would otherwise leak across switches.
  const usageForActive = readUsageCacheFor(accountsDirPath, email);
  const fivePct = usageForActive?.payload?.five_hour?.utilization;
  const sevenPct = usageForActive?.payload?.seven_day?.utilization;

  // Quasi-live: if the cache is stale or for a different account, kick off
  // a detached background fetch. The current call returns immediately; the
  // next statusline redraw picks up the fresh value.
  if (isUsageCacheStale(readUsageCacheForAccount(accountsDirPath, email), email)) {
    triggerBackgroundUsageRefresh();
  }

  const aliases = getAliasesForEmail(email, accountsDirPath);
  const shortName = aliases[0] ?? email.split('@')[0] ?? email;

  // Profile badge: shown when this process was launched inside a profile
  // session (CLAUDE_CONFIG_DIR points into ~/.claude/profiles/<name>/).
  const activeProfile = (() => {
    const ccd = process.env.CLAUDE_CONFIG_DIR;
    if (!ccd) return null;
    const base = profilesDir() + path.sep;
    if (!ccd.startsWith(base)) return null;
    const rest = ccd.slice(base.length);
    const name = rest.split(path.sep)[0];
    return name || null;
  })();

  const autoEngaged = isFallbackAutoEngaged(accountsDirPath);

  // Phase 13.6 — effective runtime mode. When the proxy is alive it writes
  // its current state to `.proxy-mode.json` on every transition; we read it
  // and reflect the *actual* per-request routing instead of the boot-time
  // flag. When the marker is missing or stale (proxy not running / crashed),
  // fall back to the persistent flag — back-compat with the pre-13.6 label.
  const runtimeMarker = readProxyMode(accountsDirPath);
  type EffectiveMode = 'oauth' | 'oauth-burst' | 'api-auto' | 'api';
  const effectiveMode: EffectiveMode = (() => {
    if (runtimeMarker) {
      if (runtimeMarker.mode === 'oauth-first') return 'oauth';
      if (runtimeMarker.mode === 'oauth-burst') return 'oauth-burst';
      if (runtimeMarker.mode === 'api-first') return autoEngaged ? 'api-auto' : 'api';
    }
    if (usingApiKey) return autoEngaged ? 'api-auto' : 'api';
    return 'oauth';
  })();
  const modeLabel = (() => {
    switch (effectiveMode) {
      case 'oauth': return green('OAuth');
      // Burst: OAuth was the intent but we're temporarily routing through
      // API key. Distinct label so the user knows they're being billed to
      // API credits right now, not subscription. Dim yellow signals
      // "temporary unhealthy state" without being alarming.
      case 'oauth-burst': return yellow('OAuth↻API');
      case 'api-auto': return yellow('API auto');
      case 'api': return red('API');
    }
  })();
  const usageBadge = (() => {
    if (fivePct === undefined) return '';
    const pctStr = `${fivePct.toFixed(0)}%`;
    if (fivePct >= 90) return ` ${red(`5h:${pctStr}`)}`;
    if (fivePct >= 75) return ` ${yellow(`5h:${pctStr}`)}`;
    return ` ${dim(`5h:${pctStr}`)}`;
  })();
  const profileBadge = activeProfile ? ` ${cyan(`[${activeProfile}]`)}` : '';

  if (format === 'json') {
    const json = {
      email,
      shortName,
      // `mode` stays binary for back-compat with any consumer that
      // already parses it. `effectiveMode` is the new 4-state field
      // for clients that want the runtime distinction.
      mode: usingApiKey ? 'api' : 'oauth',
      effectiveMode,
      proxyRuntimeMode: runtimeMarker?.mode ?? null,
      fallback: fallbackOn,
      fallbackAutoEngaged: autoEngaged,
      hasApiKey: !!apiKey,
      fiveHour: fivePct ?? null,
      sevenDay: sevenPct ?? null,
      profile: activeProfile,
    };
    process.stdout.write(`${JSON.stringify(json)}\n`);
    return;
  }

  if (format === 'full') {
    process.stdout.write(`🔑 ${cyan(email)} · ${modeLabel}${usageBadge}${profileBadge}\n`);
  } else {
    // compact (default)
    process.stdout.write(`🔑 ${cyan(shortName)} ${modeLabel}${usageBadge}${profileBadge}\n`);
  }
}

// --------------------------------------------------------------------------
// Install / uninstall / status — patch Claude Code's settings.json
// --------------------------------------------------------------------------

export async function handleStatuslineInstall(variant: 'plain' | 'ccstatusline'): Promise<void> {
  const { installStatusLine, PLAIN_COMMAND, CCSTATUSLINE_COMMAND, claudeSettingsPath } =
    await import('../statusline-install.js');
  const command = variant === 'ccstatusline' ? CCSTATUSLINE_COMMAND : PLAIN_COMMAND;
  installStatusLine(command);
  console.log(`Installed status line in ${claudeSettingsPath()}`);
  console.log(`  command: ${command}`);
  console.log('\nReopen Claude Code to see the badge in its status bar.');
}

export async function handleStatuslineUninstall(): Promise<void> {
  const { uninstallStatusLine, claudeSettingsPath } = await import('../statusline-install.js');
  const removed = uninstallStatusLine();
  console.log(removed
    ? `Removed claude-switch status line from ${claudeSettingsPath()}`
    : 'No claude-switch status line was installed (or settings.json has a foreign one — left untouched).');
}

export async function handleStatuslineStatus(): Promise<void> {
  const { detectExistingStatusLine, claudeSettingsPath } = await import('../statusline-install.js');
  const status = detectExistingStatusLine();
  console.log(`Settings file: ${claudeSettingsPath()}`);
  switch (status.kind) {
    case 'absent':
      console.log('Status line: not configured');
      console.log('Run: claude switch statusline install');
      break;
    case 'ours-plain':
      console.log('Status line: claude-switch badge (plain)');
      break;
    case 'ours-ccstatusline':
      console.log('Status line: claude-switch badge + ccstatusline');
      break;
    case 'foreign':
      console.log('Status line: a different command is configured');
      console.log(`  command: ${status.command}`);
      break;
  }
}
