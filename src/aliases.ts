import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';

// Names reserved for sub-commands of `claude switch`. An alias with one of
// these names would be unreachable, since the dispatch in bin/cli.ts matches
// the sub-command branch before falling through to alias resolution.
const RESERVED_ALIAS_NAMES = new Set([
  'add', 'list', 'ls', 'remove', 'rm', 'status', 'help',
  'setup', 'update', 'apikey', 'alias', 'fallback',
  '--help', '-h', '--version', '-v', '--completions',
]);

function aliasesPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, 'aliases.json');
}

function readAliases(accountsDirPath: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(aliasesPath(accountsDirPath), 'utf-8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    // Use null-prototype object to prevent prototype pollution.
    // Object.create(null) returns `any`; the explicit type annotation suffices — no cast needed.
    // Object.entries accepts any object; raw is narrowed to object above.
    const result: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(raw)) {
      if (k && typeof v === 'string' && v) result[k] = v;
    }
    return result;
  } catch { // missing/corrupt aliases file → no aliases
    return {};
  }
}

function writeAliases(accountsDirPath: string, aliases: Record<string, string>): void {
  fs.mkdirSync(accountsDirPath, { recursive: true });
  writeJsonAtomic(aliasesPath(accountsDirPath), aliases);
}

export function getAlias(name: string, accountsDirPath: string): string | null {
  const aliases = readAliases(accountsDirPath);
  return aliases[name] ?? null;
}

export function setAlias(name: string, email: string, accountsDirPath: string): void {
  if (!name) {
    throw new Error('Alias name cannot be empty');
  }
  if (RESERVED_ALIAS_NAMES.has(name)) {
    throw new Error(
      `"${name}" is reserved for the "claude switch ${name}" sub-command and cannot be used as an alias.`
    );
  }
  const aliases = readAliases(accountsDirPath);
  aliases[name] = email;
  writeAliases(accountsDirPath, aliases);
}

export function listAliases(accountsDirPath: string): Record<string, string> {
  return readAliases(accountsDirPath);
}

export function removeAlias(name: string, accountsDirPath: string): void {
  const aliases = readAliases(accountsDirPath);
  if (!(name in aliases)) {
    throw new Error(`No alias "${name}"`);
  }
  delete aliases[name];
  writeAliases(accountsDirPath, aliases);
}

export function resolveAlias(input: string, accountsDirPath: string): string {
  return getAlias(input, accountsDirPath) ?? input;
}

export function getAliasesForEmail(email: string, accountsDirPath: string): string[] {
  const aliases = readAliases(accountsDirPath);
  return Object.entries(aliases)
    .filter(([, e]) => e === email)
    .map(([name]) => name);
}
