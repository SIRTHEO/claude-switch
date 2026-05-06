// src/commands/apikey.ts
// `claude switch apikey set / show / remove` — manage the saved API key
// for an account. The `set` flow prefers the Ink screen on a TTY; falls
// back to stdin pipe for non-interactive contexts (CI, scripts).

import { ExitError } from '../errors.js';
import { withLock } from '../lock.js';
import { getApiKey, setApiKey, removeApiKey, maskApiKey } from '../apikey.js';
import { maybeInitSmartFallback } from '../auto-fallback.js';
import { runApikeyScreen } from '../ui/screens/set-apikey.js';
import { resolveTargetEmail, promptSecret } from './_helpers.js';
import type { CommandContext } from './context.js';

export async function handleApikeySet(ctx: CommandContext, target: string | undefined): Promise<void> {
  if (!target) {
    throw new ExitError('Usage: claude switch apikey set <alias|email>');
  }
  const email = resolveTargetEmail(target, ctx.accountsDirPath);

  // TUI when we have a real terminal; legacy text fallback for pipes/CI.
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const result = await runApikeyScreen(email, ctx.accountsDirPath);
    if (!result.saved && !result.cancelled) {
      // setApiKey threw — let the next invocation try again.
      process.exit(1);
    }
    return;
  }

  // Non-TTY fallback: read first line of stdin as the key, no prompts.
  const existing = getApiKey(email, ctx.accountsDirPath);
  if (existing) {
    throw new ExitError(
      `An API key is already saved for ${email} (${maskApiKey(existing)}). ` +
      `Run interactively to overwrite.`,
    );
  }
  const key = await promptSecret('');
  if (!key) throw new ExitError('No key on stdin. Aborted.');
  withLock(ctx.accountsDirPath, () => setApiKey(email, key, ctx.accountsDirPath));
  maybeInitSmartFallback(ctx.accountsDirPath);
  console.log(`Saved API key for ${email} (${maskApiKey(key)}).`);
}

export function handleApikeyShow(ctx: CommandContext, target: string | undefined): void {
  if (!target) {
    throw new ExitError('Usage: claude switch apikey show <alias|email>');
  }
  const email = resolveTargetEmail(target, ctx.accountsDirPath);
  const key = getApiKey(email, ctx.accountsDirPath);
  if (!key) {
    console.log(`No API key saved for ${email}.`);
  } else {
    console.log(`${email}: ${maskApiKey(key)}`);
  }
}

export function handleApikeyRemove(ctx: CommandContext, target: string | undefined): void {
  if (!target) {
    throw new ExitError('Usage: claude switch apikey remove <alias|email>');
  }
  const email = resolveTargetEmail(target, ctx.accountsDirPath);
  const removed = withLock(ctx.accountsDirPath, () =>
    removeApiKey(email, ctx.accountsDirPath),
  );
  console.log(removed
    ? `Removed API key for ${email}.`
    : `No API key was saved for ${email}.`);
}
