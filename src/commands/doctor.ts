// src/commands/doctor.ts
// `claude switch doctor [--json] [--fix]`
//
// Credential-store health check. Reads the on-disk state (account snapshots,
// per-account usage caches, the macOS Keychain item presence) and runs the
// pure `diagnose()` core to surface the conditions that silently break a swap
// or freeze the statusline. The GUI consumes `--json`; `--fix` remediates the
// fixable findings (clears poisoned snapshot tokens + rate-limit backoff so the
// next login/refresh repopulates cleanly).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getCurrent, list as listAccounts } from '../accounts/accounts.js';
import { fsAccountRepo } from '../accounts/account-repository.js';
import { diagnose, type DoctorSnapshotView, type DoctorUsageView } from '../setup/doctor.js';
import { globalBoundSessions, listLiveSessions } from '../sessions/session-registry.js';
import type { DoctorReport } from '../contract.js';

interface DoctorOptions {
  json: boolean;
  fix: boolean;
}

/** Pull the doctor-relevant fields out of a parsed snapshot. */
function snapshotView(email: string, raw: Record<string, unknown> | null): DoctorSnapshotView {
  const oauth = (raw?._keychain as { claudeAiOauth?: { accessToken?: unknown; rateLimitTier?: unknown } } | undefined)
    ?.claudeAiOauth;
  const accountUuid = raw?.accountUuid;
  const capturedFrom = (raw?._capturedFrom as { accountUuid?: unknown } | undefined)?.accountUuid;
  const accountTier = raw?.organizationRateLimitTier;
  return {
    email,
    accountUuid: typeof accountUuid === 'string' ? accountUuid : undefined,
    accessToken: typeof oauth?.accessToken === 'string' ? oauth.accessToken : undefined,
    capturedFromAccountUuid: typeof capturedFrom === 'string' ? capturedFrom : undefined,
    accountTier: typeof accountTier === 'string' ? accountTier : undefined,
    tokenTier: typeof oauth?.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined,
  };
}

/** Read every per-account usage cache file's rate-limit state. */
function readUsageViews(accountsDirPath: string, emails: string[]): {
  views: DoctorUsageView[];
  files: string[];
} {
  const views: DoctorUsageView[] = [];
  const files: string[] = [];
  for (const file of safeReaddir(accountsDirPath)) {
    if (!file.startsWith('.usage-cache.') || !file.endsWith('.json')) continue;
    const full = path.join(accountsDirPath, file);
    try {
      const c = JSON.parse(fs.readFileSync(full, 'utf-8')) as {
        account?: unknown;
        rateLimitedUntil?: unknown;
      };
      const email = typeof c.account === 'string' ? c.account : '(unknown)';
      const rl = typeof c.rateLimitedUntil === 'number' ? c.rateLimitedUntil : undefined;
      views.push({ email, rateLimitedUntil: rl });
      if (rl) files.push(full);
    } catch {
      // corrupt cache → ignore for diagnosis (a separate concern)
    }
  }
  // Suppress unused-param lint while keeping the signature symmetric with the
  // snapshot reader (emails may drive a future per-account filter).
  void emails;
  return { views, files };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return []; // dir missing → no caches
  }
}

/** macOS only: is a Claude Code OAuth Keychain item still present? Metadata
 *  probe (no `-w`) so it never raises a dialog. */
function keychainItemPresent(): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') return false;
  const accounts = [process.env.USER || os.userInfo().username, 'Claude Code-credentials'];
  for (const a of accounts) {
    try {
      execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-a', a], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      // not present under this account name → try next
    }
  }
  return false;
}

/** Read the live plan tiers prompt-free from on-disk config + the file vault.
 *  `activeAccountTier` is the active account's own tier (~/.claude.json
 *  oauthAccount); `liveTokenTier` is the tier embedded in the live token in the
 *  file-vault `.credentials.json` next to it. Read the file DIRECTLY (not via
 *  the CredentialStore) so a Keychain-backed store can never raise a password
 *  prompt — doctor is polled by the GUI every 60s and must stay silent. In a
 *  Keychain-only setup the file is absent and `liveTokenTier` stays undefined,
 *  so the active-tier check simply doesn't fire (legacy/degrade-safe). */
function readLiveTiers(claudeJsonPath: string): { activeAccountTier?: string; liveTokenTier?: string } {
  let activeAccountTier: string | undefined;
  try {
    const cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as {
      oauthAccount?: { organizationRateLimitTier?: unknown };
    };
    if (typeof cj.oauthAccount?.organizationRateLimitTier === 'string') {
      activeAccountTier = cj.oauthAccount.organizationRateLimitTier;
    }
  } catch { /* missing/corrupt claude.json → no active tier to compare */ }

  let liveTokenTier: string | undefined;
  try {
    const credFile = path.join(path.dirname(claudeJsonPath), '.claude', '.credentials.json');
    const cred = JSON.parse(fs.readFileSync(credFile, 'utf-8')) as {
      claudeAiOauth?: { rateLimitTier?: unknown };
    };
    if (typeof cred.claudeAiOauth?.rateLimitTier === 'string') {
      liveTokenTier = cred.claudeAiOauth.rateLimitTier;
    }
  } catch { /* no file-vault creds (Keychain-only / logged out) → no live tier */ }

  return { activeAccountTier, liveTokenTier };
}

