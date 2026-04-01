#!/usr/bin/env node
// claude-switch — Claude Code multi-account wrapper

import fs from 'node:fs';
import { resolve } from '../src/resolver.js';
import { getCurrent, save, list as listAccounts, remove as removeAccount } from '../src/accounts.js';
import { fuzzyMatch, switchTo, switchInteractive, addAccount } from '../src/switcher.js';
import { run as proxyRun } from '../src/proxy.js';
import { claudeJsonPath, accountsDir } from '../src/paths.js';
import { generateBash, generateZsh, generateFish, generatePowerShell } from '../src/completions.js';
import { VERSION } from '../src/version.js';
import { ExitError } from '../src/errors.js';
import { setAlias, listAliases, removeAlias, resolveAlias, getAliasesForEmail } from '../src/aliases.js';
import { getTokenHealth } from '../src/token.js';

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
  | { action: 'alias-remove'; name: string | undefined };

export function parseCommand(args: string[]): Command {
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
  const selfPath = fs.realpathSync(new URL(import.meta.url).pathname);
  const bin = resolve({
    envBin: process.env.CLAUDE_SWITCH_BIN || '',
    selfPath,
    pathEnv: process.env.PATH || '',
  });
  if (!bin) {
    console.error('Error: could not find the real claude binary in PATH.');
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
  claude switch help               Show this help
  claude --as <alias|email> ...    Use account temporarily
  claude switch --completions <shell>  Generate shell completions

All other commands are passed through to the real claude binary.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = parseCommand(args);
  const cJson = claudeJsonPath();
  const aDir = accountsDir();

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

    case 'passthrough': {
      const claudeBin = findClaude();
      const email = getCurrent(cJson);

      if (email) {
        const accounts = listAccounts(aDir);
        if (accounts.length === 0) {
          save(email, cJson, aDir);
          console.log(`Detected existing account: ${email} (saved automatically)\n`);
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

const selfUrl = new URL(import.meta.url).pathname;
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
