// src/commands/route.ts
// `claude switch route` sub-tree — manage the per-machine global routing
// rules in `<accountsDirPath>/.routing.json`. The committable per-repo
// `.claude-switch` file is NOT touched by these commands; it is created by
// the team / by hand and lives in the repo. We only edit the user-local
// glob → account map.
//
// Sub-commands:
//   route add <pattern> <email|alias>   append a rule (atomic, rejects bad input)
//   route list                          show all rules
//   route remove <pattern>              drop the first matching pattern
//   route test [<cwd>]                  resolve routing for a path (debug)
//
// Identity rule: rules must reference an account that exists locally
// (either via canonical email or via a known alias). We refuse to write
// orphan rules — they would silently no-op at passthrough time.

import fs from 'node:fs';
import path from 'node:path';
import { ExitError, errnoCode } from '../errors.js';
import { writeJsonAtomic } from '../atomic-write.js';
import { withLock } from '../lock.js';
import { list as listAccounts, isSafeEmail } from '../accounts.js';
import { getAlias } from '../aliases.js';
import { readState } from '../state-store.js';
import {
  parseRoutingFile,
  resolveRouting,
  type RoutingFile,
  type RoutingRule,
} from '../routing.js';
import type { CommandContext } from './context.js';

const ROUTING_FILE = '.routing.json';

function routingFilePath(accountsDirPath: string): string {
  return path.join(accountsDirPath, ROUTING_FILE);
}

/** Read the routing file, returning empty `{version:1, rules:[]}` when
 *  the file is absent. Throws ExitError on malformed content so the user
 *  is forced to fix it before adding more rules — silently overwriting
 *  would lose their hand-written rules. */
function readRoutingFileStrict(accountsDirPath: string): RoutingFile {
  const file = routingFilePath(accountsDirPath);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') {
      return { version: 1, rules: [] };
    }
    throw e;
  }
  const parsed = parseRoutingFile(raw);
  if (!parsed.ok || !parsed.value) {
    throw new ExitError(
      `${file} is malformed: ${parsed.error}.\n` +
      `Fix or delete it before adding more rules.`,
    );
  }
  return parsed.value;
}

function writeRoutingFile(accountsDirPath: string, data: RoutingFile): void {
  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });
  writeJsonAtomic(routingFilePath(accountsDirPath), data);
}

// ---------------------------------------------------------------------------
// route add
// ---------------------------------------------------------------------------

export function handleRouteAdd(
  ctx: CommandContext,
  pattern: string | undefined,
  target: string | undefined,
): void {
  if (!pattern) throw new ExitError('Usage: claude switch route add <pattern> <email|alias>');
  if (!target) throw new ExitError('Usage: claude switch route add <pattern> <email|alias>');

  // Patterns starting with `--` would be eaten by future flag parsing. Reject
  // up-front; users almost certainly meant a positional arg.
  if (pattern.startsWith('--')) {
    throw new ExitError(`Pattern cannot start with "--": ${pattern}`);
  }

  // Resolve target: either a canonical email already on disk, or an alias
  // that points to one. Refuse orphans — a rule pointing nowhere silently
  // no-ops at passthrough resolution time, which is worse than a clear
  // upfront error.
  const accounts = listAccounts(ctx.accountsDirPath);
  const isEmail = target.includes('@');
  let rule: RoutingRule;
  if (isEmail) {
    if (!isSafeEmail(target)) {
      throw new ExitError(`Email contains characters unsafe for the routing file: ${target}`);
    }
    if (!accounts.includes(target)) {
      throw new ExitError(
        `${target} is not a saved account. Run: claude switch list\n` +
        `  (Or use an alias: claude switch route add <pattern> <alias>)`,
      );
    }
    rule = { match: pattern, account: target };
  } else {
    const resolved = getAlias(target, ctx.accountsDirPath);
    if (!resolved) {
      throw new ExitError(`Unknown alias: ${target}. Run: claude switch alias --list`);
    }
    if (!accounts.includes(resolved)) {
      throw new ExitError(
        `Alias ${target} points to ${resolved}, which is not a saved account. ` +
        `Run: claude switch list`,
      );
    }
    rule = { match: pattern, alias: target };
  }

  withLock(ctx.accountsDirPath, () => {
    const file = readRoutingFileStrict(ctx.accountsDirPath);
    // Refuse exact-duplicate patterns to keep the file deterministic.
    if (file.rules.some((r) => r.match === pattern)) {
      throw new ExitError(
        `A rule for pattern "${pattern}" already exists. ` +
        `Run: claude switch route remove ${pattern}`,
      );
    }
    file.rules.push(rule);
    writeRoutingFile(ctx.accountsDirPath, file);
  });

  const targetLabel = rule.account ?? `alias ${rule.alias}`;
  console.log(`Added rule: ${pattern} → ${targetLabel}`);
}

