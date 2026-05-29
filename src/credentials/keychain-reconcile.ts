// src/keychain-reconcile.ts
// macOS — drain Claude Code's Keychain item into the file vault (v4.0.0).
//
// The problem this solves: on macOS, Claude Code 2.x writes fresh OAuth tokens
// into the system Keychain (`Claude Code-credentials`) on every `/login` and
// token refresh, and *prefers* the Keychain over `~/.claude/.credentials.json`
// when the item is present. So a file-vault-only claude-switch would (a) go
// stale (it can't see the tokens Claude Code just wrote) and (b) be ignored by
// Claude Code (which reads its Keychain item instead of our file).
//
// Reconcile closes both gaps with one idempotent operation, run once per
// foreground CLI invocation (never on the statusline hot path, never in
// background processes):
//
//   for each Claude-Code OAuth item that exists:
//     read its tokens          → absorb into the file vault (now authoritative)
//     delete the Keychain item  → Claude Code falls back to reading our file
//
// After reconcile the Keychain holds no `Claude Code-credentials` item, the
// file vault has the freshest tokens, and Claude Code reads the file. Swaps
// then touch only files: zero dialogs.
//
// Empirically verified 2026-05-25 on real hardware: read + delete of an item
// freshly created by `/login` (restricted partition list) complete with **no
// password dialog** when the login keychain is unlocked for the session. A
// locked login keychain would prompt once — the honest residual cost.

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import os from 'node:os';
import { FileCredentialStore } from './file-credential-store.js';
import type { KeychainData } from './credential-store.js';

const OAUTH_SERVICE = 'Claude Code-credentials';

/** The account names Claude Code has used for the OAuth item across versions:
 *  the OS username (2.x) and the service name itself (legacy). Reconcile drains
 *  both so an upgrade leaves nothing behind. */
function candidateAccounts(): string[] {
  let username: string;
  try {
    username = process.env.USER || os.userInfo().username;
  } catch { // no passwd entry → default account name
    username = 'claude-code-user';
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) username = 'claude-code-user';
  return [username, OAUTH_SERVICE];
}

/** Narrow exec seam so tests drive reconcile without touching the real
 *  Keychain. Mirrors `SecurityExec` in credential-store.ts. */
export type SecurityExec = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptions,
) => Buffer | string;

interface ReconcileDeps {
  exec?: SecurityExec;
  fileStore?: FileCredentialStore;
}

/** Metadata-only probe (no `-w`) — never raises an auth dialog. Returns true
 *  when the item exists. */
function itemExists(exec: SecurityExec, account: string): boolean {
  try {
    exec('security', ['find-generic-password', '-s', OAUTH_SERVICE, '-a', account], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch { // keychain item absent → treat as not present
    return false;
  }
}

/** Read the encrypted blob. Foreground-only, so a prompt here is acceptable
 *  (the user is present); we skip the whole reconcile under
 *  NO_KEYCHAIN_PROMPT so background processes never reach this. */
function readBlob(exec: SecurityExec, account: string): KeychainData | null {
  try {
    const raw = exec('security', ['find-generic-password', '-s', OAUTH_SERVICE, '-a', account, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'claudeAiOauth' in parsed) {
      return parsed as KeychainData;
    }
  } catch {
    // locked / ACL denial / not JSON → treat as "nothing to absorb"
  }
  return null;
}

function deleteItem(exec: SecurityExec, account: string): void {
  try {
    exec('security', ['delete-generic-password', '-s', OAUTH_SERVICE, '-a', account], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // already gone / locked → leave it; next reconcile retries
  }
}

/**
 * Drain Claude Code's Keychain OAuth item(s) into the file vault, then delete
 * them. Idempotent and best-effort. Returns the number of items absorbed
 * (0 when nothing was present — the common steady-state after the first run).
 *
 * Skipped entirely off-darwin, under the test-mode disable flag, and in
 * background processes (NO_KEYCHAIN_PROMPT) where a prompt could stall a
 * lock-holding detached child.
 */
export function reconcileClaudeCodeKeychain(deps?: ReconcileDeps): number {
  if (process.platform !== 'darwin') return 0;
  if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') return 0;
  if (process.env.CLAUDE_SWITCH_NO_KEYCHAIN_PROMPT === '1') return 0;
  // Opt-in revival of the old Keychain backend disables draining.
  if (process.env.CLAUDE_SWITCH_USE_KEYCHAIN === '1') return 0;

  const exec = deps?.exec ?? (execFileSync as SecurityExec);
  const fileStore = deps?.fileStore ?? new FileCredentialStore();

  let absorbed = 0;
  for (const account of candidateAccounts()) {
    if (!itemExists(exec, account)) continue;
    const blob = readBlob(exec, account);
    if (blob) {
      // Absorb the freshest tokens into the vault BEFORE deleting the item,
      // so a crash between the two leaves the Keychain intact (recoverable)
      // rather than the vault empty (locked out).
      fileStore.writeOAuth(blob);
      absorbed++;
    }
    // Delete whether or not the read produced a usable blob: a corrupt/locked
    // item we couldn't read is still better removed so Claude Code stops
    // preferring it over our (valid) file vault. If the delete itself fails
    // (locked), the next reconcile retries.
    deleteItem(exec, account);
  }
  return absorbed;
}
