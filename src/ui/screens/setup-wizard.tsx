// src/ui/screens/setup-wizard.tsx
// Ink port of `claude switch setup`. Linear stepper:
//   detect claude bin → optional manual path → choose shell rc files → status
//   line offer → summary.
//
// Side-effects (saveClaudeBin, patchShellConfig, installStatusLine) run
// between steps, not during render. Pure render of step state, plus async
// handlers that advance.

import { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { clearScreen } from '../screen-buffer.js';import { Badge, ConfirmInput, MultiSelect, StatusMessage, TextInput } from '@inkjs/ui';

import {
  findRealClaude,
  saveClaudeBin,
  getNpmBinDir,
  detectShellConfigs,
  patchShellConfig,
} from '../../setup.js';
import {
  detectExistingStatusLine,
  installStatusLine,
  PLAIN_COMMAND,
  CCSTATUSLINE_COMMAND,
} from '../../statusline-install.js';
import { ORANGE } from '../theme.js';
import { awaitInkScreen } from '../utils/ink-screen.js';

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

const defaultDeps: SetupDeps = {
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

type DetectedExisting =
  | { kind: 'absent' }
  | { kind: 'ours-plain' }
  | { kind: 'ours-embedded' }
  | { kind: 'ours-ccstatusline' }
  | { kind: 'foreign'; command: string };

type Step =
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

interface Props {
  selfPath: string;
  onDone: (result: SetupWizardResult) => void;
  /** Override system probes for testing — all optional, default to real implementations. */
  deps?: Partial<SetupDeps>;
}

const REPLACE_CHAIN_OPTS = [
  { value: 'skip', label: 'Keep what I have', hint: 'no changes' },
  { value: 'chain', label: 'Chain with ccstatusline', hint: 'show both — needs npx + ccstatusline' },
  { value: 'replace', label: 'Replace with claude-switch badge', hint: 'simplest, no extra deps' },
] as const;

const VARIANT_OPTS = [
  { value: 'plain', label: 'Just the account badge', hint: 'no extra dependencies' },
  { value: 'ccstatusline', label: 'Badge + ccstatusline', hint: 'fancy bar — needs npx + ccstatusline' },
] as const;

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

  // ---- Render ----
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>claude-switch setup</Badge>
      </Box>

      {step.kind === 'detect-bin' && <Text color={ORANGE}>… looking for the real claude binary</Text>}

      {step.kind === 'manual-bin' && (
        <Box flexDirection="column">
          <StatusMessage variant="warning">No claude binary found on PATH.</StatusMessage>
          <Text color="gray">
            claude-switch needs the path to the real claude CLI. Install Claude Code first if you haven't:
          </Text>
          <Text color="gray">  https://docs.anthropic.com/en/docs/claude-code</Text>
          <Box marginTop={1}>
            <Text>Path (Enter to skip): </Text>
            <TextInput placeholder="/usr/local/bin/claude" onSubmit={onManualBinSubmit} />
          </Box>
          {step.error && <StatusMessage variant="error">{step.error}</StatusMessage>}
        </Box>
      )}

      {step.kind === 'detect-shell' && <Text color={ORANGE}>… detecting shell config</Text>}

      {step.kind === 'no-npm-bin' && (
        <Box flexDirection="column">
          <StatusMessage variant="warning">
            Could not detect the npm global bin directory. Skipping the PATH patch — set it manually.
          </StatusMessage>
        </Box>
      )}

      {step.kind === 'no-shell-config' && (
        <Box flexDirection="column">
          <StatusMessage variant="warning">No shell config detected (.zshrc, .bashrc, fish, …).</StatusMessage>
          <Text color="gray">Add this to your shell config manually:</Text>
          <Text bold>  export PATH="{step.npmBin}:$PATH"</Text>
          <Text color="gray">(enter or esc to continue)</Text>
        </Box>
      )}

      {step.kind === 'pick-configs' && (
        <Box flexDirection="column">
          <Text>Patch which shell config files? (space toggles, enter confirms)</Text>
          <Box marginTop={1}>
            <MultiSelect
              options={step.configs.map((c) => ({ value: c, label: c }))}
              defaultValue={step.configs}
              onSubmit={onPickConfigsSubmit}
            />
          </Box>
          <Text color="gray">(enter with no selection = patch nothing)</Text>
        </Box>
      )}

      {step.kind === 'sl-existing' && (
        <Box flexDirection="column">
          <StatusMessage variant="info">
            Claude Code already has a custom status line.
          </StatusMessage>
          <Text color="gray">  {step.existing.kind === 'foreign' ? step.existing.command : ''}</Text>
          <Text color="gray">
            claude-switch can replace it with the account badge, or chain it with ccstatusline.
          </Text>
          <Text color="gray">(enter or esc to continue)</Text>
        </Box>
      )}

      {step.kind === 'sl-replace-or-chain' && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold>What would you like to do?</Text>
          {REPLACE_CHAIN_OPTS.map((opt, i) => {
            const selected = i === step.cursor;
            return (
              <Box key={opt.value}>
                <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
                <Text bold={selected}>{opt.label}</Text>
                {opt.hint && <Text color="gray">  · {opt.hint}</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      {step.kind === 'sl-confirm' && (
        <Box flexDirection="column">
          <Text>Show the active account in Claude Code's status bar?</Text>
          <Box>
            <Text>› </Text>
            <ConfirmInput
              defaultChoice="confirm"
              onConfirm={() =>
                setStep({
                  kind: 'sl-pick-variant',
                  binPath: step.binPath,
                  npmBin: step.npmBin,
                  patched: step.patched,
                  cursor: 0,
                })
              }
              onCancel={() =>
                setStep({
                  kind: 'summary',
                  result: { binPath: step.binPath, patchedConfigs: step.patched, statusLineInstalled: false, cancelled: false },
                })
              }
            />
          </Box>
        </Box>
      )}

      {step.kind === 'sl-pick-variant' && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold>Which style?</Text>
          {VARIANT_OPTS.map((opt, i) => {
            const selected = i === step.cursor;
            return (
              <Box key={opt.value}>
                <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
                <Text bold={selected}>{opt.label}</Text>
                {opt.hint && <Text color="gray">  · {opt.hint}</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      {step.kind === 'summary' && (
        <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
          <Text bold color={ORANGE}>Summary</Text>
          {step.result.binPath && <Text color="gray">Real claude: {step.result.binPath}</Text>}
          {step.result.patchedConfigs.length > 0 ? (
            <Text color="gray">
              Patched: {step.result.patchedConfigs.map((c) => c.replace(process.env.HOME || '~', '~')).join(', ')}
            </Text>
          ) : (
            <Text color="gray">Shell config: nothing changed</Text>
          )}
          {step.result.statusLineInstalled && (
            <Text color="gray">Status bar: account badge installed</Text>
          )}
          {step.result.patchedConfigs.length > 0 && (
            <Box marginTop={1}>
              <Text color="yellow">Open a new terminal so the PATH update takes effect.</Text>
            </Box>
          )}
          <Text color="gray">(enter or esc to finish)</Text>
        </Box>
      )}

      {step.kind === 'cancelled' && (
        <StatusMessage variant="info">Setup cancelled. (enter or esc to close)</StatusMessage>
      )}
    </Box>
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
