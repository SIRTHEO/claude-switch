// src/active-sessions.ts
// Best-effort detector for "are there other claude sessions running right
// now on this machine?" — used to warn before a switch, because changing
// the active account does NOT affect already-running claude processes
// (they hold their tokens in memory). The user often expects per-
// terminal isolation; we surface that this isn't how it works so they
// aren't surprised by quota drift later.
//
// Detection is heuristic. We never block the switch on it. False positives
// are harmless ("warning shown but nothing was actually running"); false
// negatives are the only real risk and are mitigated by being permissive
// in what we count.
//
// Windows is unsupported (no portable `ps`). Returns 0 there.

import { execFileSync } from 'node:child_process';

export interface ActiveSessionsResult {
  /** Number of likely-active claude sessions that aren't this process. */
  count: number;
  /** Why we returned 0 (only set when 0 and we couldn't really check). */
  unsupportedReason?: 'windows' | 'ps-unavailable' | 'no-real-claude';
}

/**
 * Count Claude Code sessions currently running on this machine.
 *
 * `realClaudePath` is the path to the actual claude binary (from
 * findClaudeBinary). We use it to filter out our own wrapper invocations
 * and only count true claude REPL/spawn instances.
 *
 * `selfPid` is the current process pid, excluded from the count.
 */
export function countActiveClaudeSessions(
  realClaudePath: string | null,
  selfPid: number = process.pid,
): ActiveSessionsResult {
  if (!realClaudePath) {
    return { count: 0, unsupportedReason: 'no-real-claude' };
  }
  if (process.platform === 'win32') {
    return { count: 0, unsupportedReason: 'windows' };
  }

  let raw: string;
  try {
    // ps -ax: every process the user can see, no controlling-terminal filter.
    // -o pid=,command=  : just pid + command line, no header.
    // Works on macOS BSD ps and GNU/Linux procps ps with the same flags.
    raw = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
  } catch {
    return { count: 0, unsupportedReason: 'ps-unavailable' };
  }

  // Build a regex that matches `<realClaudePath>` only when followed by
  // whitespace or end-of-line. Avoids false-positives like
  // `/usr/local/bin/claude-switch ...` (substring match) when realClaudePath
  // is `/usr/local/bin/claude`.
  const escaped = realClaudePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const realClaudeRegex = new RegExp(`(^|\\s)${escaped}(\\s|$)`);

  let count = 0;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const pid = parseInt(m[1], 10);
    const cmd = m[2];
    if (!Number.isFinite(pid) || pid === selfPid) continue;

    if (!realClaudeRegex.test(cmd)) continue;

    // Skip claude-switch sub-commands (`claude switch status`, etc.) —
    // those don't open a long-lived REPL and don't hold tokens in memory.
    if (/\bclaude\s+switch\b/.test(cmd)) continue;

    count++;
  }
  return { count };
}

/**
 * One-line, terminal-friendly warning string for use right before a switch.
 * Returns null when there's nothing to warn about (count === 0).
 *
 * Kept separate from the detector so the menu can render it as `p.note`
 * while the CLI prints it on stderr.
 */
export function buildActiveSessionsWarning(count: number): string | null {
  if (count <= 0) return null;
  const noun = count === 1 ? 'another claude session is' : `${count} other claude sessions are`;
  return (
    `⚠ ${noun} running. The switch only affects new "claude" launches — ` +
    `already-running sessions keep using their cached tokens until you exit and restart them.`
  );
}
