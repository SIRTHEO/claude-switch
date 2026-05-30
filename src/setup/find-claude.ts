// src/find-claude.ts
// Resolves the path to the real Anthropic claude binary that we're wrapping.
//
// Used both by the CLI dispatch and by the interactive menu, so it lives in
// its own file to avoid the menu having to import from bin/cli.ts (which
// would be a circular import — the CLI entry imports the menu).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from '../routing/resolver.js';
import { getSavedClaudeBin } from './setup.js';

/**
 * The realpath of the wrapper entry node executed for this process — i.e. the
 * thing a spawned bin would re-run if it pointed back at us. This is the only
 * reliable "self" for loop detection: every spawn path runs inside the process
 * whose main module is `bin/cli.js` (cli.ts only calls `main()` when
 * `realpathSync(argv[1]) === realpathSync(cli.js)`), so `realpathSync(argv[1])`
 * is always the wrapper entry — regardless of which sub-module asks. Callers
 * historically passed their own `import.meta.url`, which for a sub-module
 * (`run-app.js`, `profiles.js`) is NOT the wrapper entry, so the self-guard
 * silently never fired from those paths.
 *
 * Falls back to the caller's module url only when argv[1] is unusable (e.g. the
 * module is imported under a test runner) — the launch hot path must never
 * crash on self-computation; degrade to the previous behaviour instead.
 */
export function wrapperSelfPath(fallbackMetaUrl: string): string {
  const invoked = process.argv[1];
  if (invoked) {
    try {
      return fs.realpathSync(invoked);
    } catch {
      // argv[1] unresolvable (rare) → fall back to the caller's module url.
    }
  }
  return fileURLToPath(fallbackMetaUrl);
}

export function findClaudeBinary(metaUrl: string): string | null {
  const selfPath = wrapperSelfPath(metaUrl);
  const saved = getSavedClaudeBin(undefined, selfPath);
  if (saved) return saved;
  return resolve({
    envBin: process.env.CLAUDE_SWITCH_BIN || '',
    selfPath,
    pathEnv: process.env.PATH || '',
  });
}
