// src/doctor.ts
// Credential-store health diagnostics — the pure core behind
// `claude switch doctor`. Detects the conditions that silently break a swap
// or freeze the statusline:
//
//   - snapshot-token-collision: two account snapshots share an OAuth
//     accessToken (impossible in healthy state; the swap guard 23.5 rejects
//     the restore, so swaps fail with "no saved credentials").
//   - snapshot-provenance-mismatch: a snapshot's `_capturedFrom.accountUuid`
//     disagrees with its own `accountUuid` (23.6 — poisoned snapshot).
//   - usage-rate-limited: the per-account usage cache is in 429 backoff, so
//     the statusline shows frozen numbers.
//   - keychain-item-present (macOS): Claude Code's Keychain item still exists
//     and would be preferred over the file vault until reconcile drains it.
//
// Pure: callers read the on-disk state and pass it in. No fs / Keychain / clock
// access here, so the decision logic is unit-testable without fakes.

import type { DoctorReport, DoctorFinding, DoctorSeverity } from '../contract.js';

/** Minimal snapshot view doctor needs — a subset of AccountSnapshot. */
export interface DoctorSnapshotView {
  email: string;
  /** oauthAccount.accountUuid from the snapshot (the account it claims to be). */
  accountUuid?: string;
  /** _keychain.claudeAiOauth.accessToken, when the snapshot carries tokens. */
  accessToken?: string;
  /** _capturedFrom.accountUuid (provenance stamp), when present. */
  capturedFromAccountUuid?: string;
  /** organizationRateLimitTier from the snapshot identity — the account's own
   *  plan tier (e.g. 'default_claude_max_5x'), as issued by Anthropic. */
  accountTier?: string;
  /** _keychain.claudeAiOauth.rateLimitTier — the plan tier embedded in the
   *  SAVED token. Must equal accountTier; a mismatch means the snapshot holds a
   *  different account's token. Label-independent (neither value is chosen by
   *  claude-switch — both are issued by Anthropic), so it catches corruption
   *  that the accountUuid/_capturedFrom fields agree on but are wrong about. */
  tokenTier?: string;
}

/** Per-account usage-cache view doctor needs. */
export interface DoctorUsageView {
  email: string;
  /** rateLimitedUntil epoch-ms from the cache, when set. */
  rateLimitedUntil?: number;
}

export interface DoctorInput {
  activeAccount: string | null;
  snapshots: DoctorSnapshotView[];
  usage: DoctorUsageView[];
  /** macOS only: a Claude Code Keychain OAuth item is still present. */
  keychainItemPresent: boolean;
  /** Clock injection for the rate-limit check. */
  now: number;
  /** organizationRateLimitTier of the ACTIVE account (from ~/.claude.json
   *  oauthAccount) — the plan the live label claims to be. */
  activeAccountTier?: string;
  /** rateLimitTier embedded in the LIVE credential token (.credentials.json /
   *  Keychain). Must equal activeAccountTier; a mismatch means the running
   *  session is authenticated as (and billing) a different account than the
   *  label shows. */
  liveTokenTier?: string;
  /** Distinct accounts running GLOBAL-bound (no CLAUDE_CONFIG_DIR) right now,
   *  from the live-session registry. Two or more = token mixing IN PROGRESS:
   *  they share `~/.claude/.credentials.json` and one's refresh invalidates the
   *  other's. Offline signal (no network), safe on the 60s GUI poll. */
  globalBoundLiveAccounts?: string[];
}

const SEVERITY_RANK: Record<DoctorSeverity, number> = { ok: 0, warn: 1, error: 2 };

function worst(findings: DoctorFinding[]): DoctorSeverity {
  return findings.reduce<DoctorSeverity>(
    (acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc),
    'ok',
  );
}

/** Human-readable plan label from an Anthropic tier id
 *  (e.g. 'default_claude_max_5x' → 'max 5x'). */
function planLabel(tier: string): string {
  return tier.replace(/^default_claude_/, '').replace(/_/g, ' ') || tier;
}

/**
 * Run the credential-health diagnostics over already-read on-disk state.
 * Pure and deterministic.
 */
