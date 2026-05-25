// src/cache-health.ts
// JSONL parser and cache health summary for Claude Code sessions.
// findActiveSessionJsonl helper for active Claude Code session lookup.
//
// Exposes billing-bug visibility for two known Anthropic issues:
//   (1) cache flush (~10-20× cost amplification)
//   (2) --resume cache invalidation
//
// Claude Code session JSONL format (real shape, verified from ~/.claude/projects/):
//   { "type": "assistant", "message": { "role": "assistant", "usage": { ... } }, ... }
//   usage fields: cache_read_input_tokens, cache_creation_input_tokens, input_tokens

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface AssistantTurn {
  cache_read: number;
  cache_creation: number;
  input_tokens: number;
}

/** Describes a single cache-flush event detected in the JSONL stream. */
export interface FlushEvent {
  /** 0-based turn index within the assistant entries. */
  turn: number;
  /** 1-based line number in the original JSONL file (empty lines included in count). */
  line: number;
  /** ISO timestamp string from the JSONL entry, or null if absent. */
  timestamp: string | null;
}

export interface CacheHealthSummary {
  turns: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalInput: number;
  /** Fraction of total tokens that were cache hits. Bounded [0, 1]. */
  hitRatio: number;
  /** Number of turns detected as cache flushes (turn_index > 0, cache_creation > 5000, cache_read < 1000). */
  flushCount: number;
  /**
   * Effective cost in "input token equivalent" units:
   *   cache_read × 0.1 + cache_creation × 1.25 + input × 1.0
   */
  effectiveInputTokens: number;
  /** Turn index (0-based) of the last detected flush, or null if none. */
  lastFlushAt: number | null;
}

// ---------------------------------------------------------------------------
// Internal type guard helpers
// ---------------------------------------------------------------------------

/** Structural probe on an unknown object — safe cast with comment per repo convention. */
function isObjectNonNull(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Type guard for the nested `usage` object inside a Claude Code JSONL entry.
 * The field `usage` must be a non-null object; token counts are optional
 * (absent fields fall back to 0 in extraction).
 */
function isUsageObject(v: unknown): v is Record<string, unknown> {
  return isObjectNonNull(v);
}

/** Shape returned after extracting the assistant entry — always has usage. */
interface AssistantEntryNormalised {
  usage: Record<string, unknown>;
}

/**
 * Type guard / extractor for assistant JSONL entries (DoD #3: `isAssistantEntry` equivalent).
 *
 * Returns a normalised `{ usage }` object when the entry is a valid assistant
 * turn, or null otherwise. A classic `v is X` predicate could not be used here
 * because the union type produced by the nested-vs-flat duality prevents TS from
 * narrowing `usage` after the guard (TS7053 — hence this extract-and-return pattern).
 *
 * Accepts both forms observed in production:
 *   (a) Nested: { type:"assistant", message:{ role:"assistant", usage:{...} } }
 *   (b) Flat (defensive fallback): { role:"assistant", usage:{...} }
 *
 * Returns null when:
 * - the entry is not an object
 * - `role` is not "assistant"
 * - `usage` is absent or not an object (DoD: missing usage → skip)
 */
function extractAssistantEntry(v: unknown): AssistantEntryNormalised | null {
  if (!isObjectNonNull(v)) return null;
  // Form (a): nested under message — the canonical Claude Code format.
  const maybeMsg = v['message']; // safe: structural probe on narrowed Record
  if (isObjectNonNull(maybeMsg)) {
    if (maybeMsg['role'] !== 'assistant') return null; // safe: structural probe
    const usage = maybeMsg['usage']; // safe: structural probe
    if (!isUsageObject(usage)) return null;
    return { usage };
  }
  // Form (b): flat layout (defensive; not observed in real sessions as of 2026-05).
  if (v['role'] !== 'assistant') return null; // safe: structural probe
  const usage = v['usage']; // safe: structural probe
  if (!isUsageObject(usage)) return null;
  return { usage };
}

/** Extract a non-negative integer from an unknown value, defaulting to 0. */
function extractTokenCount(v: unknown): number {
  if (typeof v !== 'number') return 0;
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a Claude Code session JSONL file and return one `AssistantTurn` per
 * assistant message that has a valid `usage` object.
 *
 * Parsing rules:
 * - Lines are read via `fs.readFileSync` + split on `\n`, empty lines filtered.
 * - Malformed JSON lines are skipped silently (no throw).
 * - Only entries with `role === 'assistant'` and a present usage object are included.
 * - Missing token count fields fall back to 0.
 */
export function readSessionJsonl(filePath: string): AssistantTurn[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  const turns: AssistantTurn[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip malformed lines.
      continue;
    }

    const entry = extractAssistantEntry(parsed);
    if (entry === null) continue;

    const { usage } = entry;

    turns.push({
      cache_read: extractTokenCount(usage['cache_read_input_tokens']),
      cache_creation: extractTokenCount(usage['cache_creation_input_tokens']),
      input_tokens: extractTokenCount(usage['input_tokens']),
    });
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Flush detection thresholds (shared by summariseCacheHealth + extractFlushTurns)
// ---------------------------------------------------------------------------

/** Minimum cache_creation value (exclusive) to consider a turn a cache flush. */
const FLUSH_CREATION_THRESHOLD = 5000;
/** Maximum cache_read value (exclusive) that can coexist with a flush. */
const FLUSH_READ_THRESHOLD = 1000;

/**
 * Compute cache health metrics from a list of `AssistantTurn` entries.
 *
 * Flush detection heuristic (turn_index > 0 required — initial creation is expected):
 *   `cache_creation > FLUSH_CREATION_THRESHOLD && cache_read < FLUSH_READ_THRESHOLD`
 *
 * Pricing constants for `effectiveInputTokens`:
 *   `cache_read × 0.1 + cache_creation × 1.25 + input × 1.0`
 */
export function summariseCacheHealth(
  entries: AssistantTurn[],
  // opts reserved for future extension (threshold overrides, etc.)
  _opts: Record<string, never> = {},
): CacheHealthSummary {
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalInput = 0;
  let effectiveInputTokens = 0;
  let flushCount = 0;
  let lastFlushAt: number | null = null;

  for (let i = 0; i < entries.length; i++) {
    const turn = entries[i]; // entries is AssistantTurn[] so index is safe; noUncheckedIndexedAccess satisfied via explicit check
    if (turn === undefined) continue;

    totalCacheRead += turn.cache_read;
    totalCacheCreation += turn.cache_creation;
    totalInput += turn.input_tokens;

    // Pricing: cache_read × 0.1, cache_creation × 1.25, input × 1.0
    effectiveInputTokens +=
      turn.cache_read * 0.1 +
      turn.cache_creation * 1.25 +
      turn.input_tokens * 1.0;

    // Flush detection: skip turn 0 (initial cache creation is normal).
    if (i > 0 && turn.cache_creation > FLUSH_CREATION_THRESHOLD && turn.cache_read < FLUSH_READ_THRESHOLD) {
      flushCount++;
      lastFlushAt = i;
    }
  }

  const denominator = totalCacheRead + totalCacheCreation + totalInput;
  const hitRatio = denominator === 0 ? 0 : Math.min(1, totalCacheRead / denominator);

  return {
    turns: entries.length,
    totalCacheRead,
    totalCacheCreation,
    totalInput,
    hitRatio,
    flushCount,
    effectiveInputTokens,
    lastFlushAt,
  };
}

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
  } catch {
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
    } catch {
      continue;
    }
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestPath = fullPath;
    }
  }

  return bestPath;
}

