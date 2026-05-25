// src/ui/screens/setup-wizard.tsx
// Ink port of `claude switch setup`. Linear stepper:
//   detect claude bin → optional manual path → choose shell rc files → status
//   line offer → summary.
//
// Side-effects (saveClaudeBin, patchShellConfig, installStatusLine) run
// between steps, not during render. This file owns the step state machine and
// handlers; the JSX render lives in setup-wizard-view.tsx, and the types/deps
// in setup-wizard-types.ts.

import { useEffect, useState } from 'react';
import { render, useApp, useInput } from 'ink';
import { clearScreen } from '../screen-buffer.js';
import { CCSTATUSLINE_COMMAND, PLAIN_COMMAND } from '../../statusline-install.js';
import { awaitInkScreen } from '../utils/ink-screen.js';
import {
  type DetectedExisting,
  REPLACE_CHAIN_OPTS,
  type SetupDeps,
  type SetupWizardResult,
  type Step,
  VARIANT_OPTS,
  defaultDeps,
} from './setup-wizard-types.js';
import { SetupStepView } from './setup-wizard-view.js';

export type { SetupDeps, SetupWizardResult } from './setup-wizard-types.js';

interface Props {
  selfPath: string;
  onDone: (result: SetupWizardResult) => void;
  /** Override system probes for testing — all optional, default to real implementations. */
  deps?: Partial<SetupDeps>;
}