// ---------------------------------------------------------------------------
// route list
// ---------------------------------------------------------------------------

export function handleRouteList(ctx: CommandContext): void {
  const file = readRoutingFileStrict(ctx.accountsDirPath);
  if (file.rules.length === 0) {
    console.log('No global routing rules. Add one with: claude switch route add <pattern> <email|alias>');
    return;
  }
  console.log('Global routing rules:\n');
  for (const r of file.rules) {
    const target = r.account ?? `alias ${r.alias}`;
    console.log(`  ${r.match}  →  ${target}`);
  }
  console.log('');
  console.log('Per-repo overrides live in `.claude-switch` at the repo root.');
}

// ---------------------------------------------------------------------------
// route remove
// ---------------------------------------------------------------------------

export function handleRouteRemove(ctx: CommandContext, pattern: string | undefined): void {
  if (!pattern) throw new ExitError('Usage: claude switch route remove <pattern>');

  let removed = false;
  withLock(ctx.accountsDirPath, () => {
    const file = readRoutingFileStrict(ctx.accountsDirPath);
    const before = file.rules.length;
    file.rules = file.rules.filter((r) => r.match !== pattern);
    if (file.rules.length === before) return;
    removed = true;
    writeRoutingFile(ctx.accountsDirPath, file);
  });

  if (!removed) {
    throw new ExitError(`No rule with pattern "${pattern}". Run: claude switch route list`);
  }
  console.log(`Removed rule: ${pattern}`);
}

// ---------------------------------------------------------------------------
// route test
// ---------------------------------------------------------------------------

export function handleRouteTest(ctx: CommandContext, cwdArg: string | undefined): void {
  const cwd = cwdArg ? path.resolve(cwdArg) : process.cwd();
  const accounts = listAccounts(ctx.accountsDirPath);
  let activeEmail: string | null = null;
  try {
    const data = JSON.parse(fs.readFileSync(ctx.claudeJsonPath, 'utf-8'));
    activeEmail = data?.oauthAccount?.emailAddress || null;
  } catch { /* no claude.json yet */ }

  const lastUsedByDomain = readState(ctx.accountsDirPath).lastUsedByDomain ?? {};

  const decision = resolveRouting({
    cwd,
    accountsDirPath: ctx.accountsDirPath,
    env: process.env,
    activeEmail,
    savedEmails: accounts,
    lastUsedByDomain,
    resolveAlias: (a) => getAlias(a, ctx.accountsDirPath),
  });

  console.log(`cwd:           ${cwd}`);
  console.log(`active:        ${activeEmail ?? '(none)'}`);
  console.log(`saved:         ${accounts.length === 0 ? '(none)' : accounts.join(', ')}`);
  console.log('');
  if (!decision) {
    console.log('decision:      (no routing opinion — passthrough would use the active account)');
    return;
  }
  console.log(`decision:      ${decision.email}`);
  console.log(`source:        ${decision.source}`);
  if (decision.banner) console.log(`banner:        ${decision.banner}`);
  if (decision.warning) console.log(`warning:       ${decision.warning}`);
  if (decision.email === activeEmail) {
    console.log('effect:        (silent — already on this account)');
  } else if (accounts.includes(decision.email)) {
    console.log(`effect:        passthrough would auto-switch to ${decision.email}`);
  }
}
