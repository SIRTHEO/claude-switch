// src/setup/versions/install-commands.ts
//
// Build the install command for each upgrade target, choosing the right
// channel based on the install method we sniffed in the detect-* modules.
//
// Pure function: returns argv-style tuples + a label. Doesn't spawn
// anything — the install runner in install.ts handles execution and
// stdout/stderr streaming.
//
// Channel matrix (mirrors the SH-UPD shape brief §3):
//
//   target=claude  source=brew    → ['brew', ['upgrade', '--cask', 'claude-code']]
//   target=claude  source=npm     → ['npm',  ['i', '-g', '@anthropic-ai/claude-code@latest']]
//   target=switch  source=npm     → ['npm',  ['i', '-g', '@sirtheo/claude-switch@latest']]
//   target=gui     (any)          → null (manual — caller prints releaseUrl)
//
// `manual` and `unknown` claude sources → null (manual instructions only).

import type { VersionSource } from '../../contract.js';

export type UpdateTarget = 'claude' | 'switch' | 'gui';

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
    if (source === 'brew') {
      return {
        cmd: 'brew',
        args: ['upgrade', '--cask', 'claude-code'],
        label: 'brew upgrade --cask claude-code',
      };
    }
    if (source === 'npm') {
      return {
        cmd: 'npm',
        args: ['i', '-g', '@anthropic-ai/claude-code@latest'],
        label: 'npm i -g @anthropic-ai/claude-code@latest',
      };
    }
    return null; // manual / unknown — no automated path for `claude` here
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
