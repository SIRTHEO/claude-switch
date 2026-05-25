// src/cache-health.ts
// Active Claude Code session lookup + the high-level cache-health glue with a
// 1s in-process TTL cache.
//
// Exposes billing-bug visibility for two known Anthropic issues:
//   (1) cache flush (~10-20× cost amplification)
//   (2) --resume cache invalidation
//
// JSONL parsing + summarisation live in cache-health-core.ts; line-accurate
// flush events in cache-health-flush.ts. Both are re-exported here so importers
// keep using `./cache-health.js`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type CacheHealthSummary,
  readSessionJsonl,
  summariseCacheHealth,
} from './cache-health-core.js';

export { readSessionJsonl, summariseCacheHealth } from './cache-health-core.js';
export type { CacheHealthSummary } from './cache-health-core.js';
export { extractFlushTurns } from './cache-health-flush.js';
export type { FlushEvent } from './cache-health-flush.js';

// ---------------------------------------------------------------------------
// loadActiveSessionHealth — glue + 1s in-process cache
// ---------------------------------------------------------------------------

/**
 * Options for {@link loadActiveSessionHealth}.
 */
interface LoadHealthOptions {
  /** Absolute path to `~/.claude/projects` (or equivalent). Default: `~/.claude/projects`. */
  claudeProjectsDir?: string;
  /** Working directory of the target project. Default: `process.cwd()`. */
  projectCwd?: string;
  /** Clock source. Defaults to `Date.now`. Injectable for TTL testing without real timers. */
  now?: () => number;
}

/** In-process single-slot cache for {@link loadActiveSessionHealth}. */
interface HealthCache {
  path: string;
  result: CacheHealthSummary | null;
  expiresAt: number;
}

/** TTL for the in-process cache, in milliseconds. */
const CACHE_TTL_MS = 1000;

/** Module-level single-slot cache. Keyed by resolved JSONL path. */
let _healthCache: HealthCache | null = null;

/**
 * High-level glue that wires together:
 *   1. `findActiveSessionJsonl` (path resolution)
 *   2. `readSessionJsonl` + `summariseCacheHealth` (read + compute)
 *   3. A 1-second in-process TTL cache (keyed by resolved JSONL path)
 *
 * Cache key is the resolved path of the JSONL file, so switching between two
 * different session files in the same process correctly busts the cache.
 * (Single-slot design: A→B→A re-reads on every switch; acceptable given TTL=1s.)
 *
 * @returns `CacheHealthSummary` on success, or `null` when no active session is found.
 */
export function loadActiveSessionHealth(opts?: LoadHealthOptions): CacheHealthSummary | null {
  const claudeProjectsDir =
    opts?.claudeProjectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  const projectCwd = opts?.projectCwd ?? process.cwd();
  const now = opts?.now ?? Date.now;

  // Step 1: resolve JSONL path
  const jsonlPath = findActiveSessionJsonl(claudeProjectsDir, projectCwd);
  if (jsonlPath === null) return null;

  // Step 2: check cache hit (same path, within TTL)
  if (_healthCache !== null && _healthCache.path === jsonlPath && now() < _healthCache.expiresAt) {
    return _healthCache.result;
  }

  // Step 3: cache miss — read file and compute
  const entries = readSessionJsonl(jsonlPath);
  const result = summariseCacheHealth(entries);

  // Step 4: populate cache
  _healthCache = { path: jsonlPath, result, expiresAt: now() + CACHE_TTL_MS };

  return result;
}

// ---------------------------------------------------------------------------
// findActiveSessionJsonl
// ---------------------------------------------------------------------------

/**
 * Encode a filesystem path to the directory name used by Claude Code under
 * `~/.claude/projects/`.
 *
 * Schema (verified empirically from `~/.claude/projects/` on macOS, 2026-05):
 *   Every character that is NOT an ASCII alphanumeric or a hyphen is replaced
 *   with a hyphen (`-`). In practice this means:
 *     - `/` → `-`   (path separators become hyphens)
 *     - `.` → `-`   (dot in dir/file names becomes hyphen)
 *     - any other non-alphanum-non-hyphen (spaces, braces, quotes, …) → `-`
 *   The leading `/` therefore produces the leading `-` that all entries share.
 *
 * Known limitation — collisions for non-alphanum-non-hyphen chars:
 *   The aggressive `[^a-zA-Z0-9-]` collapse means paths that differ only by
 *   `.` vs `_` vs `-` vs ` ` vs `/` map to the same encoded directory. For
 *   example `my-project`, `my_project`, `my.project` all encode identically.
 *   In that case `findActiveSessionJsonl` returns the latest JSONL across all
 *   colliding projects — the cache-health badge could show data from a
 *   sibling project rather than the current cwd. This was deemed acceptable
 *   because (a) the encoding matches Claude Code's own observed behavior on
 *   real `~/.claude/projects/` dirs and (b) the cache-health surfaces are
 *   diagnostic, not part of the auth/billing critical path. If Claude Code
 *   ever changes its encoding (preserving `_` for example), update both this
 *   regex and the verifying tests in `test/cache-health.test.ts`.
 *
 * @example
 * encodeProjectPath('/foo/bar')      // '-foo-bar'
 * encodeProjectPath('/Users/me/.x') // '-Users-me--x'
 */
export function encodeProjectPath(projectCwd: string): string {
  return projectCwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Find the most-recently-modified `*.jsonl` file inside the Claude Code
 * project directory that corresponds to `projectCwd`.
 *
 * Claude Code stores session JSONL files at:
 *   `<claudeProjectsDir>/<encoded-cwd>/<uuid>.jsonl`
 *
 * Steps:
 * 1. Encode `projectCwd` via {@link encodeProjectPath}.
 * 2. Build the candidate directory path.
 * 3. Return `null` if the directory does not exist.
 * 4. List all `*.jsonl` files; return `null` if there are none.
 * 5. Return the path of the file with the highest `mtime`.
 *
 * @param claudeProjectsDir - Absolute path to `~/.claude/projects` (or equivalent).
 * @param projectCwd        - Absolute path to the project working directory
 *                            (typically `process.cwd()`).
 * @returns Absolute path to the newest JSONL file, or `null`.
 */
export function findActiveSessionJsonl(
  claudeProjectsDir: string,
  projectCwd: string,
): string | null {
  const encoded = encodeProjectPath(projectCwd);
  const projectDir = path.join(claudeProjectsDir, encoded);

  // (3) Directory does not exist → null
  if (!fs.existsSync(projectDir)) return null;

  // (4) List *.jsonl files
  let entries: string[];
  try {
    entries = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
  } catch { // project dir absent → no transcripts to assess
    return null;
  }

  if (entries.length === 0) return null;

  // (5) Return the newest by mtime
  let bestPath: string | null = null;
  let bestMtime = -Infinity;

  for (const entry of entries) {
    const fullPath = path.join(projectDir, entry);
    let mtime: number;
    try {
      mtime = fs.statSync(fullPath).mtimeMs;
    } catch { // entry vanished between list and stat → skip
      continue;
    }
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestPath = fullPath;
    }
  }

  return bestPath;
}
