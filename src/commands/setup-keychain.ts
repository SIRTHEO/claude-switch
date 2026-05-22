// src/commands/setup-keychain.ts
// `claude switch setup-keychain` — one-time fix for the repeated macOS Keychain
// password dialog on every account swap.
//
// macOS Sierra+ guards each Keychain item with a partition list keyed on the
// accessing binary's code-signing group, on top of the classic ACL. The
// `claude` binary creates `Claude Code-credentials*` with a partition limited
// to Anthropic's team-ID, so `/usr/bin/security` (what we shell out to) is
// outside it and macOS prompts on every read. This command expands the
// partition to `apple-tool:` (Apple-signed CLI tools) so the prompts stop.
// See SECURITY.md "macOS Keychain partition-list prompts".

import { defaultCredentialStore, type CredentialStore, type KeychainItemRef } from '../credential-store.js';

// The minimum partition that lets /usr/bin/security in. Not `apple:` (GUI apps)
// or `unsigned:` (arbitrary unsigned binaries) — both wider than we need.
const DEFAULT_PARTITIONS = 'apple-tool:';

export interface SetupKeychainItemResult extends KeychainItemRef {
  updated: boolean;
}

export interface SetupKeychainResult {
  /** false on non-macOS (or when the Keychain is disabled) — nothing to do. */
  supported: boolean;
  partitions: string;
  items: SetupKeychainItemResult[];
}

/**
 * Core, injectable, no console I/O so it is unit-testable with a fake store.
 * Discovers the Claude OAuth Keychain items and widens each item's partition.
 */
export function runSetupKeychain(
  store: CredentialStore = defaultCredentialStore,
  partitions: string = DEFAULT_PARTITIONS,
): SetupKeychainResult {
  if (!store.available()) return { supported: false, partitions, items: [] };
  const items = store.listOAuthKeychainItems().map((it) => ({
    service: it.service,
    account: it.account,
    updated: store.setPartitionList(it.service, it.account, partitions),
  }));
  return { supported: true, partitions, items };
}

export function handleSetupKeychain(opts: { json: boolean } = { json: false }): void {
  if (!opts.json) {
    // Guidance to stderr so it never lands on stdout (kept clean for scripts);
    // the password prompt from `security` also surfaces on the tty here.
    process.stderr.write(
      'Expanding the Keychain partition list for Claude Code-credentials items.\n' +
        'macOS may ask for your login password (possibly once per item).\n\n',
    );
  }

  const result = runSetupKeychain();

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (!result.supported) {
    console.log('Keychain partition management is macOS-only — nothing to do on this platform.');
    return;
  }
  if (result.items.length === 0) {
    console.log('No Claude Code-credentials Keychain items found.');
    return;
  }
  for (const it of result.items) {
    console.log(`${it.updated ? '✓' : '✗'} ${it.service} (${it.account})`);
  }
  const ok = result.items.filter((i) => i.updated).length;
  console.log(
    `\n${ok}/${result.items.length} item(s) updated.` +
      (ok > 0 ? ' Account swaps should no longer prompt for the Keychain password.' : ''),
  );
}
