import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mirrorActiveOauthVaultIfApplicable,
  persistRefreshedOauth,
  readAccountOauth,
} from '../src/usage/usage-account.js';
import type {
  CredentialStore,
  KeychainData,
  KeychainItemRef,
} from '../src/credentials/credential-store.js';

describe('usage-account token persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-acct-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a persisted refresh wins over the stale _keychain block on the next read', () => {
    // macOS-shaped snapshot: tokens live in _keychain.claudeAiOauth, which
    // readAccountOauth probes BEFORE the top-level fields. If persist only
    // touched the top-level, the stale _keychain token would shadow it and
    // force a re-refresh on every call.
    const file = path.join(dir, 'a@b.com.json');
    fs.writeFileSync(file, JSON.stringify({
      emailAddress: 'a@b.com',
      accessToken: 'old-at',
      _keychain: { claudeAiOauth: { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: 1 } },
    }));

    assert.equal(readAccountOauth('a@b.com', dir)?.accessToken, 'old-at');

    persistRefreshedOauth('a@b.com', dir, {
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      expiresAt: 999,
    });

    const after = readAccountOauth('a@b.com', dir);
    assert.equal(after?.accessToken, 'new-at', 'refreshed token must win over the stale _keychain token');
    assert.equal(after?.refreshToken, 'new-rt');
    assert.equal(after?.expiresAt, 999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mirrorActiveOauthVaultIfApplicable — Phase-24 regression fix
//
// Background. When `refreshUsageForAccount` rotates the OAuth refresh_token
// at Anthropic, the server invalidates the previous refresh_token. Before
// this fix the rotated tokens only landed in the per-account snapshot, while
// the file vault that the running `claude` binary reads
// (`~/.claude/.credentials.json`) kept the now-invalidated refresh_token.
// The binary's next internal refresh would hit 401 → "Please run /login".
// Mirror the refreshed block into the vault for the active account so that
// doesn't happen.
// ─────────────────────────────────────────────────────────────────────────────

/** In-memory CredentialStore stub: captures writeOAuth calls + serves a
 *  configurable readOAuth payload. Only the OAuth surface is exercised, so the
 *  API-key / per-config-dir / Keychain-item methods are inert. */
function makeFakeStore(initial: KeychainData | null = null): {
  store: CredentialStore;
  writes: KeychainData[];
} {
  const writes: KeychainData[] = [];
  let current: KeychainData | null = initial;
  const store: CredentialStore = {
    readOAuth: () => current,
    writeOAuth: (data: KeychainData) => {
      writes.push(JSON.parse(JSON.stringify(data)) as KeychainData);
      current = data;
    },
    readOAuthForConfigDir: () => null,
    writeOAuthForConfigDir: () => {},
    deleteOAuthForConfigDir: () => false,
    available: () => true,
    readApiKey: () => null,
    writeApiKey: () => true,
    deleteApiKey: () => true,
    listOAuthKeychainItems: (): KeychainItemRef[] => [],
    setPartitionList: () => true,
  };
  return { store, writes };
}

/** Write a fake `~/.claude.json` whose `oauthAccount.emailAddress` is `email`,
 *  so `getCurrent(claudeJsonPath)` returns it. */
function seedClaudeJson(dirPath: string, email: string): string {
  const p = path.join(dirPath, 'claude.json');
  fs.writeFileSync(p, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  return p;
}

describe('mirrorActiveOauthVaultIfApplicable', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mirror-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mirrors the refreshed block into the vault when email is the active account', () => {
    const email = 'sirtheo.personal@example.com';
    const claudeJson = seedClaudeJson(dir, email);
    const { store, writes } = makeFakeStore({
      claudeAiOauth: {
        accessToken: 'old-at',
        refreshToken: 'old-rt',
        expiresAt: 1,
        subscriptionType: 'pro',
      },
    });

    mirrorActiveOauthVaultIfApplicable(
      email,
      { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 999 },
      { credentials: store, claudeJsonPath: claudeJson },
    );

    assert.equal(writes.length, 1, 'one write to the vault expected');
    const written = writes[0]!.claudeAiOauth;
    assert.equal(written?.accessToken, 'new-at');
    assert.equal(written?.refreshToken, 'new-rt');
    assert.equal(written?.expiresAt, 999);
    // Preserves metadata the OAuth refresh endpoint doesn't echo (the binary
    // reads `subscriptionType` to pick the API tier).
    assert.equal(written?.subscriptionType, 'pro');
  });

  it('no-ops when email is not the active account', () => {
    const claudeJson = seedClaudeJson(dir, 'sirtheo.work@example.com');
    const { store, writes } = makeFakeStore({
      claudeAiOauth: { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: 1 },
    });

    mirrorActiveOauthVaultIfApplicable(
      'sirtheo.personal@example.com',
      { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 999 },
      { credentials: store, claudeJsonPath: claudeJson },
    );

    assert.equal(writes.length, 0, 'no write — different account is active');
  });

  it('writes a fresh block when the vault was empty', () => {
    const email = 'sirtheo.personal@example.com';
    const claudeJson = seedClaudeJson(dir, email);
    const { store, writes } = makeFakeStore(null);

    mirrorActiveOauthVaultIfApplicable(
      email,
      { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 999 },
      { credentials: store, claudeJsonPath: claudeJson },
    );

    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.claudeAiOauth?.accessToken, 'new-at');
  });

  it('preserves unrelated vault keys (e.g. mcpOAuth) across the mirror write', () => {
    const email = 'sirtheo.personal@example.com';
    const claudeJson = seedClaudeJson(dir, email);
    const { store, writes } = makeFakeStore({
      claudeAiOauth: { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: 1 },
      mcpOAuth: { provider: 'foo', token: 'bar' } as unknown as Record<string, unknown>,
    });

    mirrorActiveOauthVaultIfApplicable(
      email,
      { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 999 },
      { credentials: store, claudeJsonPath: claudeJson },
    );

    assert.deepEqual(writes[0]!.mcpOAuth, { provider: 'foo', token: 'bar' });
  });

  it('no-ops when claude.json is unreadable (no active account to compare)', () => {
    const { store, writes } = makeFakeStore({
      claudeAiOauth: { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: 1 },
    });

    mirrorActiveOauthVaultIfApplicable(
      'sirtheo.personal@example.com',
      { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 999 },
      { credentials: store, claudeJsonPath: path.join(dir, 'does-not-exist.json') },
    );

    assert.equal(writes.length, 0);
  });

  it('swallows a writeOAuth failure — mirror is best-effort', () => {
    const email = 'sirtheo.personal@example.com';
    const claudeJson = seedClaudeJson(dir, email);
    const { store } = makeFakeStore(null);
    store.writeOAuth = () => {
      throw new Error('vault permission denied');
    };

    // Must not throw — the snapshot persist (persistRefreshedOauth) already
    // ran upstream; a vault-write failure leaves Claude Code in the
    // pre-fix behaviour (will hit 401 on next refresh and prompt /login),
    // not in a worse state.
    assert.doesNotThrow(() => {
      mirrorActiveOauthVaultIfApplicable(
        email,
        { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 999 },
        { credentials: store, claudeJsonPath: claudeJson },
      );
    });
  });
});
