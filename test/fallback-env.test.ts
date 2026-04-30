import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fallbackEnvFor } from '../src/fallback-env.js';
import { setFallbackEnabled } from '../src/fallback.js';
import { setApiKey } from '../src/apikey.js';

describe('fallbackEnvFor', () => {
  let dir: string;
  let claudeJson: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fb-env-'));
    claudeJson = path.join(dir, 'claude.json');
    // setApiKey requires an existing account file — seed it for accounts
    // that should "have a key".
    fs.writeFileSync(path.join(dir, 'me@x.com.json'), JSON.stringify({
      emailAddress: 'me@x.com',
    }));
    fs.writeFileSync(path.join(dir, 'other@x.com.json'), JSON.stringify({
      emailAddress: 'other@x.com',
    }));
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when fallback is disabled', () => {
    setApiKey('me@x.com', 'sk-ant-key', dir);
    // Fallback marker absent → null, even if a key is saved.
    assert.strictEqual(fallbackEnvFor('me@x.com', dir), null);
  });

  it('returns null when fallback is on but the account has no key', () => {
    setFallbackEnabled(dir, true);
    // No setApiKey for this account.
    assert.strictEqual(fallbackEnvFor('other@x.com', dir), null);
  });

  it('returns the env additive when fallback is on AND the account has a key', () => {
    setFallbackEnabled(dir, true);
    setApiKey('me@x.com', 'sk-ant-secret-key', dir);
    const env = fallbackEnvFor('me@x.com', dir);
    assert.deepStrictEqual(env, { ANTHROPIC_API_KEY: 'sk-ant-secret-key' });
  });

  it('returns the per-account key — switching accounts switches the injected env', () => {
    setFallbackEnabled(dir, true);
    setApiKey('me@x.com', 'sk-ant-A', dir);
    setApiKey('other@x.com', 'sk-ant-B', dir);
    const a = fallbackEnvFor('me@x.com', dir);
    const b = fallbackEnvFor('other@x.com', dir);
    assert.deepStrictEqual(a, { ANTHROPIC_API_KEY: 'sk-ant-A' });
    assert.deepStrictEqual(b, { ANTHROPIC_API_KEY: 'sk-ant-B' });
  });

  it('does not include any other env vars — only ANTHROPIC_API_KEY', () => {
    setFallbackEnabled(dir, true);
    setApiKey('me@x.com', 'sk-ant-key', dir);
    const env = fallbackEnvFor('me@x.com', dir);
    assert.ok(env);
    assert.deepStrictEqual(Object.keys(env), ['ANTHROPIC_API_KEY']);
  });
});
