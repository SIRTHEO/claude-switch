// src/sessions/migrate-session.ts
// Live-migration writer — re-point a RUNNING isolated claude session from its
// current account to a different one WITHOUT a restart.
//
// Mechanism (experiment-confirmed on claude v2.1.158, file-only): claude
// re-reads its per-config-dir credential file between requests, so rewriting a
// running session's private `<configDir>/.credentials.json` (token) AND
// `<configDir>/.claude.json` `oauthAccount` (identity) in lockstep is adopted on
// the session's NEXT turn — no proxy, no relaunch. Both files because the new
// token belongs to a DIFFERENT identity than the old metadata; a token/identity
// mismatch can trip the binary's own consistency check (the same one
// claude-switch enforces in `accounts-load.ts`).
//
// HARD INVARIANT — only an ISOLATED session may be migrated. The unified model
// freezes `~/.claude` as the "default" account and re-points a pointer instead
// of overwriting it; rewriting the GLOBAL config dir live would corrupt that
// frozen default. `migrateSession` refuses a null/global configDir outright.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import { withLock } from '../platform/lock.js';
import {
  type ClaudeAiOauth,
  type CredentialStore,
  defaultCredentialStore,
} from '../credentials/credential-store.js';
import { embedTokensInIdentity, profileKeychainTrustedBins } from '../profiles/profiles-credentials.js';
import { effectiveAccount, listLiveSessions, setCurrentAccountForConfigDir } from './session-registry.js';

export interface MigrateResult {
  target: string;
  configDir: string;
  /** True when the session already ran the target identity — nothing rewritten. */
  noop: boolean;
}

/** How `migrateSession` resolves (and mints on demand) the target profile.
 *  Defaults to `ensureProfileForAccount`; injectable so tests don't run the
 *  real legacy-snapshot refresh / network path. Internal — tests pass `deps`
 *  as an object literal, structurally checked, so this name needn't be exported. */
type EnsureProfileFn = (
  email: string,
  accountsDirPath: string,
) => Promise<{ profilePath: string; needsLogin: boolean }>;

interface MigrateDeps {
  credentials?: CredentialStore;
  ensureProfile?: EnsureProfileFn;
  /** Force the storage branch (token in the vault file vs embedded inline in
   *  oauthAccount). Defaults to the production compute (darwin + vault enabled).
   *  Tests set it true to exercise the vault branch under DISABLE_KEYCHAIN. */
  useKeychain?: boolean;
}

/** Read+parse a JSON object from `file`; null on absent / unreadable / non-object
 *  (callers treat that as "no config there"). */
function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // missing / corrupt / not an object → no config
  }
}

/** The `emailAddress` currently in `<configDir>/.claude.json` oauthAccount,
 *  or null when absent — used for the same-account no-op short-circuit. */
function currentIdentityEmail(configDir: string): string | null {
  const oauth = readJsonObject(path.join(configDir, '.claude.json'))?.oauthAccount as
    | Record<string, unknown>
    | undefined;
  return oauth && typeof oauth.emailAddress === 'string' ? oauth.emailAddress : null;
}

/**
 * Resolve the target's canonical identity + OAuth token from ITS profile — the
 * SAME source `claude switch profile use <target>` reads, so a migrated session
 * and a fresh launch of the target agree on the token (no two-copies divergence
 * that would share one server-side refresh_token).
 *
 *  - identity: `<profilePath>/.claude.json` oauthAccount, stripped of any token
 *    fields (those are not identity).
 *  - token: the per-config-dir vault (`readOAuthForConfigDir`) on the default
 *    file-vault path; falls back to the inline tokens embedded in oauthAccount
 *    when the vault read returns null (DISABLE_KEYCHAIN / non-darwin import).
 */
