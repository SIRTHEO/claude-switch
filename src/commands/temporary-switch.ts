// src/commands/temporary-switch.ts
// `claude --as <account> [args...]` — runs claude as a different account
// for ONE invocation, then restores the previous active account on exit.
// State recovery is handled inside `runTemporarySwitch` (save → spawn →
// restore on exit/SIGINT, with a `.pending-restore` file as crash anchor).

import { ExitError } from '../platform/errors.js';
import { fuzzyMatch, runTemporarySwitch } from '../switching/switcher.js';
import { resolveAlias } from '../switching/aliases.js';
import { list as listAccounts } from '../accounts/accounts.js';
import { fallbackEnvFor } from '../fallback/fallback-env.js';
import { findClaude } from './_helpers.js';
import type { CommandContext } from './context.js';

export async function handleTemporarySwitch(
  ctx: CommandContext,
  target: string | undefined,
  args: string[],
): Promise<void> {
  if (!target) {
    throw new ExitError('Usage: claude --as <account> [args...]');
  }

  const claudeBin = findClaude(ctx.selfUrl);
  const resolved = resolveAlias(target, ctx.accountsDirPath);
  const accounts = listAccounts(ctx.accountsDirPath);
  const matches = fuzzyMatch(resolved, accounts);

  if (matches.length === 0) {
    throw new ExitError(`No account matching "${target}". Run: claude switch list`);
  }
  if (matches.length > 1) {
    throw new ExitError(
      `Multiple matches for "${target}":\n${matches.map((m) => `  ${m}`).join('\n')}\nBe more specific.`,
    );
  }

  const matched = matches[0]!;
  const extraEnv = fallbackEnvFor(matched, ctx.accountsDirPath);
  if (extraEnv) {
    process.stderr.write(`(fallback on — using saved API key for ${matched})\n\n`);
  }
  // runTemporarySwitch handles save/restore (incl. Keychain), SIGINT, never returns.
  await runTemporarySwitch(claudeBin, matched, args, ctx.claudeJsonPath, ctx.accountsDirPath, extraEnv);
}
