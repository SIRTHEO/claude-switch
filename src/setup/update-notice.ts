// src/setup/update-notice.ts
// The user-facing half of update handling: which install command to suggest
// for the way this CLI was installed, how to render the update notice, and how
// to actually run the update. Split out of update-check.ts (which owns the
// registry fetch, cache, and version comparison) to keep each file under the
// size gate. update-check.ts re-exports these so existing importers are
// unaffected.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ProcessPort, nodeProcessAdapter } from '../platform/process.js';

export const PACKAGE_NAME = '@sirtheo/claude-switch';

export interface UpdateInfo {
  latestVersion: string;
  installCommand: string;
  /** True when the installed version is BELOW the published `minsafe` tag —
   *  i.e. it carries a known security/data-loss bug. Callers escalate the
   *  notice (loud, persistent, shown even on the passthrough hot path).
   *  Fail-open: any uncertainty (no tag, fetch failure, parse error) → false. */
  critical: boolean;
}

/**
 * Returns the command array to update the package, based on how it is
 * currently installed (detected from the binary path).
 */
export function detectInstallCommand(): string[] {
  // Resolve the path of the currently-running CLI entry point.
  let selfDir = '';
  try {
    selfDir = path.dirname(fileURLToPath(import.meta.url));
  } catch { /* import.meta unavailable in some test contexts */ }

  const binaryPath = selfDir || process.execPath;
  // Match against path segments, not raw substring — otherwise a user
  // whose home directory contains "volta" or whose project is in a
  // "pnpm-workspace" folder would be misclassified.
  const segments = binaryPath.split(path.sep);
  const hasSeg = (...names: string[]): boolean =>
    segments.some(s => names.includes(s));

  if (hasSeg('.volta', 'volta')) return ['volta', 'install', PACKAGE_NAME];
  if (hasSeg('pnpm', '.pnpm', 'pnpm-global')) return ['pnpm', 'add', '-g', PACKAGE_NAME];
  if (hasSeg('yarn', '.yarn')) return ['yarn', 'global', 'add', PACKAGE_NAME];
  // Default: npm (covers homebrew-managed node, nvm, system node, etc.)
  return ['npm', 'install', '-g', PACKAGE_NAME];
}

/**
 * Runs the detected install command with live stdio.
 * Returns true if the process exited successfully.
 */
export function performUpdate(deps?: { process?: ProcessPort }): boolean {
  const [cmd, ...args] = detectInstallCommand();
  if (!cmd) {
    console.error('Could not detect install command for self-update.');
    return false;
  }
  console.log(`Running: ${cmd} ${args.join(' ')}\n`);
  const result = (deps?.process ?? nodeProcessAdapter).spawnSync(cmd, args, { stdio: 'inherit' });
  return result.status === 0 && !result.error;
}

/**
 * Render the user-facing update notice, shared by the passthrough hot path and
 * the `claude switch` dispatcher so the two never drift. A `critical` update
 * (installed version below the minsafe tag) gets a loud, bold-red, can't-miss
 * banner; a routine update keeps the quiet one-liner. Colour is gated by the
 * caller (off when stderr isn't a TTY, or under --no-color / NO_COLOR), so
 * piped/scripted output stays clean.
 */
export function formatUpdateNotice(
  info: UpdateInfo,
  currentVersion: string,
  opts: { color: boolean },
): string {
  const paint = (code: string, s: string): string =>
    opts.color ? `\x1b[${code}m${s}\x1b[0m` : s;
  if (info.critical) {
    return (
      paint('1;31', // bold red
        `🔴 claude-switch SECURITY UPDATE — ${currentVersion} has a known ` +
        `security/data-loss bug, fixed in ${info.latestVersion}.`) + '\n' +
      `   Update now:  ${info.installCommand}\n`
    );
  }
  return (
    `↥ claude-switch ${currentVersion} → ${info.latestVersion} available\n` +
    `  Update: ${info.installCommand}\n`
  );
}