function resolveTargetFromProfile(
  profilePath: string,
  credentials: CredentialStore,
): { identity: Record<string, unknown>; oauth: ClaudeAiOauth | null } {
  const oauthBlock = (readJsonObject(path.join(profilePath, '.claude.json'))?.oauthAccount as
    | Record<string, unknown>
    | undefined) ?? {};
  const { accessToken, refreshToken, expiresAt, ...identity } = oauthBlock;

  let oauth = credentials.readOAuthForConfigDir(profilePath)?.claudeAiOauth ?? null;
  if (!oauth && typeof accessToken === 'string') {
    oauth = {
      accessToken,
      refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
      expiresAt: typeof expiresAt === 'number' || typeof expiresAt === 'string' ? expiresAt : 0,
    };
  }
  return { identity, oauth };
}

/**
 * Migrate the running session whose private config dir is `configDir` to
 * account `target`. Returns `{ noop: true }` when the session already ran the
 * target identity. Throws (never silently no-ops) when the migration is unsafe:
 * a global-bound configDir, a target that needs login, a target already live
 * elsewhere, or a target with no usable token.
 *
 * `accountsDirPath` roots the live-session registry + the lock; `deps` injects
 * the credential store and the profile resolver for tests.
 */
export async function migrateSession(
  target: string,
  configDir: string,
  accountsDirPath: string,
  deps: MigrateDeps = {},
): Promise<MigrateResult> {
  const credentials = deps.credentials ?? defaultCredentialStore;

  // Guard 1 — refuse a global-bound configDir. Rewriting `~/.claude` live would
  // overwrite the frozen "default" account the re-point model never touches.
  const globalConfigDir = path.dirname(accountsDirPath); // ~/.claude
  if (!configDir || path.resolve(configDir) === path.resolve(globalConfigDir)) {
    throw new Error(
      'Refusing to migrate a global-bound session: only an isolated session ' +
        '(its own CLAUDE_CONFIG_DIR) can be live-migrated. The global ~/.claude ' +
        'account is frozen by the unified model.',
    );
  }

  // Guard 1.5 — refuse a configDir inside the canonical profiles tree
  // (`~/.claude/profiles/<name>`). A session must run in a per-session WORK DIR
  // (`session-dirs/<profile>.<pid>`, OUTSIDE the profiles tree), seeded from the
  // canonical — never in the canonical store itself, which doubles as the
  // account's credential vault. Rewriting the canonical would corrupt the account
  // (a later `profile use <name>` would launch the wrong identity = token mixing).
  // Work dirs pass this guard; a session still bound to the canonical (e.g. the
  // deferred "open in new terminal" path) is refused. This is the writer-level
  // defence — the `migrate` command surface stays disabled (handleMigrate →
  // notAvailable) until step (e). The profiles root mirrors sessions.ts.
  const profilesRoot = path.resolve(path.join(globalConfigDir, 'profiles'));
  const resolvedConfig = path.resolve(configDir);
  if (resolvedConfig === profilesRoot || resolvedConfig.startsWith(profilesRoot + path.sep)) {
    throw new Error(
      'Refusing to migrate a session bound to its account\'s canonical profile ' +
        'directory — that would corrupt the account. Only a per-session work dir ' +
        'can be migrated.',
    );
  }

  // Resolve (mint on demand) the target profile; refuse if it has no creds.
  const ensure: EnsureProfileFn = deps.ensureProfile ?? (async (email, dir) => {
    const { ensureProfileForAccount } = await import('../profiles/profiles.js');
    const r = await ensureProfileForAccount(email, dir);
    return { profilePath: r.profilePath, needsLogin: r.needsLogin };
  });
  const resolved = await ensure(target, accountsDirPath);
  if (resolved.needsLogin) {
    throw new Error(
      `Target account ${target} has no stored credentials. ` +
        `Log it in first: claude switch profile login ${target}`,
    );
  }

  const { identity, oauth } = resolveTargetFromProfile(resolved.profilePath, credentials);
  if (!oauth) {
    throw new Error(`Target account ${target} resolved but no usable OAuth token was found in its profile.`);
  }

  const targetProfileResolved = path.resolve(resolved.profilePath);
  const thisConfigResolved = path.resolve(configDir);
  const useKeychain = deps.useKeychain
    ?? (process.platform === 'darwin' && process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN !== '1');

  // The conflict re-check + the file rewrites run under the accounts-dir lock so
  // a concurrent launch (markSessionLive also takes this lock) cannot bring the
  // target live in the window between the check and the write. The async profile
  // resolve above is deliberately OUTSIDE the lock (the lock is sync and cannot
  // span a network refresh).
  return withLock(accountsDirPath, () => {
    // No-op short-circuit: this session already runs the target identity.
    if (currentIdentityEmail(configDir) === target) {
      return { target, configDir, noop: true };
    }

    // Guard 2 — refuse if the target is already LIVE elsewhere. Two live copies
    // of one account share Anthropic's single server-side refresh_token, so one
    // rotation invalidates the other (the unified model's hard edge). The primary
    // signal is a live session SPAWNED as the target. (The configDir-is-target's-
    // profile branch is now rare: sessions run in per-session work dirs, not the
    // canonical profile dir — it only fires for a session still bound to the
    // canonical, e.g. the deferred open-in-new-terminal path.)
    //
    // KNOWN GAP (closed by the `currentAccount` producer, step (d)): the registry
    // records the SPAWNED `account`, not the CURRENT one, so a session previously
    // migrated TO the target still reports its old account and a second
    // migrate-to-target from another terminal won't see it here. Until then this
    // catches the common cases (spawned-as-target / canonical-bound-target).
    const live = listLiveSessions(accountsDirPath);
    const conflict = live.some((s) => {
      if (s.configDir && path.resolve(s.configDir) === thisConfigResolved) return false; // the migrating session itself
      if (effectiveAccount(s) === target) return true; // target live elsewhere now (post-migration too)
      return s.configDir != null && path.resolve(s.configDir) === targetProfileResolved; // target's profile live
    });
    if (conflict) {
      throw new Error(
        `Target account ${target} is already live in another session. ` +
          `Free it first — two concurrent sessions of the same account corrupt ` +
          `each other's tokens (they share one server-side refresh token).`,
      );
    }

    // Rewrite the session's private files: BOTH token AND identity, in lockstep.
    // Order: vault write first, then .claude.json. If the second write throws
    // (rare — writeJsonAtomic on an isolated dir), the session is left with the
    // new token + old identity (a token/identity mismatch); re-running migrate
    // converges it. Acceptable for v1 on an isolated session; documented here.
    let oauthAccount: Record<string, unknown>;
    if (useKeychain) {
      // Default file-vault path: token → <configDir>/.credentials.json; the
      // identity block stays metadata-only (claude reads the token from the file).
      // Pass the trusted-bins ACL hint matching importProfileFromAccount — a
      // no-op for the file vault, but load-bearing under the opt-in macOS
      // Keychain backend (without -T <claude> the upserted entry's ACL would
      // exclude the real claude binary and the migrated session couldn't re-read
      // its own credential).
      credentials.writeOAuthForConfigDir(configDir, { claudeAiOauth: oauth }, profileKeychainTrustedBins());
      oauthAccount = { ...identity };
    } else {
      // DISABLE_KEYCHAIN / non-darwin: no vault file → embed the token inline.
      oauthAccount = embedTokensInIdentity(identity, oauth);
    }

    // Preserve every other key in the live session's .claude.json (userID,
    // hasCompletedOnboarding, project trust, …); only the identity is replaced.
    const claudeJsonFile = path.join(configDir, '.claude.json');
    const cfg = readJsonObject(claudeJsonFile) ?? {};
    cfg.oauthAccount = oauthAccount;
    writeJsonAtomic(claudeJsonFile, cfg);

    // Record the new current account in the live registry (under this lock) so a
    // later conflict check — and the cruscotto's spawned-vs-current view — see
    // what this session speaks as now. No-op if the session isn't registered.
    setCurrentAccountForConfigDir(accountsDirPath, configDir, target);

    // NOTE — mirror-back is not yet wired (a follow-up change). Until then: if
    // this session later rotates the target's token in-process, the rotated
    // token lands in <configDir>/.credentials.json but the target's CANONICAL
    // profile vault stays stale → directly relaunching the target may 401 until
    // its next refresh. Single-session correctness holds; the cross-launch
    // staleness is the documented gap the mirror-back step closes.

    return { target, configDir, noop: false };
  });
}
