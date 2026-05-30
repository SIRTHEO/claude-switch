// src/setup/versions/install-commands.ts
//
// Build the install command for each upgrade target, choosing the right
// channel based on the install method we sniffed in the detect-* modules.
//
// Pure function: returns argv-style tuples + a label. Doesn't spawn
// anything — the install runner in install.ts handles execution and
// stdout/stderr streaming.
//
// Channel matrix:
//
//   target=claude  source=brew    → ['brew', ['upgrade', '--cask', 'claude-code']]
//   target=claude  source=npm     → ['npm',  ['i', '-g', '@anthropic-ai/claude-code@latest']]
//   target=switch  source=npm     → ['npm',  ['i', '-g', '@sirtheo/claude-switch@latest']]
//   target=gui     (any)          → null (manual — caller prints releaseUrl)
//
// `manual` and `unknown` claude sources → null (manual instructions only).

import type { UpdateTarget, VersionSource } from '../../contract-versions.js';

export interface InstallCommand {
  /** Argv head (`npm`, `brew`). */
  cmd: string;
  /** Argv tail. */
  args: readonly string[];
  /** Human-readable line for `--check` / dry-run + error fallbacks. */
  label: string;
}

export function buildInstallCommand(
  target: UpdateTarget,
  source: VersionSource,
): InstallCommand | null {
  if (target === 'gui') return null; // manual download, no install channel
  if (target === 'claude') {
    // For ANY known Claude Code install, delegate to `claude update` —
    // Anthropic ships the self-updater specifically because every
    // install path (brew cask, npm global, standalone Mach-O, future
    // installers) needs different upgrade logic that they handle
    // internally. The detected `source` ('brew' | 'npm' | 'manual')
    // feeds the GUI label only, not the action; running e.g. `brew
    // upgrade --cask` directly would fail when the user installed via
    // some other path (real bug observed when the cask wasn't installed).
    if (source === 'brew' || source === 'npm' || source === 'manual') {
      return {
        cmd: 'claude',
        args: ['update'],
        label: 'claude update',
      };
    }
    return null; // 'unknown' — claude isn't installed at all
  }
  // target === 'switch'
  if (source === 'npm') {
    return {
      cmd: 'npm',
      args: ['i', '-g', '@sirtheo/claude-switch@latest'],
      label: 'npm i -g @sirtheo/claude-switch@latest',
    };
  }
  return null; // claude-switch has no brew formula in v1 (brief §9)
}