export function SetupScreen({ selfPath, onDone, deps: depsOverride }: Props) {
  const { exit } = useApp();
  const d: SetupDeps = { ...defaultDeps, ...depsOverride };
  const [step, setStep] = useState<Step>({ kind: 'detect-bin' });

  const finish = (result: SetupWizardResult): void => {
    onDone(result);
    exit();
  };

  // Step driver: kicks off the synchronous detections on mount + on each
  // `step.kind` transition that needs a side effect.
  // The `d.*` callable deps are stable (captured from prop default on first
  // render) but biome's exhaustive-deps rule still requires them to be listed.
  useEffect(() => {
    if (step.kind === 'detect-bin') {
      const realClaude = d.findRealClaude(selfPath);
      if (realClaude) {
        d.saveClaudeBin(realClaude);
        setStep({ kind: 'detect-shell', binPath: realClaude });
      } else {
        setStep({ kind: 'manual-bin' });
      }
      return;
    }

    if (step.kind === 'detect-shell') {
      const npmBin = d.getNpmBinDir();
      if (!npmBin) {
        setStep({ kind: 'no-npm-bin', binPath: step.binPath });
        return;
      }
      const configs = d.detectShellConfigs();
      if (configs.length === 0) {
        setStep({ kind: 'no-shell-config', binPath: step.binPath, npmBin });
        return;
      }
      setStep({ kind: 'pick-configs', binPath: step.binPath, npmBin, configs });
      return;
    }

    if (step.kind === 'no-npm-bin') {
      setStep({
        kind: 'summary',
        result: {
          binPath: step.binPath,
          patchedConfigs: [],
          statusLineInstalled: false,
          cancelled: false,
        },
      });
    }
    // step.binPath is read in 'detect-shell' and 'no-npm-bin' branches.
  }, [step, selfPath, d.findRealClaude, d.saveClaudeBin, d.getNpmBinDir, d.detectShellConfigs]);

  // ---- Status-line transitions ----

  const startStatusLine = (binPath: string | null, npmBin: string, patched: string[]): void => {
    let existing: DetectedExisting;
    try {
      existing = d.detectExistingStatusLine();
    } catch { // detection failed → treat as absent
      existing = { kind: 'absent' };
    }
    if (
      existing.kind === 'ours-plain' ||
      existing.kind === 'ours-embedded' ||
      existing.kind === 'ours-ccstatusline'
    ) {
      // Already configured — nothing to ask.
      setStep({
        kind: 'summary',
        result: { binPath, patchedConfigs: patched, statusLineInstalled: false, cancelled: false },
      });
      return;
    }
    if (existing.kind === 'foreign') {
      setStep({ kind: 'sl-existing', binPath, npmBin, patched, existing });
      return;
    }
    setStep({ kind: 'sl-confirm', binPath, npmBin, patched });
  };

  const installAndFinish = (
    binPath: string | null,
    patched: string[],
    command: string,
  ): void => {
    let installed = false;
    try {
      d.installStatusLine(command);
      installed = true;
    } catch { // install failed → report not installed
      installed = false;
    }
    setStep({
      kind: 'summary',
      result: { binPath, patchedConfigs: patched, statusLineInstalled: installed, cancelled: false },
    });
  };

  // ---- Input handlers ----

  const onManualBinSubmit = (raw: string): void => {
    if (step.kind !== 'manual-bin') return;
    const trimmed = raw.trim();
    if (!trimmed) {
      // Empty = skip — same semantics as the clack flow.
      setStep({ kind: 'detect-shell', binPath: null });
      return;
    }
    d.saveClaudeBin(trimmed);
    setStep({ kind: 'detect-shell', binPath: trimmed });
  };

  const onPickConfigsSubmit = (selected: string[]): void => {
    if (step.kind !== 'pick-configs') return;
    const patched: string[] = [];
    for (const cfg of selected) {
      try {
        if (d.patchShellConfig(cfg, step.npmBin)) patched.push(cfg);
      } catch {
        /* keep going — surface what worked in the summary */
      }
    }
    startStatusLine(step.binPath, step.npmBin, patched);
  };

  const onConfirmStatusLine = (): void => {
    if (step.kind !== 'sl-confirm') return;
    setStep({
      kind: 'sl-pick-variant',
      binPath: step.binPath,
      npmBin: step.npmBin,
      patched: step.patched,
      cursor: 0,
    });
  };

  const onCancelStatusLine = (): void => {
    if (step.kind !== 'sl-confirm') return;
    setStep({
      kind: 'summary',
      result: { binPath: step.binPath, patchedConfigs: step.patched, statusLineInstalled: false, cancelled: false },
    });
  };

  // Navigation for the two list-based status-line steps.
  useInput((_input, key) => {
    if (step.kind === 'sl-replace-or-chain') {
      if (key.upArrow) setStep({ ...step, cursor: Math.max(0, step.cursor - 1) });
      else if (key.downArrow) setStep({ ...step, cursor: Math.min(REPLACE_CHAIN_OPTS.length - 1, step.cursor + 1) });
      else if (key.escape) {
        setStep({
          kind: 'summary',
          result: { binPath: step.binPath, patchedConfigs: step.patched, statusLineInstalled: false, cancelled: false },
        });
      } else if (key.return) {
        const choice = REPLACE_CHAIN_OPTS[step.cursor]?.value;
        if (!choice || choice === 'skip') {
          setStep({
            kind: 'summary',
            result: { binPath: step.binPath, patchedConfigs: step.patched, statusLineInstalled: false, cancelled: false },
          });
          return;
        }
        installAndFinish(
          step.binPath,
          step.patched,
          choice === 'chain' ? CCSTATUSLINE_COMMAND : PLAIN_COMMAND,
        );
      }
      return;
    }
    if (step.kind === 'sl-pick-variant') {
      if (key.upArrow) setStep({ ...step, cursor: Math.max(0, step.cursor - 1) });
      else if (key.downArrow) setStep({ ...step, cursor: Math.min(VARIANT_OPTS.length - 1, step.cursor + 1) });
      else if (key.escape) {
        setStep({
          kind: 'summary',
          result: { binPath: step.binPath, patchedConfigs: step.patched, statusLineInstalled: false, cancelled: false },
        });
      } else if (key.return) {
        const choice = VARIANT_OPTS[step.cursor]?.value;
        if (!choice) return;
        installAndFinish(
          step.binPath,
          step.patched,
          choice === 'ccstatusline' ? CCSTATUSLINE_COMMAND : PLAIN_COMMAND,
        );
      }
      return;
    }
    if (step.kind === 'no-shell-config' && (key.return || key.escape)) {
      setStep({
        kind: 'summary',
        result: { binPath: step.binPath, patchedConfigs: [], statusLineInstalled: false, cancelled: false },
      });
      return;
    }
    if (step.kind === 'sl-existing' && (key.return || key.escape)) {
      setStep({ kind: 'sl-replace-or-chain', binPath: step.binPath, npmBin: step.npmBin, patched: step.patched, existing: step.existing, cursor: 0 });
      return;
    }
    if (step.kind === 'summary' && (key.return || key.escape)) {
      finish(step.result);
      return;
    }
    if (step.kind === 'cancelled' && (key.return || key.escape)) {
      finish(step.result);
    }
  });

  return (
    <SetupStepView
      step={step}
      onManualBinSubmit={onManualBinSubmit}
      onPickConfigsSubmit={onPickConfigsSubmit}
      onConfirmStatusLine={onConfirmStatusLine}
      onCancelStatusLine={onCancelStatusLine}
    />
  );
}

export async function runSetupWizardScreen(selfPath: string): Promise<SetupWizardResult> {
  let result: SetupWizardResult = {
    binPath: null,
    patchedConfigs: [],
    statusLineInstalled: false,
    cancelled: true,
  };
  clearScreen();
  const instance = render(
    <SetupScreen
      selfPath={selfPath}
      onDone={(r) => {
        result = r;
      }}
    />,
    { exitOnCtrlC: true },
  );
  return awaitInkScreen(instance, () => result);
}
