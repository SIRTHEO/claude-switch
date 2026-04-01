// src/paths.ts
import os from 'node:os';
import path from 'node:path';

export function claudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

export function accountsDir(): string {
  return path.join(os.homedir(), '.claude', 'accounts');
}
