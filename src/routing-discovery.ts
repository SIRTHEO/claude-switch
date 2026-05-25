// src/routing-discovery.ts
// Walk up from cwd to find the nearest `.claude-switch` file, bounded by the
// first `.git/` boundary, $HOME, or fs root.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_SWITCH_FILENAME = '.claude-switch';

/** Walk up from `cwd` until either a `.claude-switch` is found, a `.git/`
 *  boundary stops us, or we reach `os.homedir()` / fs root. Returns the
 *  absolute path of the first `.claude-switch` we hit (closest to cwd) or
 *  null. */
export function findClaudeSwitchFile(
  cwd: string,
  home: string = os.homedir(),
): string | null {
  let dir = path.resolve(cwd);
  const homeAbs = path.resolve(home);
  // Bound the walk by depth as a sanity guard (deeply nested paths).
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, CLAUDE_SWITCH_FILENAME);
    try {
      const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (stat?.isFile()) return candidate;
    } catch { /* unreadable — continue */ }

    // Stop walking at the first `.git` boundary (the repo root).
    try {
      const gitStat = fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false });
      if (gitStat && (gitStat.isDirectory() || gitStat.isFile())) {
        // We're at the repo root — last chance for the file at this level
        // already checked above. Stop walking past the boundary.
        return null;
      }
    } catch { /* no .git here — continue up */ }

    if (dir === homeAbs) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached fs root
    dir = parent;
  }
  return null;
}
