// test/apikey-keychain.test.ts
// macOS-only end-to-end coverage for the Keychain backend. Hits the
// real `security` CLI under a unique service name so the suite never
// touches the user's actual `claude-switch-apikey` entries.
//
// Skipped on non-macOS and when CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 (the
// default for the rest of the suite). Toggle in via env to run:
//   CLAUDE_SWITCH_DISABLE_KEYCHAIN=0 npm test -- --test-only

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { save } from '../src/accounts.js';
import {
  getApiKey,
  setApiKey,
  removeApiKey,
  migrateApiKeysToKeychain,
} from '../src/apikey.js';

const macAndEnabled =
  process.platform === 'darwin' && process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN !== '1';

describe('apikey storage — macOS Keychain backend', { skip: !macAndEnabled }, () => {
  // Use a tagged email so collisions with prior runs are impossible —
  // the Keychain is global across test invocations.
  const email = `cs-test-${process.pid}-${Date.now()}@example.com`;
  let tmpDir: string;
  let accDir: string;
  let claudeJson: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-kc-'));
    accDir = path.join(tmpDir, 'accounts');
    claudeJson = path.join(tmpDir, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
    save(email, claudeJson, accDir);
  });

  after(() => {
    // Best-effort cleanup so a crashed test doesn't leak entries into
    // the developer's login Keychain.
    try {
      execFileSync('security', ['delete-generic-password', '-s', 'claude-switch-apikey', '-a', email], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a key through the Keychain (no _apiKey in JSON)', () => {
    setApiKey(email, 'sk-ant-keychain-test', accDir);
    assert.equal(getApiKey(email, accDir), 'sk-ant-keychain-test');

    const data = JSON.parse(fs.readFileSync(path.join(accDir, `${email}.json`), 'utf-8'));
    assert.equal(data._apiKey, undefined, 'JSON _apiKey must not be set when Keychain is the primary backend');
  });

  it('removeApiKey deletes the Keychain entry', () => {
    setApiKey(email, 'sk-ant-removeme', accDir);
    assert.equal(removeApiKey(email, accDir), true);
    assert.equal(getApiKey(email, accDir), null);
  });

  it('migrateApiKeysToKeychain copies legacy _apiKey then getApiKey reads from Keychain', () => {
    // Plant a v3.x-style account file with plaintext _apiKey.
    const file = path.join(accDir, `${email}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    data._apiKey = 'sk-ant-legacy';
    fs.writeFileSync(file, JSON.stringify(data));

    // Pre-condition: Keychain entry absent (after-hook of previous test
    // already removed it; double-remove for safety).
    try {
      execFileSync('security', ['delete-generic-password', '-s', 'claude-switch-apikey', '-a', email], { stdio: 'ignore' });
    } catch { /* not present */ }

    const migrated = migrateApiKeysToKeychain(accDir);
    assert.ok(migrated >= 1, 'migration should report at least one account moved');

    // Now mutate the JSON to a different value and confirm reads come
    // from the Keychain — proves Keychain wins over the lingering JSON.
    const data2 = JSON.parse(fs.readFileSync(file, 'utf-8'));
    data2._apiKey = 'sk-ant-stale-json';
    fs.writeFileSync(file, JSON.stringify(data2));

    assert.equal(getApiKey(email, accDir), 'sk-ant-legacy');
  });
});
