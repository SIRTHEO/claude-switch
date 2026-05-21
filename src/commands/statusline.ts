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

import fs from 'node:fs';
import os from 'node:os';
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
import { loadActiveSessionHealth } from '../cache-health.js';
import type { CommandContext } from './context.js';
import type { StatuslineSnapshot } from '../contract.js';

// --------------------------------------------------------------------------
// Render — read-only, hot-path
// --------------------------------------------------------------------------

export interface StatuslineOptions {
  format: 'compact' | 'full' | 'json' | 'embedded';
  color: boolean;
  noCacheHealth?: boolean;
}

/**
 * Read the JSON Claude Code pipes into the statusline command on stdin.
 * Returns null when there is nothing to read (interactive terminal or no
 * piped input), or when the payload is too large / malformed. Hot path:
 * skip work instead of blocking the redraw.
 */
function readClaudeStatusStdin(): null | {
  modelName: string | null;
  cwd: string | null;
  version: string | null;
  exceeds200k: boolean;
} {
  if (process.stdin.isTTY) return null;
  let raw: string;
  try {
    // fd 0; CC closes stdin after writing the JSON so this returns quickly.
    raw = fs.readFileSync(0, 'utf-8');
  } catch {
    return null;
  }
  if (!raw || raw.length > 64 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const model = p.model as Record<string, unknown> | undefined;
  const workspace = p.workspace as Record<string, unknown> | undefined;
  const modelName =
    typeof model?.display_name === 'string'
      ? model.display_name
      : typeof model?.id === 'string'
        ? (model.id as string)
        : null;
  const cwd =
    (typeof workspace?.current_dir === 'string' ? (workspace.current_dir as string) : null) ??
    (typeof p.cwd === 'string' ? p.cwd : null);
  const version = typeof p.version === 'string' ? p.version : null;
  const exceeds200k = p.exceeds_200k_tokens === true;
  return { modelName, cwd, version, exceeds200k };
}

/** Shorten a path for the statusline: replace $HOME with ~, then keep only the
 *  last 2 segments so long monorepo paths don't blow out the bar. */
function shortenCwd(p: string): string {
  const home = os.homedir();
  let s = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const parts = s.split(path.sep).filter(Boolean);
  if (parts.length > 2) {
    s = `…/${parts.slice(-2).join('/')}`;
  }
  return s;
}

export function handleStatusline(ctx: CommandContext, options: StatuslineOptions): void {
  renderStatusline(options.format, options.color, ctx.claudeJsonPath, ctx.accountsDirPath, options.noCacheHealth ?? false);
}

/**
 * Resolve the `.claude.json` path that reflects the actual identity of
 * THIS shell. When `CLAUDE_CONFIG_DIR` is set to a profile dir, the
 * spawned claude session uses the profile's local `.claude.json` for
 * everything — but the statusline was reading from the global one,
 * silently showing the main account's email/usage while the session
 * actually ran as a different account. Fix: route the lookup through
 * CCD when it points into the profiles tree.
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
  format: 'compact' | 'full' | 'json' | 'embedded',
  useColor: boolean,
  claudeJsonPathStr: string,
  accountsDirPath: string,
  noCacheHealth: boolean,
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

  // Cache-health badge. loadActiveSessionHealth reads the newest
  // JSONL under ~/.claude/projects/<encoded-cwd>/ (1s in-process TTL cache).
  // Suppressed when --no-cache-health is passed or no active session is found.
  const cacheHealthSummary = noCacheHealth ? null : loadActiveSessionHealth();

  // Effective runtime mode. When the proxy is alive it writes its current
  // state to `.proxy-mode.json` on every transition; we read it and reflect
  // the *actual* per-request routing instead of the boot-time flag. When the
  // marker is missing or stale (proxy not running / crashed), fall back to the
  // persistent flag.
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

  // Cache-health badge: shown when a session JSONL is found and has data.
  // Hide when: summary null (no session), turns === 0 (empty file), or --no-cache-health.
  const cacheHealthBadge = (() => {
    if (cacheHealthSummary === null || cacheHealthSummary.turns === 0) return '';
    const { hitRatio, flushCount } = cacheHealthSummary;
    const pctStr = `${(hitRatio * 100).toFixed(0)}%`;
    // Color: flushCount ≥ 1 always red; otherwise hitRatio-based.
    const coloredPct = (() => {
      if (flushCount >= 1) return red(`💾 ${pctStr}`);
      if (hitRatio >= 0.95) return green(`💾 ${pctStr}`);
      if (hitRatio >= 0.80) return yellow(`💾 ${pctStr}`);
      return red(`💾 ${pctStr}`);
    })();
    const flushBadge = flushCount >= 1 ? ` ${red(`🚨${flushCount}`)}` : '';
    return ` ${coloredPct}${flushBadge}`;
  })();

  if (format === 'json') {
    const cacheHealthField = (!noCacheHealth && cacheHealthSummary !== null && cacheHealthSummary.turns > 0)
      ? {
          cacheHealth: {
            hitRatio: cacheHealthSummary.hitRatio,
            flushCount: cacheHealthSummary.flushCount,
            effectiveInputTokens: cacheHealthSummary.effectiveInputTokens,
            turns: cacheHealthSummary.turns,
          },
        }
      : {};
    const json: StatuslineSnapshot = {
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
      ...cacheHealthField,
    };
    process.stdout.write(`${JSON.stringify(json)}\n`);
    return;
  }

  if (format === 'embedded') {
    // Drop-in replacement for the old `claude switch sl | ccstatusline` chain.
    // Reads CC's per-redraw JSON from stdin and renders: badge + model + cwd
    // + version, plus the usage / profile / cache-health badges already in
    // the compact line. Nothing here blocks: stdin read returns immediately
    // because CC closes the pipe after writing the JSON.
    const extra = readClaudeStatusStdin();
    const modelChunk = extra?.modelName ? ` · ${cyan(extra.modelName)}` : '';
    const cwdChunk = extra?.cwd ? ` · ${dim(shortenCwd(extra.cwd))}` : '';
    const ctxChunk = extra?.exceeds200k ? ` ${yellow('>200k')}` : '';
    const versionChunk = extra?.version ? ` ${dim(`v${extra.version}`)}` : '';
    process.stdout.write(
      `🔑 ${cyan(shortName)} ${modeLabel}${usageBadge}${profileBadge}${cacheHealthBadge}${modelChunk}${cwdChunk}${ctxChunk}${versionChunk}\n`,
    );
    return;
  }

  if (format === 'full') {
    process.stdout.write(`🔑 ${cyan(email)} · ${modeLabel}${usageBadge}${profileBadge}${cacheHealthBadge}\n`);
  } else {
    // compact (default)
    process.stdout.write(`🔑 ${cyan(shortName)} ${modeLabel}${usageBadge}${profileBadge}${cacheHealthBadge}\n`);
  }
}

// --------------------------------------------------------------------------
// Install / uninstall / status — patch Claude Code's settings.json
// --------------------------------------------------------------------------

export async function handleStatuslineInstall(
  variant: 'plain' | 'embedded' | 'ccstatusline',
): Promise<void> {
  const {
    installStatusLine,
    PLAIN_COMMAND,
    EMBEDDED_COMMAND,
    CCSTATUSLINE_COMMAND,
    claudeSettingsPath,
  } = await import('../statusline-install.js');
  const command =
    variant === 'ccstatusline'
      ? CCSTATUSLINE_COMMAND
      : variant === 'embedded'
        ? EMBEDDED_COMMAND
        : PLAIN_COMMAND;
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
    case 'ours-embedded':
      console.log('Status line: claude-switch badge + embedded model/cwd');
      break;
    case 'ours-ccstatusline':
      console.log('Status line: claude-switch badge + ccstatusline (legacy chain)');
      break;
    case 'foreign':
      console.log('Status line: a different command is configured');
      console.log(`  command: ${status.command}`);
      break;
  }
}
