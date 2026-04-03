import fs from 'node:fs';
import path from 'node:path';

const UNSAFE_FILENAME_CHARS = /[/\\:*?"<>|]/;

function resolvedAccountFile(email: string, accountsDirPath: string): string {
  const base = path.resolve(accountsDirPath);
  const resolved = path.resolve(accountsDirPath, `${email}.json`);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Email resolves outside accounts directory: ${email}`);
  }
  return resolved;
}

export function getCurrent(claudeJsonPath: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    return data?.oauthAccount?.emailAddress || '';
  } catch {
    return '';
  }
}

export function save(email: string, claudeJsonPath: string, accountsDirPath: string): void {
  if (!email || UNSAFE_FILENAME_CHARS.test(email)) {
    throw new Error(`Email contains characters unsafe for filenames: ${email}`);
  }

  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });

  let data;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${claudeJsonPath} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }

  const accountFile = resolvedAccountFile(email, accountsDirPath);
  const tmp = accountFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data.oauthAccount || {}, null, 2));
  if (process.platform !== 'win32') {
    fs.chmodSync(tmp, 0o600);
  }
  fs.renameSync(tmp, accountFile);
}

export function list(accountsDirPath: string): string[] {
  try {
    const files = fs.readdirSync(accountsDirPath);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export function remove(email: string, accountsDirPath: string): void {
  const accountFile = resolvedAccountFile(email, accountsDirPath);
  try {
    fs.unlinkSync(accountFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No saved account for ${email}`);
    }
    throw e;
  }
}

export function load(email: string, claudeJsonPath: string, accountsDirPath: string): void {
  const accountFile = resolvedAccountFile(email, accountsDirPath);

  // Reject symlinks to prevent symlink-based file read attacks
  const fileStat = fs.lstatSync(accountFile, { throwIfNoEntry: false });
  if (!fileStat) {
    throw new Error(`No saved account for ${email}`);
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`Account file for ${email} is a symbolic link and cannot be trusted`);
  }

  let accountData;
  try {
    accountData = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${accountFile} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${claudeJsonPath} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }
  data.oauthAccount = accountData;

  const tmp = claudeJsonPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, claudeJsonPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(claudeJsonPath, 0o600);
  }
}
