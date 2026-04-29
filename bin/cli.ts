#!/usr/bin/env node
// claude-switch — Claude Code multi-account wrapper

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from '../src/resolver.js';
import { getCurrent, save, list as listAccounts, remove as removeAccount } from '../src/accounts.js';
import { withLock } from '../src/lock.js';
import { fuzzyMatch, switchTo, switchInteractive, addAccount, runTemporarySwitch, checkPendingRestore } from '../src/switcher.js';
import { run as proxyRun } from '../src/proxy.js';
import { claudeJsonPath, accountsDir } from '../src/paths.js';
import { generateBash, generateZsh, generateFish, generatePowerShell } from '../src/completions.js';
import { VERSION } from '../src/version.js';
import { ExitError } from '../src/errors.js';
import { setAlias, listAliases, removeAlias, resolveAlias, getAliasesForEmail } from '../src/aliases.js';
import { getTokenHealth } from '../src/token.js';
import { getSavedClaudeBin, runSetup } from '../src/setup.js';
import { checkForUpdate, fetchLatestVersionSync, performUpdate, isNewer, detectInstallCommand, writeUpdateCache } from '../src/update-check.js';
import { getApiKey, setApiKey, removeApiKey, maskApiKey } from '../src/apikey.js';
import { isFallbackEnabled, setFallbackEnabled } from '../src/fallback.js';
import { getAutoFallbackConfig, setAutoFallbackConfig, maybeAutoDisableFallback } from '../src/auto-fallback.js';
import { fetchUsageCached, getAccessTokenFromKeychain, readUsageCache, readUsageCacheFor, isUsageCacheStale, triggerBackgroundUsageRefresh } from '../src/usage.js';
import { selectAccountInteractive } from '../src/ui/select-account.js';
import { runMainMenu } from '../src/ui/main-menu.js';
import { setApiKeyInteractive } from '../src/ui/set-apikey.js';
import { runSetupWizard } from '../src/ui/setup-wizard.js';
import { addAccountInteractive } from '../src/ui/add-account.js';
import { removeAccountInteractive } from '../src/ui/remove-account.js';

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
  | { action: 'usage'; force: boolean; refreshOnly: boolean }
  | { action: 'statusline'; format: 'compact' | 'full' | 'json'; color: boolean };

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
      if (sub2 === 'auto') {
        const sub3 = args[3];
        if (!sub3 || sub3 === 'status') return { action: 'fallback-auto', mode: 'status' };
        if (sub3 === 'off') return { action: 'fallback-auto', mode: 'off' };
        if (sub3 === 'on') {
          const tIdx = args.indexOf('--threshold');
          if (tIdx >= 4 && args[tIdx + 1] !== undefined) {
            const t = parseInt(args[tIdx + 1], 10);
            if (!Number.isFinite(t) || t < 1 || t > 100) {
              throw new ExitError('--threshold must be an integer between 1 and 100');
            }
            return { action: 'fallback-auto', mode: 'on', threshold: t };
          }
          return { action: 'fallback-auto', mode: 'on' };
        }
        throw new ExitError('Usage: claude switch fallback auto <on|off|status> [--threshold <1-100>]');
      }
      throw new ExitError('Usage: claude switch fallback <on|off|status|auto>');
    }
    case 'usage': {
      const flags = args.slice(2);
      const force = flags.includes('--force');
      const refreshOnly = flags.includes('--refresh-only');
      return { action: 'usage', force, refreshOnly };
    }
    case 'statusline':
    case 'sl': {
      const rest = args.slice(2);
      const fmt = rest.includes('--full') ? 'full' : rest.includes('--json') ? 'json' : 'compact';
      const color = !rest.includes('--no-color');
      return { action: 'statusline', format: fmt as 'compact' | 'full' | 'json', color };
    }
    case 'alias': {
      const sub2 = args[2];
      if (!sub2 || sub2 === '--list') return { action: 'alias-list' };
      if (sub2 === '--remove') return { action: 'alias-remove', name: args[3] };
      return { action: 'alias-set', name: sub2, email: args[3] };
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

function showHelp(): void {
  console.log(`claude-switch — multi-account wrapper for Claude Code

Usage:
  claude switch                          Switch account (interactive menu)
  claude switch <alias|email>            Switch to account (alias or fuzzy match)
  claude switch add                      Add a new account (opens browser)
  claude switch list                     List saved accounts
  claude switch remove <email>           Remove a saved account
  claude switch status                   Show active account, token, fallback
  claude switch alias <n> <email>        Set an alias
  claude switch alias --list             List aliases
  claude switch alias --remove <n>       Remove an alias
  claude switch apikey set <a|e>         Save an Anthropic API key for an account
  claude switch apikey show <a|e>        Show saved API key (masked)
  claude switch apikey remove <a|e>      Delete saved API key
  claude switch fallback on|off|status   Toggle API key fallback (overrides OAuth)
  claude switch fallback auto on|off     Smart-switch: auto-OFF when 5h+7d drop
                                         opts: --threshold <1-100> (default 80)
  claude switch usage [--force]          Show subscription usage % (5h, 7d)
  claude switch statusline [opts]        One-line account/mode for shell prompt
                                         opts: --full | --json | --no-color
  claude switch update                   Check for updates and install if available
  claude switch help                     Show this help
  claude switch setup                    Re-run first-time setup
  claude --as <alias|email> ...          Use account temporarily
  claude switch --completions <shell>    Generate shell completions

All other commands are passed through to the real claude binary.`);
}

/** Read a line from stdin without echoing it (TTY) or from a pipe (non-TTY). */
async function promptSecret(question: string): Promise<string> {
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
function resolveTargetEmail(target: string, accountsDirPath: string): string {
  const resolved = resolveAlias(target, accountsDirPath);
  const accounts = listAccounts(accountsDirPath);
  const matches = accounts.filter(a => a === resolved);
  if (matches.length === 1) return matches[0];
  // Fuzzy fallback for partial matches (mirrors switch behaviour).
  const fuzzy = accounts.filter(a => a.toLowerCase().includes(resolved.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new ExitError(`Multiple matches for "${target}":\n${fuzzy.map(m => `  ${m}`).join('\n')}\nBe more specific.`);
  }
  throw new ExitError(`No account matching "${target}". Run: claude switch list`);
}

/**
 * If fallback is enabled and the given account has a saved API key,
 * return an env override containing ANTHROPIC_API_KEY. Otherwise null.
 *
 * When null is returned, the spawned claude inherits the parent env unchanged
 * — including any user-set ANTHROPIC_API_KEY in the shell. We don't strip it.
 */
function fallbackEnvFor(email: string, accountsDirPath: string): NodeJS.ProcessEnv | null {
  if (!isFallbackEnabled(accountsDirPath)) return null;
  const key = getApiKey(email, accountsDirPath);
  if (!key) return null;
  return { ANTHROPIC_API_KEY: key };
}

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
  const shortName = aliases[0] ?? email.split('@')[0];

  if (format === 'json') {
    const json = {
      email,
      shortName,
      mode: usingApiKey ? 'api' : 'oauth',
      fallback: fallbackOn,
      hasApiKey: !!apiKey,
      fiveHour: fivePct ?? null,
      sevenDay: sevenPct ?? null,
    };
    process.stdout.write(JSON.stringify(json) + '\n');
    return;
  }

  const modeLabel = usingApiKey ? yellow('API') : green('OAuth');
  const usageBadge = (() => {
    if (fivePct === undefined) return '';
    const pctStr = `${fivePct.toFixed(0)}%`;
    if (fivePct >= 90) return ` ${red(`5h:${pctStr}`)}`;
    if (fivePct >= 75) return ` ${yellow(`5h:${pctStr}`)}`;
    return ` ${dim(`5h:${pctStr}`)}`;
  })();

  if (format === 'full') {
    process.stdout.write(`🔑 ${cyan(email)} · ${modeLabel}${usageBadge}\n`);
  } else {
    // compact (default) — short alias + mode badge + optional usage
    process.stdout.write(`🔑 ${cyan(shortName)} ${modeLabel}${usageBadge}\n`);
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

  // Check for update (reads cache synchronously — never blocks).
  // Skip for passthrough/temporary-switch to avoid polluting claude's output.
  const updateInfo = (cmd.action !== 'passthrough' && cmd.action !== 'temporary-switch')
    ? checkForUpdate(VERSION)
    : null;

  if (updateInfo && cmd.action !== 'update') {
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
          console.log('\nUpdated. Restart claude to use the new version.');
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

  switch (cmd.action) {
    case 'switch-interactive':
      // Persistent menu loop when we have a real terminal — actions return to
      // the menu instead of exiting. Falls back to the legacy numbered list
      // for pipes / CI / dumb terminals that can't render arrow-key
      // navigation.
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await runMainMenu(cJson, aDir);
      } else {
        await switchInteractive(cJson, aDir);
      }
      break;

    case 'switch-to': {
      const resolved = resolveAlias(cmd.target, aDir);
      const accounts = listAccounts(aDir);
      const matches = fuzzyMatch(resolved, accounts);
      if (matches.length === 1) {
        console.log(switchTo(matches[0], cJson, aDir));
      } else if (matches.length > 1) {
        console.log('Multiple matches:');
        matches.forEach(m => console.log(`  ${m}`));
        console.log('Be more specific.');
      } else {
        console.log(`No account matching "${cmd.target}". Run: claude switch list`);
      }
      break;
    }

    case 'add': {
      const claudeBin = findClaude();
      if (process.stdin.isTTY && process.stderr.isTTY) {
        await addAccountInteractive(claudeBin, cJson, aDir);
      } else {
        await addAccount(claudeBin, cJson, aDir);
      }
      break;
    }

    case 'list': {
      const accounts = listAccounts(aDir);
      const current = getCurrent(cJson);
      if (accounts.length === 0) {
        console.log('No saved accounts. Run: claude switch add');
      } else {
        console.log('Saved accounts:\n');
        for (const email of accounts) {
          const isActive = email === current;
          const marker = isActive ? '  * ' : '    ';
          const activeLabel = isActive ? ' (active)' : '';
          const emailAliases = getAliasesForEmail(email, aDir);
          const aliasLabel = emailAliases.length > 0 ? ` [${emailAliases.join(', ')}]` : '';
          console.log(`${marker}${email}${activeLabel}${aliasLabel}`);
        }
      }
      break;
    }

    case 'alias-set': {
      if (!cmd.email) {
        throw new ExitError('Usage: claude switch alias <name> <email>');
      }
      try {
        setAlias(cmd.name, cmd.email, aDir);
      } catch (e) {
        if (e instanceof ExitError) throw e;
        throw new ExitError((e as Error).message);
      }
      console.log(`Alias set: ${cmd.name} → ${cmd.email}`);
      break;
    }

    case 'alias-list': {
      const aliases = listAliases(aDir);
      const entries = Object.entries(aliases);
      if (entries.length === 0) {
        console.log('No aliases. Set one with: claude switch alias <name> <email>');
      } else {
        console.log('Aliases:\n');
        for (const [name, email] of entries) {
          console.log(`  ${name} → ${email}`);
        }
      }
      break;
    }

    case 'alias-remove': {
      if (!cmd.name) {
        throw new ExitError('Usage: claude switch alias --remove <name>');
      }
      try {
        removeAlias(cmd.name, aDir);
        console.log(`Alias removed: ${cmd.name}`);
      } catch (e) {
        if (e instanceof ExitError) throw e;
        throw new ExitError((e as Error).message);
      }
      break;
    }

    case 'remove':
      if (!cmd.email) {
        throw new ExitError('Usage: claude switch remove <email>');
      }
      if (process.stdin.isTTY && process.stderr.isTTY) {
        await removeAccountInteractive(cmd.email, cJson, aDir);
      } else {
        try {
          const current = getCurrent(cJson);
          if (cmd.email === current) {
            throw new ExitError('Cannot remove the active account. Switch to another account first.');
          }
          removeAccount(cmd.email, aDir);
          console.log(`Removed: ${cmd.email}`);
        } catch (e) {
          if (e instanceof ExitError) throw e;
          throw new ExitError((e as Error).message);
        }
      }
      break;

    case 'status': {
      const current = getCurrent(cJson);
      if (!current) {
        console.log('No account connected. Run: claude switch add');
        break;
      }

      // Auto-save if active account not yet saved, or if the saved file
      // pre-dates keychain support and lacks token data.
      const savedAccounts = listAccounts(aDir);
      if (!savedAccounts.includes(current)) {
        withLock(aDir, () => save(current, cJson, aDir));
        console.log(`Detected account: ${current} (saved automatically)\n`);
      } else {
        // Migrate old account files that lack _keychain by re-saving.
        const accountFile = path.join(aDir, `${current}.json`);
        try {
          const existing = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
          if (!existing._keychain) {
            withLock(aDir, () => save(current, cJson, aDir));
          }
        } catch { /* ignore, best-effort migration */ }
      }

      const health = getTokenHealth(cJson);
      const emailAliases = getAliasesForEmail(current, aDir);

      console.log(`Active account: ${current}`);
      if (emailAliases.length > 0) {
        console.log(`  Alias: ${emailAliases.join(', ')}`);
      }

      switch (health.status) {
        case 'valid':
          console.log(`  Token: valid (expires ${health.expiresIn})`);
          break;
        case 'expired':
          console.log(`  Token: expired (${health.expiresIn}) — run: claude switch add`);
          break;
        case 'present':
          console.log('  Token: present');
          break;
        case 'missing':
          console.log('  Token: missing — run: claude switch add');
          break;
      }

      const apiKey = getApiKey(current, aDir);
      const fallbackOn = isFallbackEnabled(aDir);
      console.log(`  API key: ${apiKey ? maskApiKey(apiKey) : 'not set'}`);
      console.log(`  Fallback: ${fallbackOn ? 'on' : 'off'}`);
      if (fallbackOn && !apiKey) {
        console.log('  ⚠ fallback is on but no API key saved — claude will use OAuth');
      }
      break;
    }

    case 'apikey-set': {
      if (!cmd.target) {
        throw new ExitError('Usage: claude switch apikey set <alias|email>');
      }
      const email = resolveTargetEmail(cmd.target, aDir);

      // TUI when we have a real terminal; legacy text fallback for pipes/CI.
      if (process.stdin.isTTY && process.stderr.isTTY) {
        const result = await setApiKeyInteractive(email, aDir);
        if (!result.saved && !result.cancelled) {
          // setApiKey threw — let the next invocation try again.
          process.exit(1);
        }
        break;
      }

      // Non-TTY fallback: read first line of stdin as the key, no prompts.
      const existing = getApiKey(email, aDir);
      if (existing) {
        throw new ExitError(
          `An API key is already saved for ${email} (${maskApiKey(existing)}). ` +
          `Run interactively to overwrite.`,
        );
      }
      const key = await promptSecret('');
      if (!key) throw new ExitError('No key on stdin. Aborted.');
      withLock(aDir, () => setApiKey(email, key, aDir));
      console.log(`Saved API key for ${email} (${maskApiKey(key)}).`);
      break;
    }

    case 'apikey-show': {
      if (!cmd.target) {
        throw new ExitError('Usage: claude switch apikey show <alias|email>');
      }
      const email = resolveTargetEmail(cmd.target, aDir);
      const key = getApiKey(email, aDir);
      if (!key) {
        console.log(`No API key saved for ${email}.`);
      } else {
        console.log(`${email}: ${maskApiKey(key)}`);
      }
      break;
    }

    case 'apikey-remove': {
      if (!cmd.target) {
        throw new ExitError('Usage: claude switch apikey remove <alias|email>');
      }
      const email = resolveTargetEmail(cmd.target, aDir);
      const removed = withLock(aDir, () => removeApiKey(email, aDir));
      console.log(removed
        ? `Removed API key for ${email}.`
        : `No API key was saved for ${email}.`);
      break;
    }

    case 'fallback': {
      if (cmd.mode === 'status') {
        const on = isFallbackEnabled(aDir);
        const current = getCurrent(cJson);
        const hasKey = current ? !!getApiKey(current, aDir) : false;
        console.log(`Fallback: ${on ? 'on' : 'off'}`);
        if (current) {
          console.log(`Active account ${current}: ${hasKey ? 'has API key' : 'no API key (run: claude switch apikey set)'}`);
        }
        if (on && current && !hasKey) {
          console.log('Warning: fallback is on but the active account has no saved API key — claude will use OAuth.');
        }
        break;
      }
      const on = cmd.mode === 'on';
      setFallbackEnabled(aDir, on);
      console.log(`Fallback: ${on ? 'on' : 'off'}`);
      if (on) {
        const current = getCurrent(cJson);
        if (current && !getApiKey(current, aDir)) {
          console.log(`Note: active account ${current} has no saved API key. Run: claude switch apikey set ${current}`);
        } else if (current) {
          console.log('Subsequent `claude` runs will inject the saved API key as ANTHROPIC_API_KEY.');
          console.log('');
          console.log('IMPORTANT: the first time, Claude Code will prompt:');
          console.log('    "Use this API key? [y/N]"');
          console.log('Press y to approve — your choice is remembered.');
          console.log('If you miss it or press N, claude silently keeps using OAuth.');
        }
      }
      break;
    }

    case 'fallback-auto': {
      const config = getAutoFallbackConfig(aDir);
      if (cmd.mode === 'status') {
        console.log(`Smart-switch: ${config.enabled ? 'on' : 'off'}`);
        console.log(`Threshold:    ${config.threshold}% (5h and 7d must drop below this)`);
        if (config.enabled) {
          const current = getCurrent(cJson);
          const hasKey = current ? !!getApiKey(current, aDir) : false;
          if (!current) {
            console.log('No active account — smart-switch only acts on the active one.');
          } else if (!hasKey) {
            console.log(`Note: ${current} has no saved API key, so fallback would do nothing anyway.`);
          }
        }
        break;
      }
      const enabled = cmd.mode === 'on';
      const next = setAutoFallbackConfig(aDir, {
        enabled,
        ...(cmd.threshold !== undefined ? { threshold: cmd.threshold } : {}),
      });
      console.log(`Smart-switch: ${next.enabled ? 'on' : 'off'}`);
      if (enabled) {
        console.log(`Threshold:    ${next.threshold}%`);
        console.log(
          `\nWhen fallback is on, claude-switch will turn it back off the next ` +
          `time you run \`claude\` if both 5h and 7d utilisation drop below ` +
          `${next.threshold}% — saving your API credits the moment your ` +
          `subscription has headroom again.`,
        );
      }
      break;
    }

    case 'usage': {
      // Snapshot (token, account) atomically. A concurrent `claude switch B`
      // between these two reads would otherwise pair token-of-A with
      // account-label-of-B, and we'd cache A's quota under B's name.
      const { token, currentAccount } = withLock(aDir, () => ({
        token: getAccessTokenFromKeychain(cJson),
        currentAccount: getCurrent(cJson) || undefined,
      }));
      if (!token) {
        if (cmd.refreshOnly) return; // background refresh: silently no-op
        throw new ExitError(
          'No OAuth access token available — only Max/Pro subscribers can use this. ' +
          'Make sure you are logged in: claude switch status',
        );
      }
      // refresh-only: just hit the endpoint and update the cache, no output.
      // Used by the statusline to keep cache fresh asynchronously.
      if (cmd.refreshOnly) {
        await fetchUsageCached(aDir, token, { force: true, account: currentAccount });
        return;
      }
      // When forcing, surface the raw fetch error so failures are diagnosable
      // (the cached path silently swallows non-429 errors to keep noise low).
      if (cmd.force) {
        const { fetchUsage: rawFetch } = await import('../src/usage.js');
        const raw = await rawFetch(token);
        if (!raw.ok && !raw.rateLimited) {
          console.log(`Fetch error: ${raw.error}`);
        }
      }
      const cache = await fetchUsageCached(aDir, token, { force: cmd.force, account: currentAccount });
      if (cache.rateLimitedUntil && cache.rateLimitedUntil > Date.now()) {
        const waitSec = Math.ceil((cache.rateLimitedUntil - Date.now()) / 1000);
        console.log(
          `Anthropic's usage endpoint is rate-limiting us. ` +
          `Retry in ~${waitSec}s${cache.payload ? ' (showing last cached values below)' : ''}.`,
        );
      }
      if (cache.payload) {
        const ageMin = Math.round((Date.now() - cache.fetchedAt) / 60_000);
        const fmtReset = (iso?: string): string => {
          if (!iso) return '';
          const d = new Date(iso);
          if (isNaN(d.getTime())) return '';
          const min = Math.round((d.getTime() - Date.now()) / 60_000);
          if (min < 60) return ` (resets in ${min}m)`;
          if (min < 60 * 24) return ` (resets in ${Math.round(min / 60)}h)`;
          return ` (resets in ${Math.round(min / 60 / 24)}d)`;
        };
        const five = cache.payload.five_hour;
        const seven = cache.payload.seven_day;
        const opus = cache.payload.seven_day_opus;
        const sonnet = cache.payload.seven_day_sonnet;
        console.log(`Subscription usage (cached ${ageMin} min ago):`);
        console.log(`  5-hour window:    ${five.utilization.toFixed(1)}%${fmtReset(five.resets_at)}`);
        console.log(`  7-day window:     ${seven.utilization.toFixed(1)}%${fmtReset(seven.resets_at)}`);
        if (opus) console.log(`    └ Opus 7d:      ${opus.utilization.toFixed(1)}%`);
        if (sonnet) console.log(`    └ Sonnet 7d:    ${sonnet.utilization.toFixed(1)}%`);
        if (five.utilization >= 85) {
          console.log('\n⚠ 5-hour window near limit. Consider:  claude switch fallback on');
        }
      } else if (!cache.rateLimitedUntil) {
        console.log('Could not fetch usage — endpoint unreachable. Try again later.');
      }
      break;
    }

    case 'completions': {
      const generators: Record<string, () => string> = {
        bash: generateBash,
        zsh: generateZsh,
        fish: generateFish,
        powershell: generatePowerShell,
      };
      const gen = cmd.shell ? generators[cmd.shell] : undefined;
      if (!gen) {
        throw new ExitError('Usage: claude switch --completions <bash|zsh|fish|powershell>');
      }
      console.log(gen());
      break;
    }

    case 'version':
      console.log(`claude-switch ${VERSION}`);
      break;

    case 'help':
      showHelp();
      break;

    case 'temporary-switch': {
      if (!cmd.target) {
        throw new ExitError('Usage: claude --as <account> [args...]');
      }

      const claudeBin = findClaude();
      const resolved = resolveAlias(cmd.target, aDir);
      const accounts = listAccounts(aDir);
      const matches = fuzzyMatch(resolved, accounts);

      if (matches.length === 0) {
        throw new ExitError(`No account matching "${cmd.target}". Run: claude switch list`);
      }
      if (matches.length > 1) {
        throw new ExitError(`Multiple matches for "${cmd.target}":\n${matches.map(m => `  ${m}`).join('\n')}\nBe more specific.`);
      }

      // runTemporarySwitch handles save/restore (incl. Keychain), SIGINT, and never returns.
      const extraEnv = fallbackEnvFor(matches[0], aDir);
      if (extraEnv) {
        process.stderr.write(`(fallback on — using saved API key for ${matches[0]})\n\n`);
      }
      await runTemporarySwitch(claudeBin, matches[0], cmd.args, cJson, aDir, extraEnv);
      break;
    }

    case 'setup':
      if (process.stdin.isTTY && process.stderr.isTTY) {
        await runSetupWizard(fileURLToPath(import.meta.url));
      } else {
        await runSetup(fileURLToPath(import.meta.url));
      }
      break;

    case 'update': {
      console.log(`Current version: ${VERSION}`);
      process.stdout.write('Checking for updates...');
      const latest = await fetchLatestVersionSync();
      process.stdout.write('\r' + ' '.repeat(30) + '\r'); // clear the line

      if (!latest) {
        console.log('Could not reach npm registry. Check your connection.');
        break;
      }

      // Update cache so the background notifier reflects the result.
      writeUpdateCache(latest);

      if (!isNewer(VERSION, latest)) {
        console.log(`Already up to date (${VERSION}).`);
        break;
      }

      console.log(`New version available: ${VERSION} → ${latest}`);

      const isTTY = process.stdin.isTTY && process.stdout.isTTY;
      const shouldUpdate = isTTY ? await askYN('Update now? [y/N] ') : false;

      if (!isTTY) {
        console.log('Run in an interactive terminal to update, or run:');
        console.log(`  ${[...detectInstallCommand()].join(' ')}`);
        break;
      }

      if (!shouldUpdate) {
        console.log(`Skipped. Run: ${[...detectInstallCommand()].join(' ')}`);
        break;
      }

      const ok = performUpdate();
      if (ok) {
        console.log('\nUpdated successfully. Restart your terminal to use the new version.');
      } else {
        console.error('\nUpdate failed. Try running manually:');
        console.error(`  ${[...detectInstallCommand()].join(' ')}`);
      }
      break;
    }

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
        const auto = maybeAutoDisableFallback(aDir, cJson);
        return { email: e, wasUnsaved, auto, extraEnv: fallbackEnvFor(e, aDir) };
      });
      if (!snapshot) {
        throw new ExitError('No account connected. Run: claude switch add');
      }
      const { email, wasUnsaved, auto, extraEnv } = snapshot;

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
      // Banner on stderr so we don't pollute structured stdout (e.g. when
      // claude is piped into jq with --output-format json).
      process.stderr.write(`🔑 ${email}\n\n`);
      if (extraEnv) {
        process.stderr.write('(fallback on — using saved API key)\n\n');
      } else {
        // Read-only check: if a recent usage snapshot says we're near the
        // limit and the user has a saved key, hint at the fallback toggle.
        // Never fetches — only consults whatever the user already cached
        // via `claude switch usage`. Skips entirely if no cache exists.
        const cache = readUsageCache(aDir);
        if (cache?.payload && cache.payload.five_hour.utilization >= 85 && getApiKey(email, aDir)) {
          process.stderr.write(
            `⚠ subscription 5h window at ${cache.payload.five_hour.utilization.toFixed(0)}%. ` +
            `Run "claude switch fallback on" to use your API key instead.\n\n`,
          );
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
  throw e;
}
