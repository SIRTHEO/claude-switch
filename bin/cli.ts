#!/usr/bin/env node
// claude-switch — Claude Code multi-account wrapper

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from '../src/resolver.js';
import { getCurrent, save, list as listAccounts, } from '../src/accounts.js';
import { withLock } from '../src/lock.js';
import { fuzzyMatch, switchToAndSyncFallback, switchInteractive, checkPendingRestore } from '../src/switcher.js';
import { run as proxyRun } from '../src/proxy.js';
import { claudeJsonPath, accountsDir } from '../src/paths.js';
import { VERSION } from '../src/version.js';
import { ExitError } from '../src/errors.js';
import { resolveAlias, getAliasesForEmail } from '../src/aliases.js';
import { getTokenHealth } from '../src/token.js';
import { getSavedClaudeBin, } from '../src/setup.js';
import { checkForUpdate, performUpdate, } from '../src/update-check.js';
import { getApiKey, } from '../src/apikey.js';
import { isFallbackEnabled, isFallbackAutoEngaged, } from '../src/fallback.js';
import { fallbackEnvFor } from '../src/fallback-env.js';
import { maybeAutoDisableFallback, maybeAutoEngageFallback, maybeInitSmartFallback } from '../src/auto-fallback.js';
import { readUsageCache, readUsageCacheFor, isUsageCacheStale, triggerBackgroundUsageRefresh } from '../src/usage.js';
import { runApp } from '../src/ui/run-app.js';
import { profilesDir } from '../src/profiles.js';
import { startFallbackProxy } from '../src/api-proxy.js';
import { handleHelp } from '../src/commands/help.js';
import { handleVersion } from '../src/commands/version.js';
import { handleCompletions } from '../src/commands/completions.js';
import { handleList } from '../src/commands/list.js';
import { handleStatus } from '../src/commands/status.js';
import { handleAliasSet, handleAliasList, handleAliasRemove } from '../src/commands/alias.js';
import { handleApikeySet, handleApikeyShow, handleApikeyRemove } from '../src/commands/apikey.js';
import { handleFallback, handleFallbackAuto, handleFallbackAutoEngage } from '../src/commands/fallback.js';
import { handleUsage } from '../src/commands/usage.js';
import { handleAdd, handleRemove } from '../src/commands/account.js';
import { handleSetup } from '../src/commands/setup.js';
import { handleUpdate } from '../src/commands/update.js';
import { handleTemporarySwitch } from '../src/commands/temporary-switch.js';
import type { CommandContext } from '../src/commands/context.js';

export type Command =
  | { action: 'switch-interactive' }
  | { action: 'switch-to'; target: string }
  | { action: 'add' }
  | { action: 'list' }
  | { action: 'remove'; email: string | undefined }
  | { action: 'status' }
  | { action: 'help' }
  | { action: 'version' }
  | { action: 'completions'; shell: string | undefined }
  | { action: 'passthrough'; args: string[] }
  | { action: 'alias-set'; name: string; email: string }
  | { action: 'alias-list' }
  | { action: 'alias-remove'; name: string | undefined }
  | { action: 'temporary-switch'; target: string | undefined; args: string[] }
  | { action: 'setup' }
  | { action: 'update' }
  | { action: 'apikey-set'; target: string | undefined }
  | { action: 'apikey-remove'; target: string | undefined }
  | { action: 'apikey-show'; target: string | undefined }
  | { action: 'fallback'; mode: 'on' | 'off' | 'status' }
  | { action: 'fallback-auto'; mode: 'on' | 'off' | 'status'; threshold?: number }
  | { action: 'fallback-auto-engage'; mode: 'on' | 'off' | 'status'; threshold?: number }
  | { action: 'usage'; force: boolean; refreshOnly: boolean }
  | { action: 'statusline'; format: 'compact' | 'full' | 'json'; color: boolean }
  | { action: 'statusline-install'; variant: 'plain' | 'ccstatusline' }
  | { action: 'statusline-uninstall' }
  | { action: 'statusline-status' }
  | { action: 'profile-list' }
  | { action: 'profile-create'; name: string }
  | { action: 'profile-use'; name: string; args: string[] }
  | { action: 'profile-login'; name: string }
  | { action: 'profile-remove'; name: string }
  | { action: 'profile-status'; name: string | undefined }
  | { action: 'profile-import'; email: string; profileName?: string }
  | { action: 'dashboard' };

