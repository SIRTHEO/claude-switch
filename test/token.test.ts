import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTokenHealth } from '../src/token.js';

// Inject a null Keychain reader so these tests exercise the ~/.claude.json
// fallback path, independent of the real macOS Keychain on the test machine.
const noKeychain = () => null;

describe('getTokenHealth', () => {
  let tmpDir: string;
  let claudeJson: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-token-'));
    claudeJson = path.join(tmpDir, '.claude.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "missing" when no accessToken', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.com' }
    }));
    const health = getTokenHealth(claudeJson, noKeychain);
    assert.equal(health.status, 'missing');
  });

  it('returns "present" when accessToken exists but no expiresAt', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.com', accessToken: 'tok123' }
    }));
    const health = getTokenHealth(claudeJson, noKeychain);
    assert.equal(health.status, 'present');
  });

  it('returns "valid" when token not yet expired', () => {
    const futureMs = Date.now() + 3 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.com', accessToken: 'tok', expiresAt: futureMs }
    }));
    const health = getTokenHealth(claudeJson, noKeychain);
    assert.equal(health.status, 'valid');
    assert.ok(health.expiresIn?.includes('day'));
  });

  it('returns "expired" when token past expiresAt', () => {
    const pastMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.com', accessToken: 'tok', expiresAt: pastMs }
    }));
    const health = getTokenHealth(claudeJson, noKeychain);
    assert.equal(health.status, 'expired');
    assert.ok(health.expiresIn?.includes('ago'));
  });

  it('handles ISO date string for expiresAt', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.com', accessToken: 'tok', expiresAt: future }
    }));
    const health = getTokenHealth(claudeJson, noKeychain);
    assert.equal(health.status, 'valid');
  });

  it('returns "missing" when no oauthAccount', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    const health = getTokenHealth(claudeJson, noKeychain);
    assert.equal(health.status, 'missing');
  });

  it('returns "missing" when file does not exist', () => {
    const health = getTokenHealth(path.join(tmpDir, 'nope.json'), noKeychain);
    assert.equal(health.status, 'missing');
  });

  it('uses Keychain when available (macOS)', () => {
    // When a real Keychain reader returns valid data, it should take precedence
    // over the ~/.claude.json fallback.
    const futureMs = Date.now() + 3600 * 1000;
    const mockKeychain = () => ({
      claudeAiOauth: {
        accessToken: 'kc-token',
        refreshToken: 'kc-refresh',
        expiresAt: futureMs,
      },
    });
    // Even if claude.json has no accessToken, Keychain wins.
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'x@y.com' } }));
    const health = getTokenHealth(claudeJson, mockKeychain);
    assert.equal(health.status, 'valid');
  });
});
