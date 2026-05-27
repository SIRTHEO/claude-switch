import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAccountOauth, persistRefreshedOauth } from '../src/usage/usage-account.js';

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
