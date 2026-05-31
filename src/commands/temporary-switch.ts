// src/commands/temporary-switch.ts
// `claude --as <account> [args...]` — launch `claude` as a different account
// for ONE invocation. Unified profile model (Fork C): the account runs ISOLATED
// in its own profile (CLAUDE_CONFIG_DIR), reusing a logged-in profile/overlay if
// present and minting one on demand otherwise. It never rewrites the global
// ~/.claude, so there is no save/restore and nothing to undo on exit. The one
// exception is `--as <the-account-already-global>`: that runs plain (no mint),
// since isolating the frozen default would mint a duplicate home (the §1
// invariant).

import { ExitError } from '../platform/errors.js';
import { fuzzyMatch } from '../switching/switcher.js';
import { resolveAlias } from '../switching/aliases.js';
import { getCurrent, list as listAccounts } from '../accounts/accounts.js';
import { fallbackEnvFor } from '../fallback/fallback-env.js';
import { run as proxyRun } from '../proxy/proxy.js';
import { markSessionLive } from '../sessions/session-registry.js';
import { findClaude } from './_helpers.js';
import type { CommandContext } from './context.js';

export async function handleTemporarySwitch(
  ctx: CommandContext,
  target: string | undefined,
  args: string[],
  deps: { runClaude?: typeof proxyRun } = {},
): Promise<void> {
  if (!target) {
    throw new ExitError('Usage: claude --as <account> [args...]');
  }
  const runClaude = deps.runClaude ?? proxyRun;

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

  // §1 fast path: `--as` the account ALREADY in the global ~/.claude (the frozen
  // default) → run it plain. Isolating it would mint a duplicate home for the
  // default account, which the unified model forbids. fallbackEnvFor keeps the
  // saved-API-key env on this (global-bound) account, matching pre-unified `--as`.
  if (matched === getCurrent(ctx.claudeJsonPath)) {
    const extraEnv = fallbackEnvFor(matched, ctx.accountsDirPath);
    if (extraEnv) {
      process.stderr.write(`(fallback on — using saved API key for ${matched})\n\n`);
    }
    markSessionLive(ctx.accountsDirPath, { account: matched, configDir: null, cwd: process.cwd() });
    process.stderr.write(`🔑 ${matched}\n\n`);
    // Explicit return so a non-blocking test fake (proxyRun is `never` in prod)
    // can't fall through into the isolated path below.
    runClaude(claudeBin, args, extraEnv);
    return;
  }

  // Different account → launch it ISOLATED in its own profile. ensureProfileForAccount
  // reuses a logged-in profile/overlay or mints one on demand; its `needsLogin` is
  // authoritative (it runs the legacy-snapshot recovery a bare readProfile wouldn't).
  // profiles.ts is heavy (Keychain/oauth-refresh) → lazy-import so it stays off the
  // cli startup graph that every bare `claude` invocation pays for.
  const { ensureProfileForAccount } = await import('../profiles/profiles.js');
  const profile = await ensureProfileForAccount(matched, ctx.accountsDirPath);
  if (profile.needsLogin) {
    throw new ExitError(
      `${matched} has no isolated login yet. Run: claude switch profile login ${profile.profileName}`,
    );
  }
  // Record AFTER the needsLogin gate — a refused launch must not register a live
  // session. Isolated → configDir is the profile dir (not null). No fallback proxy
  // on the isolated path (OAuth only — per-profile fallback is later work).
  markSessionLive(ctx.accountsDirPath, { account: matched, configDir: profile.profilePath, cwd: process.cwd() });
  process.stderr.write(`🔑 ${matched} (isolated · --as)\n\n`);
  runClaude(claudeBin, args, { CLAUDE_CONFIG_DIR: profile.profilePath });
}
