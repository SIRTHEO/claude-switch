import fs from 'node:fs';
import path from 'node:path';

function aliasesPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, 'aliases.json');
}

function readAliases(accountsDirPath: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(aliasesPath(accountsDirPath), 'utf-8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    // Use null-prototype object to prevent prototype pollution
    const result: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k && typeof v === 'string' && v) result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

function writeAliases(accountsDirPath: string, aliases: Record<string, string>): void {
  const filePath = aliasesPath(accountsDirPath);
  fs.mkdirSync(accountsDirPath, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(aliases, null, 2));
  if (process.platform !== 'win32') {
    fs.chmodSync(tmp, 0o600);
  }
  fs.renameSync(tmp, filePath);
}

export function getAlias(name: string, accountsDirPath: string): string | null {
  const aliases = readAliases(accountsDirPath);
  return aliases[name] ?? null;
}

export function setAlias(name: string, email: string, accountsDirPath: string): void {
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