export function diagnose(input: DoctorInput): DoctorReport {
  const findings: DoctorFinding[] = [];

  // --- snapshot-token-collision ---------------------------------------------
  // Group snapshots by accessToken; any token shared by ≥2 snapshots is a
  // collision. Server-issued tokens are account-bound, so a shared token means
  // a save() captured the wrong account's tokens (the bug 23.5 guards against).
  const byToken = new Map<string, string[]>();
  for (const s of input.snapshots) {
    if (!s.accessToken) continue;
    const list = byToken.get(s.accessToken) ?? [];
    list.push(s.email);
    byToken.set(s.accessToken, list);
  }
  for (const [, emails] of byToken) {
    if (emails.length > 1) {
      findings.push({
        code: 'snapshot-token-collision',
        severity: 'error',
        message: `Accounts share one OAuth token: ${emails.sort().join(', ')}. Swapping to any of them fails ("no saved credentials"). Run with --fix to clear the stale tokens and re-login.`,
        fixable: true,
      });
    }
  }

  // --- snapshot-provenance-mismatch + snapshot-token-tier-mismatch ----------
  for (const s of input.snapshots) {
    if (
      s.accountUuid &&
      s.capturedFromAccountUuid &&
      s.accountUuid !== s.capturedFromAccountUuid
    ) {
      findings.push({
        code: 'snapshot-provenance-mismatch',
        severity: 'error',
        message: `Snapshot for ${s.email} holds tokens captured under a different account (${s.capturedFromAccountUuid} ≠ ${s.accountUuid}). Run with --fix to clear it.`,
        fixable: true,
      });
    }

    // The plan tier is issued by Anthropic into BOTH the account identity
    // (organizationRateLimitTier) and the OAuth token (rateLimitTier). If the
    // saved token's tier disagrees with the snapshot's own account tier, the
    // snapshot holds a different account's token — even when accountUuid and
    // _capturedFrom are internally consistent (the exact hole that let a 5x
    // account file a 20x token undetected). Both fields must be present to
    // compare: a legacy snapshot lacking either is left untouched.
    if (s.accountTier && s.tokenTier && s.accountTier !== s.tokenTier) {
      findings.push({
        code: 'snapshot-token-tier-mismatch',
        severity: 'error',
        message: `Saved login for ${s.email} holds a token from a different plan (token=${planLabel(s.tokenTier)}, account=${planLabel(s.accountTier)}) — it belongs to another account. Run with --fix to clear it, then re-login ${s.email}.`,
        fixable: true,
      });
    }
  }

  // --- active-token-tier-mismatch -------------------------------------------
  // Same tier invariant applied to the LIVE session: if the active account's
  // tier disagrees with the live token's tier, the running session is signed
  // in as (and billing) a different account than the label shows. This is the
  // loudest, most user-facing signal — it fires even when every snapshot is
  // internally consistent.
  //
  // Caveat: tier distinguishes plans (5x / 20x / pro), NOT same-tier accounts.
  // Two same-tier accounts mislabelled would pass every local check — the token
  // is opaque and carries no account id, so a same-tier swap can only be caught
  // by a network identity check. NOT auto-fixable: doctor must never clear a
  // live session's credentials; the user re-authenticates the account.
  if (
    input.activeAccountTier &&
    input.liveTokenTier &&
    input.activeAccountTier !== input.liveTokenTier
  ) {
    const who = input.activeAccount ?? 'the active account';
    findings.push({
      code: 'active-token-tier-mismatch',
      severity: 'error',
      message: `Active session is mislabelled: ${who} is a ${planLabel(input.activeAccountTier)} plan, but the live login token is a ${planLabel(input.liveTokenTier)} plan — you are signed in (and billing) a DIFFERENT account than the label shows. Re-authenticate ${who}: switch to it and log in again. (--fix cannot touch a live session.)`,
      fixable: false,
    });
  }

  // --- live-account-mixing --------------------------------------------------
  // Two or more DIFFERENT accounts running global-bound at the same time share
  // the one `~/.claude/.credentials.json`: each session's internal token
  // refresh rotates the shared refresh_token, invalidating the others ("one
  // token good, the other bad" → /login). This is mixing happening NOW, caught
  // from the live-session registry — offline, so it stays on the silent poll
  // path. Not auto-fixable: doctor must never kill a live session; the user
  // relaunches the extra account(s) isolated (a profile/overlay).
  const distinctGlobal = [...new Set(input.globalBoundLiveAccounts ?? [])].sort();
  if (distinctGlobal.length > 1) {
    findings.push({
      code: 'live-account-mixing',
      severity: 'error',
      message:
        `${distinctGlobal.length} accounts are running at once on the shared global login ` +
        `(${distinctGlobal.join(', ')}). They overwrite each other's tokens — a session will ` +
        `drop to "Please run /login". Relaunch all but one isolated: open each extra account ` +
        `via its profile/overlay (\`claude switch sessions\` shows them).`,
      fixable: false,
    });
  }

  // --- usage-rate-limited ---------------------------------------------------
  // A cache in 429 backoff freezes the statusline numbers. Warn (not error):
  // it self-heals when the backoff expires, but the user sees stale data now.
  for (const u of input.usage) {
    if (u.rateLimitedUntil && u.rateLimitedUntil > input.now) {
      const mins = Math.ceil((u.rateLimitedUntil - input.now) / 60000);
      findings.push({
        code: 'usage-rate-limited',
        severity: 'warn',
        message: `Usage cache for ${u.email} is rate-limited for ~${mins}m; the statusline shows frozen numbers until then. Run with --fix to clear the backoff and let the next refresh retry.`,
        fixable: true,
      });
    }
  }

  // --- keychain-item-present (macOS) ----------------------------------------
  // Informational: reconcile drains it on the next foreground command, so it's
  // a warn (not error) — Claude Code would prefer it over the vault until then.
  if (input.keychainItemPresent) {
    findings.push({
      code: 'keychain-item-present',
      severity: 'warn',
      message: 'A Claude Code Keychain credential item is still present; it will be drained into the file vault on the next claude-switch command. No action needed.',
      fixable: false,
    });
  }

  return {
    status: worst(findings),
    activeAccount: input.activeAccount,
    findings,
    keychainItemPresent: input.keychainItemPresent,
  };
}
