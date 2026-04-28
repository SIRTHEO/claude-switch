// src/find-claude.ts
// Resolves the path to the real Anthropic claude binary that we're wrapping.
//
// Used both by the CLI dispatch and by the interactive menu, so it lives in
// its own file to avoid the menu having to import from bin/cli.ts (which
// would be a circular import — the CLI entry imports the menu).

import { fileURLToPath } from 'node:url';
import { resolve } from './resolver.js';
import { getSavedClaudeBin } from './setup.js';

export function findClaudeBinary(metaUrl: string): string | null {
  const saved = getSavedClaudeBin();
  if (saved) return saved;
  const selfPath = fileURLToPath(metaUrl);
  return resolve({
    envBin: process.env.CLAUDE_SWITCH_BIN || '',
    selfPath,
    pathEnv: process.env.PATH || '',
  });
}
