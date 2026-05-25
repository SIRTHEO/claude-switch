// src/ui/screens/setup-wizard-types.ts
// Types, injectable deps, the step state-machine, and option tables for the
// setup wizard. Shared between the container (setup-wizard.tsx) and the
// presentational view (setup-wizard-view.tsx).

import {
  detectShellConfigs,
  findRealClaude,
  getNpmBinDir,
  patchShellConfig,
  saveClaudeBin,
} from '../../setup.js';
import { detectExistingStatusLine, installStatusLine } from '../../statusline-install.js';

/** Injectable dependencies — used for testing. All optional; default to real implementations. */
export interface SetupDeps {
  findRealClaude: (selfPath: string) => string | null;
  saveClaudeBin: (path: string) => void;
  getNpmBinDir: () => string | null;
  detectShellConfigs: () => string[];
  patchShellConfig: (cfg: string, npmBin: string) => boolean;
  detectExistingStatusLine: () => DetectedExisting;
  installStatusLine: (command: string) => void;
}

export const defaultDeps: SetupDeps = {
  findRealClaude,
  saveClaudeBin,
  getNpmBinDir,
  detectShellConfigs,
  patchShellConfig,
  detectExistingStatusLine,
  installStatusLine,
};

export interface SetupWizardResult {
  binPath: string | null;
  patchedConfigs: string[];
  statusLineInstalled: boolean;
  cancelled: boolean;
}

export type DetectedExisting =
  | { kind: 'absent' }
  | { kind: 'ours-plain' }
  | { kind: 'ours-embedded' }
  | { kind: 'ours-ccstatusline' }
  | { kind: 'foreign'; command: string };

export type Step =
  | { kind: 'detect-bin' }
  | { kind: 'manual-bin'; error?: string }
  | { kind: 'detect-shell'; binPath: string | null }
  | { kind: 'pick-configs'; binPath: string | null; npmBin: string; configs: string[] }
  | { kind: 'no-shell-config'; binPath: string | null; npmBin: string }
  | { kind: 'no-npm-bin'; binPath: string | null }
  | { kind: 'sl-existing'; binPath: string | null; npmBin: string; patched: string[]; existing: DetectedExisting }
  | { kind: 'sl-replace-or-chain'; binPath: string | null; npmBin: string; patched: string[]; existing: DetectedExisting; cursor: number }
  | { kind: 'sl-confirm'; binPath: string | null; npmBin: string; patched: string[] }
  | { kind: 'sl-pick-variant'; binPath: string | null; npmBin: string; patched: string[]; cursor: number }
  | { kind: 'summary'; result: SetupWizardResult }
  | { kind: 'cancelled'; result: SetupWizardResult };

export const REPLACE_CHAIN_OPTS = [
  { value: 'skip', label: 'Keep what I have', hint: 'no changes' },
  { value: 'chain', label: 'Chain with ccstatusline', hint: 'show both — needs npx + ccstatusline' },
  { value: 'replace', label: 'Replace with claude-switch badge', hint: 'simplest, no extra deps' },
] as const;

export const VARIANT_OPTS = [
  { value: 'plain', label: 'Just the account badge', hint: 'no extra dependencies' },
  { value: 'ccstatusline', label: 'Badge + ccstatusline', hint: 'fancy bar — needs npx + ccstatusline' },
] as const;
