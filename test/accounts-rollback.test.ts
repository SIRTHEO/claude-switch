// Error-path test for load()'s Keychain-write rollback (Phase 20.11). When the
// Keychain write fails AFTER claude.json was already rewritten, load() must
// restore claude.json to its FULL pre-load state — not just oauthAccount — so
// the two credential sources don't silently drift. This path is unreachable
// under the global CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 flag (the write is gated on
// it), so the flag is removed for these tests and a fake CredentialStore drives
// the failure deterministically.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { load } from '../src/accounts.js';
import type { CredentialStore, KeychainData } from '../src/credential-store.js';

let dir: string;
let claudeJson: string;
let accDir: string;
let origFlag: string | undefined;

beforeEach(() => {
  // The global test flag gates the Keychain write — drop it so load() reaches
  // the write (and thus the rollback) via the injected fake store.
  origFlag = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
  delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rollback-'));
  claudeJson = path.join(dir, '.claude.json');
  accDir = path.join(dir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
});

afterEach(() => {
  if (origFlag === undefined) delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
  else process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = origFlag;
  fs.rmSync(dir, { recursive: true, force: true });
});

// A CredentialStore whose OAuth write always fails; reads report "no tracked
// key" so the load path purges api-key state (the fields whose drift we assert).
function failingCreds(): CredentialStore {
  return {
    readOAuth: () => null,
    writeOAuth: (_data: KeychainData) => { throw new Error('keychain locked'); },
    readOAuthForConfigDir: () => null,
    writeOAuthForConfigDir: () => {},
    deleteOAuthForConfigDir: () => false,
    available: () => true,
    readApiKey: () => null,
    writeApiKey: () => false,
    deleteApiKey: () => false,
    listOAuthKeychainItems: () => [],
    setPartitionList: () => false,
  };
}

describe('load — Keychain-write rollback (20.11)', () => {
  it('restores the FULL pre-load claude.json when the Keychain write fails', () => {
    // claude.json starts on account A with api-key acceptance state present.
    const original = {
      oauthAccount: { emailAddress: 'a@x.com', accessToken: 'tok-a' },
      apiKey: 'sk-ant-a-injected',
      customApiKeyResponses: { approved: ['hash-a'] },
    };
    fs.writeFileSync(claudeJson, JSON.stringify(original));
    // Target account B carries a _keychain snapshot (keychainRestored=true) so
    // the OAuth write is attempted — and our fake makes it throw.
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({
      emailAddress: 'b@x.com',
      accessToken: 'tok-b',
      _keychain: { claudeAiOauth: { accessToken: 'kc', refreshToken: 'r', expiresAt: 1 } },
    }));

    assert.throws(
      () => load('b@x.com', claudeJson, accDir, { credentials: failingCreds() }),
      /keychain locked/,
    );

    // claude.json must be byte-for-byte the original: oauthAccount A AND its
    // api-key state. The pre-20.11 partial rollback would leave A's oauthAccount
    // but drop apiKey/customApiKeyResponses — a silent disalignment.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(claudeJson, 'utf-8')), original);
  });
});
