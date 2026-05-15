// src/commands/cache-health.ts
// `claude switch cache-health [--session <path>] [--json]`
// Phase 15.5 — CLI surface for billing-bug diagnostics via cache-health analysis.
//
// Two modes:
//   Default: resolve the active session for process.cwd() via loadActiveSessionHealth.
//   --session <path>: parse a specific JSONL file directly (bypasses lookup + TTL cache).
//
// Output:
//   Default: human-readable summary (turns, hit ratio %, flushCount, effectiveInputTokens, flush list).
//   --json:  structured JSON with summary + sessionPath + flushes array.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExitError } from '../errors.js';
import {
  loadActiveSessionHealth,
  readSessionJsonl,
  summariseCacheHealth,
  extractFlushTurns,
  findActiveSessionJsonl,
} from '../cache-health.js';
import type { CacheHealthSummary, FlushEvent } from '../cache-health.js';

export interface CacheHealthOptions {
  /** Absolute path to a specific JSONL file to parse (bypasses active-session lookup). */
  sessionPath?: string;
  /** When true, output JSON instead of human-readable text. */
  json: boolean;
}

// ---------------------------------------------------------------------------
// Human-readable formatters (internal helpers)
// ---------------------------------------------------------------------------

/** Format a token count as a human-readable K/M string. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Format a Date as a short human-readable string. */
function fmtDate(d: Date): string {
  return d.toLocaleString();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle `claude switch cache-health [--session <path>] [--json]`.
 *
 * @throws {ExitError} with code 1 when no session is available and `--session` is not provided.
 */
export function handleCacheHealth(opts: CacheHealthOptions): void {
  let summary: CacheHealthSummary;
  let resolvedPath: string;
  let flushes: FlushEvent[];

  if (opts.sessionPath !== undefined) {
    // --session <path>: bypass lookup, parse directly.
    const path = opts.sessionPath;
    if (!fs.existsSync(path)) {
      throw new ExitError(`No JSONL file found at: ${path}`);
    }
    const entries = readSessionJsonl(path);
    summary = summariseCacheHealth(entries);
    flushes = extractFlushTurns(path);
    resolvedPath = path;
  } else {
    // Default: resolve active session for process.cwd().
    // We need the raw path for extractFlushTurns; resolve it separately.
    // os.homedir() never returns "~" — it expands the real home or returns
    // empty string. Using a literal "~" fallback would silently look up a dir
    // named "~" in cwd, which never exists. Match the resolution used by
    // loadActiveSessionHealth() in src/cache-health.ts to avoid divergence.
    const jsonlPath = findActiveSessionJsonl(
      process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects'),
      process.cwd(),
    );
    if (jsonlPath === null) {
      throw new ExitError(
        'No active Claude Code session found for the current directory.\n' +
        'Make sure you have run Claude Code in this project, or use --session <path> to specify a JSONL file.',
      );
    }
    // Use loadActiveSessionHealth for summary (benefits from TTL cache).
    const maybeHealth = loadActiveSessionHealth();
    if (maybeHealth === null) {
      // Path resolved but reading failed somehow (edge case).
      throw new ExitError(
        'Found session file but could not read health data. ' +
        `Try: claude switch cache-health --session "${jsonlPath}"`,
      );
    }
    summary = maybeHealth;
    resolvedPath = jsonlPath;
    flushes = extractFlushTurns(jsonlPath);
  }

  if (opts.json) {
    outputJson(summary, resolvedPath, flushes);
  } else {
    outputText(summary, resolvedPath, flushes);
  }
}

// ---------------------------------------------------------------------------
// Output renderers
// ---------------------------------------------------------------------------

function outputJson(
  summary: CacheHealthSummary,
  sessionPath: string,
  flushes: FlushEvent[],
): void {
  const out = {
    summary,
    sessionPath,
    flushes,
  };
  console.log(JSON.stringify(out, null, 2));
}

function outputText(
  summary: CacheHealthSummary,
  sessionPath: string,
  flushes: FlushEvent[],
): void {
  const hitPct = (summary.hitRatio * 100).toFixed(1);
  console.log(`Cache health — ${sessionPath}`);
  console.log(`  Turns:             ${summary.turns}`);
  console.log(`  Hit ratio:         ${hitPct}%`);
  console.log(`  Flush count:       ${summary.flushCount}`);
  console.log(`  Effective tokens:  ${fmtTokens(summary.effectiveInputTokens)}`);

  // Last flush timestamp.
  if (flushes.length > 0) {
    const lastFlush = flushes[flushes.length - 1];
    if (lastFlush !== undefined && lastFlush.timestamp !== null) {
      const d = new Date(lastFlush.timestamp);
      if (!Number.isNaN(d.getTime())) {
        console.log(`  Last flush:        ${fmtDate(d)}`);
      }
    }
  }

  // Flush event list.
  if (flushes.length === 0) {
    console.log('  No cache flushes detected.');
  } else if (flushes.length < 20) {
    console.log(`  Flush events (${flushes.length}):`);
    for (const ev of flushes) {
      const ts = ev.timestamp !== null ? `  [${ev.timestamp}]` : '';
      console.log(`    turn ${ev.turn}, line ${ev.line}${ts}`);
    }
  } else {
    const first = flushes[0];
    const last = flushes[flushes.length - 1];
    const firstLine = first !== undefined ? first.line : '?';
    const lastLine = last !== undefined ? last.line : '?';
    console.log(`  ${flushes.length} flushes total, first at line ${firstLine}, last at line ${lastLine}`);
  }
}
