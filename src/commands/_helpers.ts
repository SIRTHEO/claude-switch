// src/commands/_helpers.ts
// Shared utilities used by multiple per-command handlers. Internal — not
// part of any public API surface.

import { fileURLToPath } from 'node:url';
import { resolve } from '../resolver.js';
import { getSavedClaudeBin } from '../setup.js';
import { resolveAlias } from '../aliases.js';
import { list as listAccounts } from '../accounts.js';
import { ExitError } from '../errors.js';

/** Locate the real `claude` binary path (not our wrapper). */
export function findClaude(selfUrl: string): string {
  const saved = getSavedClaudeBin();
  if (saved) return saved;
  const selfPath = fileURLToPath(selfUrl);
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
export async function promptSecret(question: string): Promise<string> {
  const readline = await import('node:readline');

  if (!process.stdin.isTTY) {
    // Non-interactive: read first line from pipe.
    const rl = readline.createInterface({ input: process.stdin });
    return new Promise((resolveFn) => {
      let resolved = false;
      const done = (value: string): void => {
        if (resolved) return;
        resolved = true;
        rl.close();
        resolveFn(value);
      };
      rl.once('line', (line) => done(line.trim()));
      // EOF with no line (empty/closed stdin) must not hang the process —
      // resolve empty so the caller hits its "no key on stdin" guard.
      rl.once('close', () => done(''));
    });
  }

  process.stderr.write(question);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Mute readline output so the key isn't echoed to the terminal.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string): void => {
    if (s.includes('\n') || s.includes('\r')) process.stderr.write('\n');
  };
  return new Promise((resolveFn) => {
    rl.question('', (answer: string) => {
      rl.close();
      resolveFn(answer.trim());
    });
  });
}

/** Resolve a target alias/fuzzy string to a single saved email, or throw.
 *  Used by apikey commands so they accept the same target syntax as switch. */
export function resolveTargetEmail(target: string, accountsDirPath: string): string {
  const resolved = resolveAlias(target, accountsDirPath);
  const accounts = listAccounts(accountsDirPath);
  const matches = accounts.filter((a) => a === resolved);
  if (matches.length === 1) return matches[0]!;
  // Fuzzy fallback for partial matches (mirrors switch behaviour).
  const fuzzy = accounts.filter((a) => a.toLowerCase().includes(resolved.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) {
    throw new ExitError(`Multiple matches for "${target}":\n${fuzzy.map((m) => `  ${m}`).join('\n')}\nBe more specific.`);
  }
  throw new ExitError(`No account matching "${target}". Run: claude switch list`);
}

/** Prompt for y/n on stderr and return true if the user typed y or Y. */
export async function askYN(question: string): Promise<boolean> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolveFn) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolveFn(answer.trim().toLowerCase() === 'y');
    });
  });
}
