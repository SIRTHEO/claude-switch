// src/commands/switch.ts
// `claude switch` (interactive) and `claude switch <target>` (one-shot
// resolve-and-switch). Both routes live here because they share the
// "switch then optionally launch claude" intent — switch-interactive
// goes through the Ink dashboard; switch-to short-circuits straight to
// the picked account.

import { resolveAlias } from '../switching/aliases.js';
import { list as listAccounts } from '../accounts/accounts.js';
import { fuzzyMatch, switchInteractive } from '../switching/switcher.js';
import { repointToDefault } from '../switching/repoint.js';
import { runApp } from '../ui/run-app.js';
import type { CommandContext } from './context.js';

export async function handleSwitchInteractive(ctx: CommandContext): Promise<void> {
  // Persistent menu loop on a real terminal — actions return to the menu
  // instead of exiting. Falls back to the legacy numbered list for
  // pipes / CI / dumb terminals that can't render arrow-key navigation.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await runApp(ctx.claudeJsonPath, ctx.accountsDirPath);
  } else {
    await switchInteractive(ctx.claudeJsonPath, ctx.accountsDirPath);
  }
}

export async function handleSwitchTo(ctx: CommandContext, target: string): Promise<void> {
  const { claudeJsonPath, accountsDirPath } = ctx;
  const resolved = resolveAlias(target, accountsDirPath);
  const accounts = listAccounts(accountsDirPath);
  const matches = fuzzyMatch(resolved, accounts);

  if (matches.length === 1) {
    // Unified-profile model: re-point the default-pointer instead of
    // overwriting ~/.claude. No active-sessions warning anymore — a re-point
    // never disturbs a running session (each pins its own dir at launch), which
    // is the whole point. Fallback-on-switch is dropped (decision A1): switch is
    // a pure re-point now. `repointToDefault`'s message covers both the success
    // and the needs-login outcomes.
    const outcome = await repointToDefault(matches[0]!, claudeJsonPath, accountsDirPath);
    console.log(outcome.message);
    return;
  }

  if (matches.length > 1) {
    console.log('Multiple matches:');
    for (const m of matches) console.log(`  ${m}`);
    console.log('Be more specific.');
    return;
  }

  console.log(`No account matching "${target}". Run: claude switch list`);
}
