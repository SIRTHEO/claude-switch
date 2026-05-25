// src/commands/alias.ts
// `claude switch alias …` — set / list / remove aliases for accounts.

import { ExitError, errMessage } from '../platform/errors.js';
import { setAlias, listAliases, removeAlias } from '../switching/aliases.js';
import type { CommandContext } from './context.js';
import type { AliasEntry } from '../contract.js';

export function handleAliasSet(
  ctx: CommandContext,
  name: string,
  email: string | undefined,
): void {
  if (!email) {
    throw new ExitError('Usage: claude switch alias <name> <email>');
  }
  try {
    setAlias(name, email, ctx.accountsDirPath);
  } catch (e) {
    if (e instanceof ExitError) throw e;
    throw new ExitError(errMessage(e));
  }
  console.log(`Alias set: ${name} → ${email}`);
}

interface AliasListOptions {
  json: boolean;
}

export function handleAliasList(
  ctx: CommandContext,
  opts: AliasListOptions = { json: false },
): void {
  const aliases = listAliases(ctx.accountsDirPath);
  const entries = Object.entries(aliases);

  if (opts.json) {
    const payload: AliasEntry[] = entries.map(([alias, email]) => ({ alias, email }));
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (entries.length === 0) {
    console.log('No aliases. Set one with: claude switch alias <name> <email>');
    return;
  }
  console.log('Aliases:\n');
  for (const [name, email] of entries) {
    console.log(`  ${name} → ${email}`);
  }
}

export function handleAliasRemove(ctx: CommandContext, name: string | undefined): void {
  if (!name) {
    throw new ExitError('Usage: claude switch alias --remove <name>');
  }
  try {
    removeAlias(name, ctx.accountsDirPath);
    console.log(`Alias removed: ${name}`);
  } catch (e) {
    if (e instanceof ExitError) throw e;
    throw new ExitError(errMessage(e));
  }
}