// ---------------------------------------------------------------------------
// extractFlushTurns — line-accurate flush event extraction
// ---------------------------------------------------------------------------

/**
 * Re-parse a Claude Code session JSONL file and return one {@link FlushEvent}
 * per detected cache flush, preserving the **1-based line number** from the
 * original file and the entry's `timestamp` field when present.
 *
 * Flush detection heuristic (identical to {@link summariseCacheHealth}):
 *   `turn_index > 0 && cache_creation > FLUSH_CREATION_THRESHOLD && cache_read < FLUSH_READ_THRESHOLD`
 *
 * Line numbers are 1-based and count all lines (including empty and malformed),
 * so they can be used to locate the entry in the raw file.
 *
 * Non-assistant entries and malformed JSON lines are skipped (same semantics as
 * {@link readSessionJsonl}), but they still increment the line counter.
 */
export function extractFlushTurns(filePath: string): FlushEvent[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const allLines = raw.split('\n');
  const events: FlushEvent[] = [];

  let turnIndex = 0; // counts only assistant turns (matches summariseCacheHealth's `i`)

  for (let lineIdx = 0; lineIdx < allLines.length; lineIdx++) {
    const line = allLines[lineIdx];
    if (!line || line.trim() === '') continue; // empty / whitespace — skip, no turn increment

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed line — skip, no turn increment
      continue;
    }

    const entry = extractAssistantEntry(parsed);
    if (entry === null) continue; // not an assistant turn — skip

    const { usage } = entry;
    const cacheCreation = extractTokenCount(usage['cache_creation_input_tokens']);
    const cacheRead = extractTokenCount(usage['cache_read_input_tokens']);

    if (turnIndex > 0 && cacheCreation > FLUSH_CREATION_THRESHOLD && cacheRead < FLUSH_READ_THRESHOLD) {
      // Extract timestamp from the raw entry if present
      let timestamp: string | null = null;
      if (typeof parsed === 'object' && parsed !== null) {
        const raw_ts = (parsed as Record<string, unknown>)['timestamp'];
        if (typeof raw_ts === 'string') timestamp = raw_ts;
      }

      events.push({
        turn: turnIndex,
        line: lineIdx + 1, // 1-based
        timestamp,
      });
    }

    turnIndex++;
  }

  return events;
}
