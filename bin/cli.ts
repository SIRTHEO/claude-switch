#!/usr/bin/env node
// claude-switch — Claude Code multi-account wrapper

import fs from 'node:fs';
import { resolve } from '../src/resolver.js';
import { getCurrent, save, list as listAccounts, remove as removeAccount } from '../src/accounts.js';
import { fuzzyMatch, switchTo, switchInteractive, addAccount } from '../src/switcher.js';
import { run as proxyRun } from '../src/proxy.js';
import { claudeJsonPath, accountsDir } from '../src/paths.js';
import { generateBash, generateZsh, generateFish, generatePowerShell } from '../src/completions.js';

export type Command =
  | { action: 'switch-interactive' }
  | { action: 'switch-to'; target: string }
  | { action: 'add' }
  | { action: 'list' }
  | { action: 'remove'; email: string | undefined }
  | { action: 'status' }
  | { action: 'help' }
  | { action: 'completions'; shell: string | undefined }
  | { action: 'passthrough'; args: string[] };

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
    case '--completions': return { action: 'completions', shell: args[2] };
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
  claude switch                  Switch account (interactive menu)
  claude switch <email>          Switch to a specific account (fuzzy match)
  claude switch add              Add a new account (opens browser)
  claude switch list             List saved accounts
  claude switch remove <email>   Remove a saved account
  claude switch status           Show active account
  claude switch help             Show this help
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
      const accounts = listAccounts(aDir);
      const matches = fuzzyMatch(cmd.target, accounts);
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
          const marker = email === current ? '  * ' : '    ';
          console.log(`${marker}${email}${email === current ? ' (active)' : ''}`);
        }
      }
      break;
    }

    case 'remove':
      if (!cmd.email) {
        console.log('Usage: claude switch remove <email>');
        process.exit(1);
      }
      try {
        const current = getCurrent(cJson);
        if (cmd.email === current) {
          console.log('Cannot remove the active account. Switch to another account first.');
          process.exit(1);
        }
        removeAccount(cmd.email, aDir);
        console.log(`Removed: ${cmd.email}`);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
      break;

    case 'status': {
      const current = getCurrent(cJson);
      if (current) {
        console.log(current);
      } else {
        console.log('No account connected. Run: claude switch add');
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
        console.log('Usage: claude switch --completions <bash|zsh|fish|powershell>');
        process.exit(1);
      }
      console.log(gen());
      break;
    }

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
        console.error('⚠️  No account connected. Run: claude switch add');
        process.exit(1);
      }

      proxyRun(claudeBin, cmd.args);
      break;
    }
  }
}

// Only run main() when executed directly
const selfUrl = new URL(import.meta.url).pathname;
const invoked = process.argv[1];
if (invoked) {
  try {
    if (fs.realpathSync(invoked) === fs.realpathSync(selfUrl)) {
      main();
    }
  } catch {
    // If realpathSync fails, we're likely being imported for testing
  }
}