/** Build the report from live on-disk state. */
function buildReport(claudeJsonPath: string, accountsDirPath: string, now: number): {
  report: DoctorReport;
  rateLimitedCacheFiles: string[];
} {
  let active: string | null;
  try {
    active = getCurrent(claudeJsonPath) || null;
  } catch { // no resolvable active account → report none
    active = null;
  }
  const emails = listAccounts(accountsDirPath);
  const snapshots = emails.map(e => snapshotView(e, fsAccountRepo.read(e, accountsDirPath)));
  const { views, files } = readUsageViews(accountsDirPath, emails);
  const { activeAccountTier, liveTokenTier } = readLiveTiers(claudeJsonPath);
  // Live-session registry (offline, prune-on-read): the accounts running
  // global-bound right now. Two or more distinct = token mixing in progress.
  const globalBoundLiveAccounts = globalBoundSessions(listLiveSessions(accountsDirPath))
    .map((s) => s.account)
    .filter((a): a is string => a !== null);
  const report = diagnose({
    activeAccount: active,
    snapshots,
    usage: views,
    keychainItemPresent: keychainItemPresent(),
    now,
    activeAccountTier,
    liveTokenTier,
    globalBoundLiveAccounts,
  });
  return { report, rateLimitedCacheFiles: files };
}

/**
 * Remediate the fixable findings:
 *   - collision / provenance-mismatch → strip `_keychain` + `_capturedFrom`
 *     from the offending snapshots (tokens are cache; next login repopulates).
 *   - rate-limited usage cache → delete the cache file (next refresh retries).
 * The Keychain item, if present, is drained by reconcile on the next command —
 * not doctor's job. Returns a short list of actions taken.
 */
function applyFix(
  report: DoctorReport,
  accountsDirPath: string,
  rateLimitedCacheFiles: string[],
): string[] {
  const actions: string[] = [];
  const codes = new Set(report.findings.map(f => f.code));

  if (
    codes.has('snapshot-token-collision') ||
    codes.has('snapshot-provenance-mismatch') ||
    codes.has('snapshot-token-tier-mismatch')
  ) {
    // Strip token cache from EVERY snapshot — safe and simple: tokens are
    // regenerable on next login, and a partial strip could leave a residual
    // collision. The active account repopulates on the next reconcile; others
    // on their next login.
    for (const email of listAccounts(accountsDirPath)) {
      const raw = fsAccountRepo.read(email, accountsDirPath);
      if (raw && ('_keychain' in raw || '_capturedFrom' in raw)) {
        delete raw._keychain;
        delete raw._capturedFrom;
        fsAccountRepo.write(email, accountsDirPath, raw as never);
        actions.push(`cleared stale tokens from snapshot: ${email}`);
      }
    }
  }

  for (const file of rateLimitedCacheFiles) {
    try {
      fs.unlinkSync(file);
      actions.push(`cleared rate-limited usage cache: ${path.basename(file)}`);
    } catch {
      // already gone → nothing to do
    }
  }

  return actions;
}

export function handleDoctor(
  ctx: { claudeJsonPath: string; accountsDirPath: string },
  opts: DoctorOptions,
  deps?: { now?: () => number },
): void {
  const now = (deps?.now ?? Date.now)();
  const { report, rateLimitedCacheFiles } = buildReport(ctx.claudeJsonPath, ctx.accountsDirPath, now);

  if (opts.fix) {
    const actions = applyFix(report, ctx.accountsDirPath, rateLimitedCacheFiles);
    if (opts.json) {
      // Re-diagnose post-fix so the GUI sees the resulting state.
      const after = buildReport(ctx.claudeJsonPath, ctx.accountsDirPath, now).report;
      process.stdout.write(`${JSON.stringify({ ...after, fixed: actions })}\n`);
      return;
    }
    if (actions.length === 0) {
      process.stdout.write('Nothing to fix — credential store is healthy.\n');
    } else {
      process.stdout.write(`Fixed ${actions.length} issue(s):\n`);
      for (const a of actions) process.stdout.write(`  • ${a}\n`);
      process.stdout.write('\nRe-login the affected account(s) to repopulate fresh tokens.\n');
    }
    return;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  // Human-readable
  const icon = (s: string): string => (s === 'error' ? '✗' : s === 'warn' ? '⚠' : '✓');
  process.stdout.write(`Credential store: ${icon(report.status)} ${report.status}\n`);
  process.stdout.write(`Active account: ${report.activeAccount ?? '(none)'}\n`);
  if (report.findings.length === 0) {
    process.stdout.write('No issues found.\n');
    return;
  }
  process.stdout.write('\nFindings:\n');
  for (const f of report.findings) {
    process.stdout.write(`  ${icon(f.severity)} [${f.code}] ${f.message}\n`);
  }
  const anyFixable = report.findings.some(f => f.fixable);
  if (anyFixable) {
    process.stdout.write('\nRun `claude switch doctor --fix` to remediate the fixable issues.\n');
  }
}
