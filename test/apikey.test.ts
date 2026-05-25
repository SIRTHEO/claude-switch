import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getApiKey, setApiKey, removeApiKey, maskApiKey } from '../src/credentials/apikey.js';
import { save, load } from '../src/accounts/accounts.js';

describe('apikey storage', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-apikey-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@b.com' } }));
    save('a@b.com', claudeJson, accDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no key set', () => {
    assert.equal(getApiKey('a@b.com', accDir), null);
  });

  it('saves and reads key', () => {
    setApiKey('a@b.com', 'sk-ant-api03-secret', accDir);
    assert.equal(getApiKey('a@b.com', accDir), 'sk-ant-api03-secret');
  });

  it('preserves key across re-save (status auto-save scenario)', () => {
    setApiKey('a@b.com', 'sk-ant-api03-secret', accDir);
    save('a@b.com', claudeJson, accDir); // simulate `claude switch status` re-save
    assert.equal(getApiKey('a@b.com', accDir), 'sk-ant-api03-secret');
  });

  it('removes key', () => {
    setApiKey('a@b.com', 'sk-ant-api03-secret', accDir);
    assert.equal(removeApiKey('a@b.com', accDir), true);
    assert.equal(getApiKey('a@b.com', accDir), null);
  });

  it('returns false when removing non-existent key', () => {
    assert.equal(removeApiKey('a@b.com', accDir), false);
  });

  it('rejects setting key for unknown account', () => {
    assert.throws(() => setApiKey('nope@x.com', 'sk-ant-x', accDir), /No saved account/);
  });

  it('rejects empty key', () => {
    assert.throws(() => setApiKey('a@b.com', '', accDir), /cannot be empty/);
  });

  it('rejects whitespace-only key as empty', () => {
    assert.throws(() => setApiKey('a@b.com', '   \n  ', accDir), /cannot be empty/);
  });

  it('trims leading/trailing whitespace from pasted keys', () => {
    setApiKey('a@b.com', '  sk-ant-test-key  \n', accDir);
    assert.strictEqual(getApiKey('a@b.com', accDir), 'sk-ant-test-key');
  });

  it('rejects path traversal in email', () => {
    assert.throws(() => setApiKey('../../.bashrc', 'k', accDir), /unsafe for filenames|outside accounts/);
    assert.throws(() => getApiKey('../../.bashrc', accDir), /unsafe for filenames|outside accounts/);
  });

  it('does not leak _apiKey into ~/.claude.json on load', () => {
    setApiKey('a@b.com', 'sk-ant-api03-secret', accDir);
    load('a@b.com', claudeJson, accDir);
    const data = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(data.oauthAccount._apiKey, undefined);
    assert.equal(data._apiKey, undefined);
  });

  it('keeps account file at 0o600 after setApiKey (unix)', () => {
    if (process.platform === 'win32') return;
    setApiKey('a@b.com', 'sk-ant-api03-secret', accDir);
    const stat = fs.statSync(path.join(accDir, 'a@b.com.json'));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe('maskApiKey', () => {
  it('keeps prefix and last 4 chars for long keys', () => {
    assert.equal(maskApiKey('sk-ant-api03-AAAAAABBBBBBCCCCCCDDDD'), 'sk-ant-api03…DDDD');
  });

  it('falls back to ellipsis + last 4 for short keys', () => {
    assert.equal(maskApiKey('short'), '…hort');
  });
});
