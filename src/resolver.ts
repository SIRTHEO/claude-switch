// src/resolver.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface ResolveOptions {
  envBin: string;
  selfPath: string;
  pathEnv: string | undefined;
}

const KNOWN_PATHS: Record<string, string[]> = {
  darwin: ['/usr/local/bin/claude', path.join(os.homedir(), '.npm-global', 'bin', 'claude')],
  linux: ['/usr/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.local', 'bin', 'claude')],
};

function getKnownPaths(): string[] {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const progFiles = process.env.ProgramFiles || '';
    return [
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(progFiles, 'nodejs', 'claude.cmd'),
    ];
  }
  return KNOWN_PATHS[platform] || KNOWN_PATHS.linux;
}

function isClaudeSwitchWrapper(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    fs.readSync(fd, buf, 0, 512, 0);
    return buf.toString('utf-8').includes('claude-switch');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function candidateNames(): string[] {
  if (process.platform === 'win32') {
    return ['claude.cmd', 'claude.exe', 'claude'];
  }
  return ['claude'];
}

export function resolve({ envBin, selfPath, pathEnv }: ResolveOptions): string | null {
  // Tier 1: explicit env var (still validated — must be executable and not
  // another claude-switch wrapper, to prevent accidental infinite recursion).
  if (envBin) {
    try {
      fs.accessSync(envBin, fs.constants.X_OK);
      if (isClaudeSwitchWrapper(envBin)) return null;
      return envBin;
    } catch {
      return null;
    }
  }

  const separator = process.platform === 'win32' ? ';' : ':';
  const hasExplicitPath = pathEnv !== undefined;
  const dirs = pathEnv ? pathEnv.split(separator) : [];
  const names = candidateNames();

  // Tier 2: PATH scan
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);

      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }

      // Skip self
      try {
        if (fs.realpathSync(candidate) === selfPath) continue;
      } catch {
        continue;
      }

      // Skip other claude-switch wrappers
      if (isClaudeSwitchWrapper(candidate)) continue;

      return candidate;
    }
  }

  // Tier 3: known paths fallback (only when pathEnv was not explicitly provided)
  if (hasExplicitPath) return null;

  for (const knownPath of getKnownPaths()) {
    try {
      fs.accessSync(knownPath, fs.constants.X_OK);
    } catch {
      continue;
    }
    if (isClaudeSwitchWrapper(knownPath)) continue;
    try {
      if (fs.realpathSync(knownPath) === selfPath) continue;
    } catch {
      continue;
    }
    return knownPath;
  }

  return null;
}