export function parseCommand(args: string[]): Command {
  if (args[0] === '--as') {
    return { action: 'temporary-switch', target: args[1], args: args.slice(2) };
  }

  if (args[0] !== 'switch') {
    return { action: 'passthrough', args };
  }

  const sub = args[1];
  if (!sub) return { action: 'switch-interactive' };

  switch (sub) {
    case 'add': return { action: 'add' };
    case 'list':
    case 'ls': return { action: 'list' };
    case 'dashboard':
    case 'dash': return { action: 'dashboard' };
    case 'remove':
    case 'rm': return { action: 'remove', email: args[2] };
    case 'status': return { action: 'status' };
    case 'help':
    case '--help':
    case '-h': return { action: 'help' };
    case '--version':
    case '-v': return { action: 'version' };
    case '--completions': return { action: 'completions', shell: args[2] };
    case 'setup': return { action: 'setup' };
    case 'update': return { action: 'update' };
    case 'apikey': {
      const sub2 = args[2];
      if (sub2 === 'set') return { action: 'apikey-set', target: args[3] };
      if (sub2 === 'remove' || sub2 === 'rm') return { action: 'apikey-remove', target: args[3] };
      if (sub2 === 'show') return { action: 'apikey-show', target: args[3] };
      throw new ExitError('Usage: claude switch apikey <set|remove|show> <alias|email>');
    }
    case 'fallback': {
      const sub2 = args[2];
      if (!sub2 || sub2 === 'status') return { action: 'fallback', mode: 'status' };
      if (sub2 === 'on') return { action: 'fallback', mode: 'on' };
      if (sub2 === 'off') return { action: 'fallback', mode: 'off' };
      // Sub-tree map. `auto-revert` is the new canonical name; `auto` is
      // a deprecated alias kept for one minor cycle (since v3.2.0). Both
      // route to the same action.
      const SUBTREE_ACTIONS: Record<string, 'fallback-auto' | 'fallback-auto-engage'> = {
        auto: 'fallback-auto',
        'auto-revert': 'fallback-auto',
        'auto-engage': 'fallback-auto-engage',
      };
      if (sub2 && sub2 in SUBTREE_ACTIONS) {
        if (sub2 === 'auto') {
          process.stderr.write(
            'Note: `claude switch fallback auto …` is deprecated; use `auto-revert` instead.\n',
          );
        }
        const action = SUBTREE_ACTIONS[sub2]!;
        const sub3 = args[3];
        if (!sub3 || sub3 === 'status') return { action, mode: 'status' };
        if (sub3 === 'off') return { action, mode: 'off' };
        if (sub3 === 'on') {
          const tIdx = args.indexOf('--threshold');
          if (tIdx >= 4 && args[tIdx + 1] !== undefined) {
            const t = parseInt(args[tIdx + 1]!, 10);
            if (!Number.isFinite(t) || t < 1 || t > 100) {
              throw new ExitError('--threshold must be an integer between 1 and 100');
            }
            return { action, mode: 'on', threshold: t };
          }
          return { action, mode: 'on' };
        }
        throw new ExitError(`Usage: claude switch fallback ${sub2} <on|off|status> [--threshold <1-100>]`);
      }
      throw new ExitError('Usage: claude switch fallback <on|off|status|auto-revert|auto-engage>');
    }
    case 'usage': {
      const flags = args.slice(2);
      const force = flags.includes('--force');
      const refreshOnly = flags.includes('--refresh-only');
      return { action: 'usage', force, refreshOnly };
    }
    case 'statusline':
    case 'sl': {
      const sub2 = args[2];
      if (sub2 === 'install') {
        const variant = args.includes('--ccstatusline') ? 'ccstatusline' : 'plain';
        return { action: 'statusline-install', variant };
      }
      if (sub2 === 'uninstall' || sub2 === 'remove') {
        return { action: 'statusline-uninstall' };
      }
      if (sub2 === 'status') {
        return { action: 'statusline-status' };
      }
      const rest = args.slice(2);
      const fmt = rest.includes('--full') ? 'full' : rest.includes('--json') ? 'json' : 'compact';
      // Honour both the CLI flag and the de-facto NO_COLOR env standard
      // (https://no-color.org). Either turning colour off is enough.
      const color = !rest.includes('--no-color') && !process.env.NO_COLOR;
      return { action: 'statusline', format: fmt as 'compact' | 'full' | 'json', color };
    }
    case 'alias': {
      const sub2 = args[2];
      if (!sub2 || sub2 === '--list') return { action: 'alias-list' };
      if (sub2 === '--remove') {
        if (!args[3]) throw new ExitError('Usage: claude switch alias --remove <name>');
        return { action: 'alias-remove', name: args[3] };
      }
      if (!args[3]) throw new ExitError('Usage: claude switch alias <name> <email>');
      return { action: 'alias-set', name: sub2, email: args[3] };
    }
    case 'profile': {
      const sub2 = args[2];
      if (!sub2 || sub2 === 'list' || sub2 === 'ls') return { action: 'profile-list' };
      if (sub2 === 'create') {
        if (!args[3]) throw new ExitError('Usage: claude switch profile create <name>');
        return { action: 'profile-create', name: args[3] };
      }
      if (sub2 === 'use') {
        if (!args[3]) throw new ExitError('Usage: claude switch profile use <name> [extra claude args]');
        return { action: 'profile-use', name: args[3], args: args.slice(4) };
      }
      if (sub2 === 'login') {
        if (!args[3]) throw new ExitError('Usage: claude switch profile login <name>');
        return { action: 'profile-login', name: args[3] };
      }
      if (sub2 === 'remove' || sub2 === 'rm') {
        if (!args[3]) throw new ExitError('Usage: claude switch profile remove <name>');
        return { action: 'profile-remove', name: args[3] };
      }
      if (sub2 === 'status') return { action: 'profile-status', name: args[3] };
      if (sub2 === 'import' || sub2 === 'import-from-account') {
        if (!args[3]) throw new ExitError('Usage: claude switch profile import <email> [--as <profile-name>]');
        const asIdx = args.indexOf('--as');
        const profileName = asIdx >= 4 && args[asIdx + 1] ? args[asIdx + 1] : undefined;
        return { action: 'profile-import', email: args[3], profileName };
      }
      throw new ExitError('Usage: claude switch profile <list|create|use|login|import|remove|status> [name]');
    }
    default: return { action: 'switch-to', target: sub };
  }
}

