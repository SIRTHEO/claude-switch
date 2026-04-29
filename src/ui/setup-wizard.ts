// src/ui/setup-wizard.ts
// Polished onboarding flow for `claude switch setup`.

import * as p from '@clack/prompts';
import {
  findRealClaude,
  saveClaudeBin,
  getNpmBinDir,
  detectShellConfigs,
  patchShellConfig,
} from '../setup.js';

export interface SetupWizardResult {
  binPath: string | null;
  patchedConfigs: string[];
  cancelled: boolean;
}

export async function runSetupWizard(selfPath: string): Promise<SetupWizardResult> {
  p.intro('claude-switch setup');

  // Step 1: detect the real claude binary.
  const detect = p.spinner();
  detect.start('Looking for the real claude binary');
  const realClaude = findRealClaude(selfPath);
  if (realClaude) {
    detect.stop(`Found: ${realClaude}`);
  } else {
    detect.stop('No claude binary found on PATH');
  }

  let binPath: string | null = realClaude;

  if (!realClaude) {
    p.note(
      `claude-switch needs the path to the real claude CLI to wrap it.\n` +
      `If you have not installed Claude Code yet, do that first:\n` +
      `  https://docs.anthropic.com/en/docs/claude-code\n\n` +
      `If it is installed but not on PATH, you can give the path manually.`,
      'Heads up',
    );
    const manual = await p.text({
      message: 'Path to the real claude binary (leave empty to skip)',
      placeholder: '/usr/local/bin/claude',
    });
    if (p.isCancel(manual)) {
      p.cancel('Setup cancelled.');
      return { binPath: null, patchedConfigs: [], cancelled: true };
    }
    binPath = manual.trim() || null;
  }

  if (binPath) {
    saveClaudeBin(binPath);
  }

  // Step 2: detect shell configs that should be patched.
  const npmBin = getNpmBinDir();
  if (!npmBin) {
    p.note(
      `Could not detect the npm global bin directory from npm_config_prefix.\n` +
      `Skipping the PATH patch — make sure your npm bin dir is on PATH manually.`,
      'PATH patch skipped',
    );
    p.outro(binPath ? 'Setup partially complete.' : 'Nothing was changed.');
    return { binPath, patchedConfigs: [], cancelled: false };
  }

  const configs = detectShellConfigs();
  if (configs.length === 0) {
    p.note(
      `No shell config files were detected (.zshrc, .bashrc, fish, …).\n` +
      `Add this to your shell config manually:\n` +
      `  export PATH="${npmBin}:$PATH"`,
      'No shell config found',
    );
    p.outro(binPath ? 'Setup complete (manual PATH update needed).' : 'Done.');
    return { binPath, patchedConfigs: [], cancelled: false };
  }

  const targets = await p.multiselect<string>({
    message: 'Patch which shell config files?',
    options: configs.map(c => ({ value: c, label: c })),
    initialValues: configs,
    required: false,
  });
  if (p.isCancel(targets)) {
    p.cancel('Setup cancelled — no shell config patched.');
    return { binPath, patchedConfigs: [], cancelled: true };
  }

  const patchedConfigs: string[] = [];
  if (targets.length > 0) {
    const patchSpin = p.spinner();
    patchSpin.start('Applying PATH patch');
    for (const config of targets) {
      if (patchShellConfig(config, npmBin)) {
        patchedConfigs.push(config);
      }
    }
    patchSpin.stop(
      patchedConfigs.length > 0
        ? `Patched ${patchedConfigs.length} file(s)`
        : 'Already patched — nothing to do',
    );
  }

  // Step 3: summary.
  const summary: string[] = [];
  if (binPath) summary.push(`Real claude: ${binPath}`);
  summary.push(`npm bin dir: ${npmBin}`);
  if (patchedConfigs.length > 0) {
    summary.push(`Patched: ${patchedConfigs.map(c => c.replace(process.env.HOME || '~', '~')).join(', ')}`);
  } else {
    summary.push('Shell config: nothing changed');
  }
  p.note(summary.join('\n'), 'Summary');

  if (patchedConfigs.length > 0) {
    p.outro('Setup complete. Open a new terminal so the PATH update takes effect.');
  } else {
    p.outro('Setup complete.');
  }

  return { binPath, patchedConfigs, cancelled: false };
}
