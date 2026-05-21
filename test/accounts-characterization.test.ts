// Characterization tests for the on-disk side-effects of the account
// save/load/remove flow. Unlike accounts.test.ts (which asserts individual
// behaviours), these pin the FULL directory state to a golden so the upcoming
// CredentialStore (20.7) + AccountRepository (20.8) extraction cannot silently
// change what lands on disk. If a golden here changes, the refactor altered an
// observable side-effect and the diff must be justified.
//
// All scenarios run with CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 so the JSON-only
// path is exercised deterministically without touching the real Keychain.
//
// OUT OF SCOPE (named per the project anti-skip rule): the load() rollback on
// a *failed Keychain write* is not characterized here — accounts.ts imports
// writeKeychain directly, so there is no injection seam until the
// CredentialStore port (20.7a) exists. Re-add a rollback golden once load()
// takes the credential store via deps.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { save, load, remove } from '../src/accounts.js';

let dir: string;
let claudeJson: string;
let accDir: string;
let prevDisable: string | undefined;

beforeEach(() => {
  prevDisable = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
  process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-char-'));
  claudeJson = path.join(dir, '.claude.json');
  accDir = path.join(dir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
});

afterEach(() => {
  if (prevDisable === undefined) delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
  else process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = prevDisable;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Golden snapshot of an accounts dir: every file mapped to its parsed JSON
 *  (or raw text), keys sorted for stable comparison. */
function snapshotDir(target: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fs.readdirSync(target).sort()) {
    const full = path.join(target, f);
    if (fs.statSync(full).isDirectory()) continue;
    const raw = fs.readFileSync(full, 'utf-8');
    try { out[f] = JSON.parse(raw); } catch { out[f] = raw; }
  }
  return out;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('characterization — account save side-effects', () => {
  it('oauth account: snapshots oauthAccount + api-key acceptance state', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'oauth@x.com', accessToken: 'tok-1', expiresAt: 123 },
      customApiKeyResponses: { approved: ['hash-abc'] },
      apiKey: 'sk-ant-from-claude-json',
    }));

    save('oauth@x.com', claudeJson, accDir);

    assert.deepStrictEqual(snapshotDir(accDir), {
      'oauth@x.com.json': {
        emailAddress: 'oauth@x.com',
        accessToken: 'tok-1',
        expiresAt: 123,
        _customApiKeyResponses: { approved: ['hash-abc'] },
        _claudeJsonApiKey: 'sk-ant-from-claude-json',
      },
    });
  });

  it('api-key account: preserves existing _apiKey and _prefs across re-save', () => {
    // Pre-existing snapshot carrying a per-account fallback key + prefs.
    fs.writeFileSync(path.join(accDir, 'key@x.com.json'), JSON.stringify({
      emailAddress: 'key@x.com',
      _apiKey: 'sk-ant-account-fallback',
      _prefs: { theme: 'dark' },
    }));
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'key@x.com', accessToken: 'tok-new' },
    }));

    save('key@x.com', claudeJson, accDir);

    assert.deepStrictEqual(snapshotDir(accDir), {
      'key@x.com.json': {
        emailAddress: 'key@x.com',
        accessToken: 'tok-new',
        _apiKey: 'sk-ant-account-fallback',
        _prefs: { theme: 'dark' },
      },
    });
  });

  it('preserves an existing _keychain snapshot block under the disable flag', () => {
    fs.writeFileSync(path.join(accDir, 'kc@x.com.json'), JSON.stringify({
      emailAddress: 'kc@x.com',
      _keychain: { service: 'Claude Code-credentials', account: 'u', value: '{}' },
    }));
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'kc@x.com', accessToken: 'tok-2' },
    }));

    save('kc@x.com', claudeJson, accDir);

    assert.deepStrictEqual(snapshotDir(accDir), {
      'kc@x.com.json': {
        emailAddress: 'kc@x.com',
        accessToken: 'tok-2',
        _keychain: { service: 'Claude Code-credentials', account: 'u', value: '{}' },
      },
    });
  });
});

describe('characterization — switch round-trip on-disk state', () => {
  it('save A → load B → save B → load A leaves both snapshots and claude.json consistent', () => {
    // A is active and tracks a fallback key (so its api-key state survives a
    // round trip); B is a plain oauth account.
    fs.writeFileSync(path.join(accDir, 'a@x.com.json'), JSON.stringify({
      emailAddress: 'a@x.com',
      _apiKey: 'sk-ant-a-key',
      _customApiKeyResponses: { approved: ['hash-a'] },
      _claudeJsonApiKey: 'sk-ant-a-injected',
    }));
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({
      emailAddress: 'b@x.com',
      accessToken: 'tok-b',
    }));
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'a@x.com', accessToken: 'tok-a' },
      apiKey: 'sk-ant-a-injected',
      customApiKeyResponses: { approved: ['hash-a'] },
    }));

    // Switch A → B: persist A, then activate B.
    save('a@x.com', claudeJson, accDir);
    load('b@x.com', claudeJson, accDir);

    // B is a plain oauth account claude-switch does not track a key for, so
    // the api-key acceptance state is PURGED from claude.json on load.
    assert.deepStrictEqual(readJson(claudeJson), {
      oauthAccount: { emailAddress: 'b@x.com', accessToken: 'tok-b' },
    });

    // Switch B → A: persist B, then re-activate A.
    save('b@x.com', claudeJson, accDir);
    load('a@x.com', claudeJson, accDir);

    // A tracks a key (_apiKey present), so its approval + injected key are
    // restored into claude.json.
    assert.deepStrictEqual(readJson(claudeJson), {
      oauthAccount: { emailAddress: 'a@x.com', accessToken: 'tok-a' },
      apiKey: 'sk-ant-a-injected',
      customApiKeyResponses: { approved: ['hash-a'] },
    });

    // Both account snapshots persist; A keeps its tracked fields, B captured
    // its latest oauth state.
    assert.deepStrictEqual(snapshotDir(accDir), {
      'a@x.com.json': {
        emailAddress: 'a@x.com',
        accessToken: 'tok-a',
        _apiKey: 'sk-ant-a-key',
        _customApiKeyResponses: { approved: ['hash-a'] },
        _claudeJsonApiKey: 'sk-ant-a-injected',
      },
      'b@x.com.json': {
        emailAddress: 'b@x.com',
        accessToken: 'tok-b',
      },
    });
  });
});

describe('characterization — remove side-effects', () => {
  it('drops only the target file, leaving siblings intact', () => {
    fs.writeFileSync(path.join(accDir, 'a@x.com.json'), JSON.stringify({ emailAddress: 'a@x.com' }));
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({ emailAddress: 'b@x.com' }));

    remove('a@x.com', accDir);

    assert.deepStrictEqual(snapshotDir(accDir), {
      'b@x.com.json': { emailAddress: 'b@x.com' },
    });
  });
});