function findClaude(): string {
  const saved = getSavedClaudeBin();
  if (saved) return saved;

  const selfPath = fileURLToPath(import.meta.url);
  const bin = resolve({
    envBin: process.env.CLAUDE_SWITCH_BIN || '',
    selfPath,
    pathEnv: process.env.PATH || '',
  });
  if (!bin) {
    console.error('Error: could not find the real claude binary. Run: claude switch setup');
    process.exit(1);
  }
  return bin;
}

/** Read a line from stdin without echoing it (TTY) or from a pipe (non-TTY). */
async function _promptSecret(question: string): Promise<string> {
  const readline = await import('node:readline');

  if (!process.stdin.isTTY) {
    // Non-interactive: read first line from pipe.
    const rl = readline.createInterface({ input: process.stdin });
    return new Promise(resolve => {
      rl.once('line', line => { rl.close(); resolve(line.trim()); });
    });
  }

  process.stderr.write(question);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Mute the readline output so the key isn't echoed to the terminal.
  // _writeToOutput is a documented hook of the readline Interface.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string): void => {
    if (s.includes('\n') || s.includes('\r')) process.stderr.write('\n');
  };
  return new Promise(resolve => {
    rl.question('', (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Resolve a target alias/fuzzy string to a single saved email, or throw.
 * Used by apikey commands so they accept the same target syntax as switch.
 */
function _resolveTargetEmail(target: string, accountsDirPath: string): string {
  const resolved = resolveAlias(target, accountsDirPath);
  const accounts = listAccounts(accountsDirPath);
  const matches = accounts.filter(a => a === resolved);
  if (matches.length === 1) return matches[0]!;
  // Fuzzy fallback for partial matches (mirrors switch behaviour).
  const fuzzy = accounts.filter(a => a.toLowerCase().includes(resolved.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) {
    throw new ExitError(`Multiple matches for "${target}":\n${fuzzy.map(m => `  ${m}`).join('\n')}\nBe more specific.`);
  }
  throw new ExitError(`No account matching "${target}". Run: claude switch list`);
}

// fallbackEnvFor moved to src/fallback-env.ts so the multi-account
// hot-path decision is testable in isolation. Behaviour unchanged.

/** Prompt for y/n on stderr and return true if the user typed y or Y. */
async function askYN(question: string): Promise<boolean> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Print one line summarizing the active account + auth mode, intended for use
 * in shell prompts or Claude Code's statusLine.command.
 *
 * Reads only local state (no network). Skips the update-check / pending-
 * restore preludes so latency stays in the tens of milliseconds.
 */
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

  let email: string;
  try {
    email = getCurrent(claudeJsonPathStr);
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
  // next statusline redraw will pick up the fresh value. Skipped while a
  // recorded 429 backoff is still in effect.
  if (isUsageCacheStale(readUsageCache(accountsDirPath), email)) {
    triggerBackgroundUsageRefresh();
  }

  // Short-form display name: prefer the first alias if any, else the local part.
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
  const modeLabel = usingApiKey
    ? yellow(autoEngaged ? 'API auto' : 'API')
    : green('OAuth');
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
      mode: usingApiKey ? 'api' : 'oauth',
      fallback: fallbackOn,
      fallbackAutoEngaged: isFallbackAutoEngaged(accountsDirPath),
      hasApiKey: !!apiKey,
      fiveHour: fivePct ?? null,
      sevenDay: sevenPct ?? null,
      profile: activeProfile,
    };
    process.stdout.write(JSON.stringify(json) + '\n');
    return;
  }

  if (format === 'full') {
    process.stdout.write(`🔑 ${cyan(email)} · ${modeLabel}${usageBadge}${profileBadge}\n`);
  } else {
    // compact (default) — short alias + mode badge + optional usage + profile
    process.stdout.write(`🔑 ${cyan(shortName)} ${modeLabel}${usageBadge}${profileBadge}\n`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = parseCommand(args);
  const cJson = claudeJsonPath();
  const aDir = accountsDir();

  // Statusline is called on every Claude Code redraw — return as fast as
  // possible. Skip every check that touches the filesystem beyond what we
  // strictly need.
  if (cmd.action === 'statusline') {
    renderStatusline(cmd.format, cmd.color, cJson, aDir);
    return;
  }
  if (cmd.action === 'statusline-install') {
    const { installStatusLine, PLAIN_COMMAND, CCSTATUSLINE_COMMAND, claudeSettingsPath } = await import('../src/statusline-install.js');
    const command = cmd.variant === 'ccstatusline' ? CCSTATUSLINE_COMMAND : PLAIN_COMMAND;
    installStatusLine(command);
    console.log(`Installed status line in ${claudeSettingsPath()}`);
    console.log(`  command: ${command}`);
    console.log('\nReopen Claude Code to see the badge in its status bar.');
    return;
  }
  if (cmd.action === 'statusline-uninstall') {
    const { uninstallStatusLine, claudeSettingsPath } = await import('../src/statusline-install.js');
    const removed = uninstallStatusLine();
    console.log(removed
      ? `Removed claude-switch status line from ${claudeSettingsPath()}`
      : 'No claude-switch status line was installed (or settings.json has a foreign one — left untouched).');
    return;
  }
  if (cmd.action === 'statusline-status') {
    const { detectExistingStatusLine, claudeSettingsPath } = await import('../src/statusline-install.js');
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
    return;
  }

  // Profile subcommands — isolated per-terminal claude sessions via
  // CLAUDE_CONFIG_DIR. See ~/.claude/profiles/<name>/ for the per-profile
  // state (each gets its own userID, Keychain entry, sessions, etc.).
  if (cmd.action === 'profile-list') {
    const { listProfiles, readProfile } = await import('../src/profiles.js');
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log('No profiles. Create one with: claude switch profile create <name>');
      return;
    }
    console.log('Profiles:\n');
    for (const name of profiles) {
      const info = readProfile(name);
      const right = info.hasLogin
        ? `→  ${info.emailAddress ?? '<unknown>'}`
        : '(not logged in — run: claude switch profile login ' + name + ')';
      console.log(`  ${name.padEnd(20)} ${right}`);
    }
    return;
  }
  if (cmd.action === 'profile-create') {
    const { createProfile } = await import('../src/profiles.js');
    let dir: string;
    try { dir = createProfile(cmd.name); }
    catch (e) { throw new ExitError((e as Error).message); }
    console.log(`Created profile "${cmd.name}" at ${dir}`);
    console.log('');
    console.log('Next steps:');
    console.log(`  1. claude switch profile login ${cmd.name}    # browser opens, sign in`);
    console.log(`  2. claude switch profile use ${cmd.name}      # start using the profile`);
    return;
  }
  if (cmd.action === 'profile-status') {
    const { readProfile, listProfiles } = await import('../src/profiles.js');
    if (cmd.name) {
      let info: ReturnType<typeof readProfile>;
      try { info = readProfile(cmd.name); }
      catch (e) { throw new ExitError((e as Error).message); }

      const profileClaudeJson = path.join(info.path, '.claude.json');
      const tokenHealth = info.hasLogin ? getTokenHealth(profileClaudeJson) : null;
      const tokenLine = (() => {
        if (!tokenHealth) return '(not logged in yet)';
        switch (tokenHealth.status) {
          case 'valid': return `valid (expires ${tokenHealth.expiresIn})`;
          case 'expired': return `EXPIRED (${tokenHealth.expiresIn}) — run: claude switch profile login ${info.name}`;
          case 'present': return 'present (expiry unknown)';
          case 'missing': return 'missing — run: claude switch profile login ' + info.name;
        }
      })();

      let keychainLine = '(not applicable on this platform)';
      if (process.platform === 'darwin' && info.userID) {
        const { spawnSync: ss } = await import('node:child_process');
        const r = ss('security', [
          'find-generic-password', '-a', info.userID, '-s', 'Claude Code-credentials',
        ], { stdio: 'pipe' });
        keychainLine = r.status === 0 ? `present (account=${info.userID.slice(0, 16)}…)` : 'absent';
      } else if (!info.userID) {
        keychainLine = '(no userID yet — run claude once in this profile)';
      }

      let lastUsed = '(never)';
      try {
        const mtime = fs.statSync(profileClaudeJson).mtime;
        lastUsed = mtime.toLocaleString();
      } catch { /* fresh profile */ }

      console.log(`Profile: ${info.name}`);
      console.log(`Path:    ${info.path}`);
      console.log(`Email:   ${info.emailAddress ?? '(not logged in yet)'}`);
      console.log(`Token:   ${tokenLine}`);
      console.log(`Keychain:${' '.repeat(1)}${keychainLine}`);
      console.log(`Last run:${' '.repeat(1)}${lastUsed}`);
      console.log(`User ID: ${info.userID ?? '(not yet assigned — run claude once in this profile)'}`);
      return;
    }
    // No name: show all
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log('No profiles configured.');
      return;
    }
    for (const n of profiles) {
      const info = readProfile(n);
      const status = info.hasLogin ? (info.emailAddress ?? '(email unknown)') : '(not logged in)';
      console.log(`${n}: ${status} [${info.userID?.slice(0, 12) ?? '-'}…]`);
    }
    return;
  }
  if (cmd.action === 'profile-login') {
    const { profilePath, profileExists, createProfile, readProfile } = await import('../src/profiles.js');
    let dir: string;
    try {
      if (!profileExists(cmd.name)) {
        createProfile(cmd.name);
        console.log(`Created profile "${cmd.name}".`);
      }
      dir = profilePath(cmd.name);
    } catch (e) { throw new ExitError((e as Error).message); }
    const claudeBin = findClaude();
    process.stderr.write(`🔐 Opening browser to authenticate profile "${cmd.name}"...\n\n`);
    const { buildSpawnArgs } = await import('../src/proxy.js');
    const { command, args, options } = buildSpawnArgs(claudeBin, ['auth', 'login'], process.platform, {
      CLAUDE_CONFIG_DIR: dir,
    });
    const { spawnSync } = await import('node:child_process');
    spawnSync(command, args, options);
    const info = readProfile(cmd.name);
    if (info.emailAddress) {
      console.log(`\n✔ Profile "${cmd.name}" logged in as ${info.emailAddress}`);
      console.log(`Use it with:  claude switch profile use ${cmd.name}`);
    } else {
      console.log(`\nLogin did not complete for profile "${cmd.name}". Try again with:`);
      console.log(`  claude switch profile login ${cmd.name}`);
    }
    return;
  }
  if (cmd.action === 'profile-use') {
    const { profilePath, profileExists, readProfile } = await import('../src/profiles.js');
    if (!profileExists(cmd.name)) {
      throw new ExitError(
        `Profile "${cmd.name}" does not exist. Create it with: claude switch profile create ${cmd.name}`,
      );
    }
    let info: ReturnType<typeof readProfile>;
    try { info = readProfile(cmd.name); }
    catch (e) { throw new ExitError((e as Error).message); }
    if (!info.hasLogin) {
      throw new ExitError(
        `Profile "${cmd.name}" has no login yet. Run: claude switch profile login ${cmd.name}`,
      );
    }
    const dir = profilePath(cmd.name);
    const claudeBin = findClaude();
    process.stderr.write(`🔑 ${cmd.name} (profile, isolated) — ${info.emailAddress}\n\n`);
    const { buildSpawnArgs } = await import('../src/proxy.js');
    const { command, args, options } = buildSpawnArgs(claudeBin, cmd.args, process.platform, {
      CLAUDE_CONFIG_DIR: dir,
    });
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(command, args, options);
    if (result.error) {
      console.error(`Error: could not run claude: ${result.error.message}`);
      process.exit(1);
    }
    process.exit(result.status ?? 0);
  }
  if (cmd.action === 'profile-import') {
    const { importProfileFromAccount } = await import('../src/profiles.js');
    let result: ReturnType<typeof importProfileFromAccount>;
    try {
      result = importProfileFromAccount(cmd.email, aDir, cmd.profileName);
    } catch (e) {
      throw new ExitError((e as Error).message);
    }
    console.log(`✔ Imported "${result.emailAddress}" into profile "${result.profileName}"`);
    console.log(`  Path:    ${result.profilePath}`);
    console.log(`  User ID: ${result.userID.slice(0, 16)}…`);
    if (result.wroteToKeychain) {
      console.log(`  Tokens:  written to macOS Keychain (account=${result.userID.slice(0, 16)}…)`);
    } else if (result.needsLogin) {
      console.log('');
      console.log('⚠ This account predates v2.2 (no _keychain snapshot saved).');
      console.log(`  Run:  claude switch profile login ${result.profileName}`);
      console.log('  to authenticate the profile.');
    } else {
      console.log(`  Tokens:  written to ${result.profilePath}/.claude.json`);
    }
    if (!result.needsLogin) {
      console.log('');
      console.log(`Use it now with:  claude switch profile use ${result.profileName}`);
    }
    return;
  }
  if (cmd.action === 'profile-remove') {
    const { removeProfile } = await import('../src/profiles.js');
    let result: ReturnType<typeof removeProfile>;
    try { result = removeProfile(cmd.name); }
    catch (e) { throw new ExitError((e as Error).message); }
    console.log(`Removed profile dir: ${result.dir}`);
    if (result.userID && process.platform === 'darwin') {
      console.log('');
      console.log(`Note: macOS Keychain still has an entry created by claude for this profile.`);
      console.log(`To remove it manually:`);
      console.log(`  security delete-generic-password -a "${result.userID}" -s "Claude Code-credentials"`);
    }
    return;
  }

  // Check for update (reads cache synchronously — never blocks). Passthrough
  // is included so long Claude sessions can show a hint, but updates are
  // explicit: this tool handles credentials, so it must never install code in
  // the background while the user is trying to work.
  const updateInfo = cmd.action !== 'temporary-switch'
    ? checkForUpdate(VERSION)
    : null;

  if (updateInfo && cmd.action !== 'update' && cmd.action !== 'passthrough') {
    const isTTY = process.stdin.isTTY && process.stderr.isTTY;
    if (isTTY) {
      // Interactive terminal: offer to update now.
      process.stderr.write(
        `\n  Update available: ${VERSION} → ${updateInfo.latestVersion}\n`
      );
      const answer = await askYN('  Update now? [y/N] ');
      if (answer) {
        const ok = performUpdate();
        if (ok) {
          console.log(`\nUpdated to v${updateInfo.latestVersion}. Open a new terminal to use the new version.`);
          process.exit(0);
        } else {
          console.error('\nUpdate failed. Run manually:');
          console.error(`  ${updateInfo.installCommand}`);
        }
      } else {
        process.stderr.write(`  Run: ${updateInfo.installCommand}\n\n`);
      }
    } else {
      // Non-interactive (piped/scripted): just print the hint to stderr.
      process.stderr.write(
        `\n  Update available: ${VERSION} → ${updateInfo.latestVersion}\n` +
        `  Run: ${updateInfo.installCommand}\n\n`
      );
    }
  }

  // Recover from a previously interrupted --as session before any switch operation.
  // This must run at the top of the dispatch so that switch-to and switch-interactive
  // also benefit, not just passthrough commands.
  if (cmd.action === 'switch-interactive' || cmd.action === 'switch-to' || cmd.action === 'temporary-switch') {
    const recovered = checkPendingRestore(cJson, aDir);
    if (recovered) {
      console.log(`Restored account: ${recovered} (from interrupted --as)\n`);
    }
  }

  // Shared context for the per-command handlers extracted under
  // `src/commands/`. Keeps the dispatcher thin: parse → handler.
  const ctx: CommandContext = {
    claudeJsonPath: cJson,
    accountsDirPath: aDir,
    updateInfo,
    selfUrl: import.meta.url,
  };

  switch (cmd.action) {
    case 'switch-interactive':
      // Persistent menu loop when we have a real terminal — actions return to
      // the menu instead of exiting. Falls back to the legacy numbered list
      // for pipes / CI / dumb terminals that can't render arrow-key
      // navigation.
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await runApp(cJson, aDir);
      } else {
        await switchInteractive(cJson, aDir);
      }
      break;

    case 'switch-to': {
      const resolved = resolveAlias(cmd.target, aDir);
      const accounts = listAccounts(aDir);
      const matches = fuzzyMatch(resolved, accounts);
      if (matches.length === 1) {
        // Warn (don't block) if other claude sessions are running — they
        // won't see the switch until restarted. See FAQ in README.
        const { countActiveClaudeSessions, buildActiveSessionsWarning } = await import('../src/active-sessions.js');
        const sessions = countActiveClaudeSessions(getSavedClaudeBin());
        const warning = buildActiveSessionsWarning(sessions.count);
        if (warning) process.stderr.write(`${warning}\n\n`);
        // Bundle switch + fallback flip in one withLock so a concurrent
        // `claude switch` can't race the two writes (see switcher.ts).
        const outcome = switchToAndSyncFallback(matches[0]!, cJson, aDir, { autoFlipFallback: true });
        console.log(outcome.message);
        process.stderr.write(outcome.hasApiKey ? '  Fallback ON — API key active\n' : '  Fallback OFF — no API key\n');
      } else if (matches.length > 1) {
        console.log('Multiple matches:');
        for (const m of matches) console.log(`  ${m}`);
        console.log('Be more specific.');
      } else {
        console.log(`No account matching "${cmd.target}". Run: claude switch list`);
      }
      break;
    }

    case 'add':
      await handleAdd(ctx);
      break;

    case 'dashboard':
      // Alias for the persistent menu — same screen.
      await runApp(cJson, aDir);
      break;

    case 'list':
      handleList(ctx);
      break;

    case 'alias-set':
      handleAliasSet(ctx, cmd.name, cmd.email);
      break;

    case 'alias-list':
      handleAliasList(ctx);
      break;

    case 'alias-remove':
      handleAliasRemove(ctx, cmd.name);
      break;

    case 'remove':
      await handleRemove(ctx, cmd.email);
      break;

    case 'status':
      handleStatus(ctx);
      break;

    case 'apikey-set':
      await handleApikeySet(ctx, cmd.target);
      break;

    case 'apikey-show':
      handleApikeyShow(ctx, cmd.target);
      break;

    case 'apikey-remove':
      handleApikeyRemove(ctx, cmd.target);
      break;

    case 'fallback':
      handleFallback(ctx, cmd.mode);
      break;

    case 'fallback-auto':
      handleFallbackAuto(ctx, cmd.mode, cmd.threshold);
      break;

    case 'fallback-auto-engage':
      handleFallbackAutoEngage(ctx, cmd.mode, cmd.threshold);
      break;

    case 'usage':
      await handleUsage(ctx, { force: cmd.force, refreshOnly: cmd.refreshOnly });
      break;

    case 'completions':
      handleCompletions(cmd.shell);
      break;

    case 'version':
      handleVersion();
      break;

    case 'help':
      handleHelp();
      break;

    case 'temporary-switch':
      await handleTemporarySwitch(ctx, cmd.target, cmd.args);
      break;

    case 'setup':
      await handleSetup(ctx);
      break;

    case 'update':
      await handleUpdate();
      break;

    case 'passthrough': {
      const restored = checkPendingRestore(cJson, aDir);
      if (restored) {
        console.log(`Restored account: ${restored} (from interrupted --as)\n`);
      }

      const claudeBin = findClaude();

      // Snapshot the (active email, fallback env, auto-revert decision) as a
      // single atomic block. Without the lock a concurrent `claude switch B`
      // could swap the active email between getCurrent() and fallbackEnvFor(),
      // pairing email-B's identity with email-A's API key — billing the wrong
      // account. The auto-disable also runs inside this lock so its
      // setFallbackEnabled(false) is reflected by the fallbackEnvFor() read.
      const snapshot = withLock(aDir, () => {
        const e = getCurrent(cJson);
        if (!e) return null;
        const accounts = listAccounts(aDir);
        const wasUnsaved = !accounts.includes(e);
        if (wasUnsaved) save(e, cJson, aDir);
        // Lazy-init smart fallback the first time a key-bearing account is
        // seen with no config file (migrates existing users automatically).
        if (getApiKey(e, aDir)) maybeInitSmartFallback(aDir);
        const auto = maybeAutoDisableFallback(aDir, cJson);
        // Auto-engage runs after auto-disable in the same lock so the
        // fallbackEnvFor() read below sees the final flag state. The config
        // invariant `engageThreshold > threshold` guarantees a single call
        // cannot both disable and engage (windows can't be < threshold AND
        // >= engageThreshold simultaneously).
        const engage = maybeAutoEngageFallback(aDir, cJson);
        return { email: e, wasUnsaved, auto, engage, extraEnv: fallbackEnvFor(e, aDir) };
      });
      if (!snapshot) {
        throw new ExitError('No account connected. Run: claude switch add');
      }
      const { email, wasUnsaved, auto, engage, extraEnv } = snapshot;

      if (wasUnsaved) {
        process.stderr.write(`Detected account: ${email} (saved automatically)\n\n`);
      }
      if (auto.disabled) {
        const sevenStr = auto.sevenPct !== undefined ? `, 7d:${auto.sevenPct.toFixed(0)}%` : '';
        process.stderr.write(
          `📈 Subscription back online (5h:${auto.fivePct!.toFixed(0)}%${sevenStr}, ` +
          `threshold ${auto.threshold}%) — switched back to OAuth\n\n`,
        );
      }
      if (engage.engaged) {
        const win = engage.reason === '5h'
          ? `5h:${engage.fivePct!.toFixed(0)}%`
          : `7d:${engage.sevenPct!.toFixed(0)}%`;
        process.stderr.write(
          `📉 Subscription near cap (${win}, threshold ${engage.threshold}%) — ` +
          `switched to API key fallback\n\n`,
        );
      } else if (engage.blocked) {
        process.stderr.write(`⚠ auto-engage wanted to switch to API key but ${engage.blocked}\n\n`);
      }
      if (updateInfo) {
        process.stderr.write(
          `↥ claude-switch ${VERSION} → ${updateInfo.latestVersion} available\n` +
          `  Update manually: ${updateInfo.installCommand}\n\n`,
        );
      }
      // Banner on stderr so we don't pollute structured stdout (e.g. when
      // claude is piped into jq with --output-format json).
      process.stderr.write(`🔑 ${email}\n\n`);
      if (extraEnv) {
        process.stderr.write('(fallback on — using saved API key)\n\n');
      } else {
        // Read-only check: if a recent usage snapshot says we're near the
        // limit and smart fallback isn't enabled (no config + key exists),
        // remind the user to save an API key to unlock auto-switching.
        // Never fetches — only consults whatever the user already cached.
        const cache = readUsageCache(aDir);
        if (cache?.payload && cache.payload.five_hour.utilization >= 85 && getApiKey(email, aDir)) {
          process.stderr.write(
            `⚠ subscription 5h window at ${cache.payload.five_hour.utilization.toFixed(0)}%. ` +
            `Smart fallback will switch to your API key automatically.\n\n`,
          );
        }
      }

      // If the active account has an API key, start the local proxy so the
      // session can transition between OAuth and API live, in BOTH directions.
      //
      // Proxy mode resolution (per account `authMode` preference + token
      // health, see `resolveEffectiveAuthMode`):
      //   oauth-first  → OAuth first, retry API on 429/error per request,
      //                  enter API-burst sub-state after N consecutive
      //                  OAuth failures + periodic OAuth probe to recover.
      //   api-first    → API key always.
      //   oauth-only   → no proxy needed (no key) — fall through.
      //   error        → no auth available — fall through (claude will fail).
      const activeApiKey = getApiKey(email, aDir);

      if (activeApiKey) {
        const { resolveAccountPrefs, resolveEffectiveAuthMode } = await import('../src/preferences.js');
        const prefs = resolveAccountPrefs(email, aDir);
        const tokenHealth = getTokenHealth(cJson);
        const oauthHealthy = tokenHealth.status === 'valid' || tokenHealth.status === 'present';
        const effective = resolveEffectiveAuthMode({
          authMode: prefs.authMode,
          oauthHealthy,
          hasApiKey: true,
        });
        // `oauth-only` and `error` mean "don't use the API key" — handled
        // below by falling through to the no-key branch.
        if (effective === 'oauth-first' || effective === 'api-first') {
          const proxy = await startFallbackProxy({
            apiKey: activeApiKey,
            mode: effective,
          });
          process.on('exit', () => proxy.close());
          // Clear any inherited ANTHROPIC_API_KEY so the binary uses the proxy
          // and cannot bypass ANTHROPIC_BASE_URL.
          proxyRun(claudeBin, cmd.args, {
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
            ANTHROPIC_API_KEY: '',
          });
          break;
        }
      }
      proxyRun(claudeBin, cmd.args, extraEnv);
      break;
    }
  }
}

const selfUrl = fileURLToPath(import.meta.url);
const invoked = process.argv[1];
if (invoked) {
  try {
    if (fs.realpathSync(invoked) === fs.realpathSync(selfUrl)) {
      main().catch(handleError);
    }
  } catch {
    // If realpathSync fails, we're likely being imported for testing
  }
}

function handleError(e: unknown): void {
  if (e instanceof ExitError) {
    console.error(e.message);
    process.exit(e.code);
  }
  // Anything else is an unexpected internal error. Print the message
  // without the raw stack trace — stack frames leak install paths and
  // sometimes credential-adjacent state on stderr. Set CLAUDE_SWITCH_DEBUG=1
  // to opt back into the full trace for bug reports.
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Internal error: ${msg}`);
  if (process.env.CLAUDE_SWITCH_DEBUG === '1' && e instanceof Error && e.stack) {
    console.error(e.stack);
  } else {
    console.error('Set CLAUDE_SWITCH_DEBUG=1 to see the stack trace.');
  }
  process.exit(1);
}
