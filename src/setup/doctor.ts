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
}

const SEVERITY_RANK: Record<DoctorSeverity, number> = { ok: 0, warn: 1, error: 2 };

function worst(findings: DoctorFinding[]): DoctorSeverity {
  return findings.reduce<DoctorSeverity>(
    (acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc),
    'ok',
  );
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

  // --- snapshot-provenance-mismatch -----------------------------------------
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
