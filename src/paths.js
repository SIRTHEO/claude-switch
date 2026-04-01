// src/paths.js
import os from 'node:os';
import path from 'node:path';

export function claudeJsonPath() {
  return path.join(os.homedir(), '.claude.json');
}

export function accountsDir() {
  return path.join(os.homedir(), '.claude', 'accounts');
}
