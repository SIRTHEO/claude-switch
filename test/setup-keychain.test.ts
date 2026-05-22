// test/setup-keychain.test.ts
// Unit coverage for the `setup-keychain` domain core. runSetupKeychain takes an
// injected CredentialStore, so the orchestration (gate on availability, list →
// map → setPartitionList, partition default) is testable without the real
// macOS `security` CLI.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runSetupKeychain, handleSetupKeychain } from '../src/commands/setup-keychain.js';
import type { CredentialStore, KeychainItemRef } from '../src/credential-store.js';

interface FakeOpts {
  available?: boolean;
  items?: KeychainItemRef[];
  setResult?: (item: KeychainItemRef) => boolean;
}

function fakeStore(opts: FakeOpts): {
  store: CredentialStore;
  setCalls: { service: string; account: string; partitions: string }[];
} {
  const setCalls: { service: string; account: string; partitions: string }[] = [];
  const store: CredentialStore = {
    readOAuth: () => null,
    writeOAuth: () => {},
    readOAuthForConfigDir: () => null,
    writeOAuthForConfigDir: () => {},
    deleteOAuthForConfigDir: () => false,
    available: () => opts.available ?? true,
    readApiKey: () => null,
    writeApiKey: () => false,
    deleteApiKey: () => false,
    listOAuthKeychainItems: () => opts.items ?? [],
    setPartitionList: (service, account, partitions) => {
      setCalls.push({ service, account, partitions });
      return opts.setResult ? opts.setResult({ service, account }) : true;
    },
  };
  return { store, setCalls };
}

describe('runSetupKeychain', () => {
  it('reports unsupported and lists nothing when the store is unavailable', () => {
    const { store, setCalls } = fakeStore({ available: false, items: [{ service: 's', account: 'a' }] });
    const result = runSetupKeychain(store);
    assert.equal(result.supported, false);
    assert.deepEqual(result.items, []);
    assert.equal(setCalls.length, 0); // never touches the keychain when unavailable
  });

  it('expands the partition of every discovered item with the default partition', () => {
    const items = [
      { service: 'Claude Code-credentials', account: 'Claude Code-credentials' },
      { service: 'Claude Code-credentials-2937da2b', account: 'localuser' },
    ];
    const { store, setCalls } = fakeStore({ items });
    const result = runSetupKeychain(store);
    assert.equal(result.supported, true);
    assert.equal(result.partitions, 'apple-tool:');
    assert.deepEqual(
      result.items,
      items.map((it) => ({ ...it, updated: true })),
    );
    assert.deepEqual(setCalls, items.map((it) => ({ ...it, partitions: 'apple-tool:' })));
  });

  it('marks an item not-updated when setPartitionList fails for it', () => {
    const items = [
      { service: 'Claude Code-credentials', account: 'me' },
      { service: 'Claude Code-credentials-x', account: 'me' },
    ];
    const { store } = fakeStore({
      items,
      setResult: (it) => it.service === 'Claude Code-credentials',
    });
    const result = runSetupKeychain(store);
    assert.deepEqual(
      result.items.map((i) => i.updated),
      [true, false],
    );
  });

  it('forwards a custom partition string', () => {
    const { store, setCalls } = fakeStore({ items: [{ service: 's', account: 'a' }] });
    const result = runSetupKeychain(store, 'apple-tool:,apple:');
    assert.equal(result.partitions, 'apple-tool:,apple:');
    assert.equal(setCalls[0]!.partitions, 'apple-tool:,apple:');
  });

  it('supported with no items leaves an empty result', () => {
    const { store } = fakeStore({ items: [] });
    const result = runSetupKeychain(store);
    assert.equal(result.supported, true);
    assert.deepEqual(result.items, []);
  });
});

describe('handleSetupKeychain --json contract', () => {
  let outChunks: string[];
  let errChunks: string[];
  let realOut: typeof process.stdout.write;
  let realErr: typeof process.stderr.write;

  afterEach(() => {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  });

  function capture(): void {
    outChunks = [];
    errChunks = [];
    realOut = process.stdout.write.bind(process.stdout);
    realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => {
      outChunks.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => {
      errChunks.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stderr.write;
  }

  // Under the suite-wide CLAUDE_SWITCH_DISABLE_KEYCHAIN=1, the default store is
  // unavailable, so the handler reports the unsupported/empty shape — the case
  // the GUI must parse without choking.
  it('emits a single clean JSON line on stdout, no human guidance on stderr', () => {
    capture();
    handleSetupKeychain({ json: true });
    const stdout = outChunks.join('');
    // Assert the specific signal (no human banner), not stderr identity: under
    // the suite-wide disable flag, available() emits a one-shot bypass warning
    // to stderr — a test-flag artifact, not json-mode output. (See the "Case A"
    // precedent in .claude/rules/testing.md.)
    assert.ok(
      !errChunks.join('').includes('Expanding the Keychain'),
      'JSON mode must not print the human guidance banner',
    );
    const lines = stdout.trimEnd().split('\n');
    assert.equal(lines.length, 1, 'exactly one JSON line');
    const parsed = JSON.parse(lines[0]!);
    assert.equal(typeof parsed.supported, 'boolean');
    assert.equal(parsed.partitions, 'apple-tool:');
    assert.ok(Array.isArray(parsed.items));
  });
});
