// src/commands/setup.ts
// `claude switch setup` — first-run / re-run wizard.

import { fileURLToPath } from 'node:url';
import { runSetup } from '../setup.js';
import { runSetupWizardScreen } from '../ui/screens/setup-wizard.js';
import type { CommandContext } from './context.js';

export async function handleSetup(ctx: CommandContext): Promise<void> {
  const selfPath = fileURLToPath(ctx.selfUrl);
  if (process.stdin.isTTY && process.stderr.isTTY) {
    await runSetupWizardScreen(selfPath);
  } else {
    await runSetup(selfPath);
  }
}
