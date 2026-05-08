// src/commands/switch.ts
// `claude switch` (interactive) and `claude switch <target>` (one-shot
// resolve-and-switch). Both routes live here because they share the
// "switch then optionally launch claude" intent — switch-interactive
// goes through the Ink dashboard; switch-to short-circuits straight to
// the picked account.

import { resolveAlias } from '../aliases.js';
import { list as listAccounts } from '../accounts.js';
import { fuzzyMatch, switchInteractive, switchToAndSyncFallback } from '../switcher.js';
import { getSavedClaudeBin } from '../setup.js';
import { readGlobalPrefs } from '../preferences.js';
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
    // Warn (don't block) if other claude sessions are running — they
    // won't see the switch until restarted. See FAQ in README.
    const { countActiveClaudeSessions, buildActiveSessionsWarning } = await import('../active-sessions.js');
    const sessions = countActiveClaudeSessions(getSavedClaudeBin());
    const warning = buildActiveSessionsWarning(sessions.count);
    if (warning) process.stderr.write(`${warning}\n\n`);

    // Bundle switch + fallback flip in one withLock so a concurrent
    // `claude switch` can't race the two writes (see switcher.ts).
    // Honour the user's `defaultAutoFlipFallback` preference so the CLI
    // matches the Ink dashboard — pre-3.6 the CLI hard-coded `true` and
    // silently ignored the toggle, which silently re-enabled fallback
    // on every `claude switch <account>` even when the user had turned
    // auto-flip off.
    const prefs = readGlobalPrefs(accountsDirPath);
    const outcome = switchToAndSyncFallback(matches[0]!, claudeJsonPath, accountsDirPath, {
      autoFlipFallback: prefs.defaultAutoFlipFallback,
    });
    console.log(outcome.message);
    if (outcome.fallbackFlipped) {
      process.stderr.write(outcome.hasApiKey
        ? '  Fallback ON — API key active (no OAuth available for this account)\n'
        : '  Fallback OFF — using OAuth\n');
    } else {
      process.stderr.write(outcome.hasApiKey
        ? '  API key saved (manual toggle: claude switch fallback on)\n'
        : '  Using OAuth\n');
    }
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
