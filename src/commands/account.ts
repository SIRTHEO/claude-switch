// src/commands/account.ts
// `claude switch add` and `claude switch remove` — non-passthrough account
// management. The interactive Ink screens own the TTY path; non-TTY pipes
// (CI, scripts) fall through to the legacy CLI flows.

import { ExitError } from '../errors.js';
import { getCurrent, remove as removeAccount } from '../accounts.js';
import { addAccount } from '../switcher.js';
import { runAddAccountScreen } from '../ui/screens/add-account.js';
import { runRemoveAccountScreen } from '../ui/screens/remove-account.js';
import { findClaude } from './_helpers.js';
import type { CommandContext } from './context.js';

export async function handleAdd(ctx: CommandContext): Promise<void> {
  const claudeBin = findClaude(ctx.selfUrl);
  if (process.stdin.isTTY && process.stderr.isTTY) {
    await runAddAccountScreen(claudeBin, ctx.claudeJsonPath, ctx.accountsDirPath);
  } else {
    await addAccount(claudeBin, ctx.claudeJsonPath, ctx.accountsDirPath);
  }
}

export async function handleRemove(ctx: CommandContext, email: string | undefined): Promise<void> {
  if (!email) {
    throw new ExitError('Usage: claude switch remove <email>');
  }
  if (process.stdin.isTTY && process.stderr.isTTY) {
    await runRemoveAccountScreen(email, ctx.claudeJsonPath, ctx.accountsDirPath);
    return;
  }
  try {
    const current = getCurrent(ctx.claudeJsonPath);
    if (email === current) {
      throw new ExitError('Cannot remove the active account. Switch to another account first.');
    }
    removeAccount(email, ctx.accountsDirPath);
    console.log(`Removed: ${email}`);
  } catch (e) {
    if (e instanceof ExitError) throw e;
    throw new ExitError((e as Error).message);
  }
}
