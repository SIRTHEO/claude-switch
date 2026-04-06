#!/usr/bin/env node
// claude-switch — Claude Code multi-account wrapper

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from '../src/resolver.js';
import { getCurrent, save, list as listAccounts, remove as removeAccount } from '../src/accounts.js';
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
  | { action: 'update' };

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
  claude switch                    Switch account (interactive menu)
  claude switch <alias|email>      Switch to account (alias or fuzzy match)
  claude switch add                Add a new account (opens browser)
  claude switch list               List saved accounts
  claude switch remove <email>     Remove a saved account
  claude switch status             Show active account and token health
  claude switch alias <n> <email>  Set an alias
  claude switch alias --list       List aliases
  claude switch alias --remove <n> Remove an alias
  claude switch update             Check for updates and install if available
  claude switch help               Show this help
  claude switch setup              Re-run first-time setup
  claude --as <alias|email> ...    Use account temporarily
  claude switch --completions <shell>  Generate shell completions

All other commands are passed through to the real claude binary.`);
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = parseCommand(args);
  const cJson = claudeJsonPath();
  const aDir = accountsDir();

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
      await switchInteractive(cJson, aDir);
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
      await addAccount(claudeBin, cJson, aDir);
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
      setAlias(cmd.name, cmd.email, aDir);
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
        save(current, cJson, aDir);
        console.log(`Detected account: ${current} (saved automatically)\n`);
      } else {
        // Migrate old account files that lack _keychain by re-saving.
        const accountFile = path.join(aDir, `${current}.json`);
        try {
          const existing = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
          if (!existing._keychain) {
            save(current, cJson, aDir);
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
      await runTemporarySwitch(claudeBin, matches[0], cmd.args, cJson, aDir);
      break;
    }

    case 'setup':
      await runSetup(fileURLToPath(import.meta.url));
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
      const email = getCurrent(cJson);

      if (email) {
        const accounts = listAccounts(aDir);
        if (!accounts.includes(email)) {
          save(email, cJson, aDir);
          console.log(`Detected account: ${email} (saved automatically)\n`);
        }
        console.log(`🔑 ${email}\n`);
      } else {
        throw new ExitError('No account connected. Run: claude switch add');
      }

      proxyRun(claudeBin, cmd.args);
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
