import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileCredentialStore, defaultCredentialsFilePath, credentialsFileForConfigDir, configDirHash } from '../src/credentials/file-credential-store.js';

// FileCredentialStore writes to ~/.claude/.credentials.json and
// ~/.claude-switch/apikeys.json — both under $HOME. Tests redirect HOME to
// a temp dir so they never touch the developer's real files. After each
// test we restore HOME and clean up the temp dir.

let originalHome: string | undefined;
let tmpHome: string;
let savedDisableKeychain: string | undefined;

function setHomeTo(p: string): void {
  originalHome = process.env.HOME;
  process.env.HOME = p;
}

function restoreHome(): void {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}

describe('FileCredentialStore — OAuth read/write', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-test-'));
    setHomeTo(tmpHome);
    // The Phase 24 test-mode kill switch — set globally by the npm test
    // script — would short-circuit every method to "disabled" semantics.
    // We're exercising the real persistence path here, so lift it for the
    // duration of these tests and restore it afterwards.
    savedDisableKeychain = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
  });

  afterEach(() => {
    restoreHome();
    if (savedDisableKeychain === undefined) {
      delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    } else {
      process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = savedDisableKeychain;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('readOAuth returns null when the file does not exist', () => {
    const store = new FileCredentialStore();
    assert.equal(store.readOAuth(), null);
  });

  it('writeOAuth creates the file with 0600 perms under ~/.claude/', () => {
    const store = new FileCredentialStore();
    const data = {
      claudeAiOauth: { accessToken: 'tok', refreshToken: 'r', expiresAt: 1 },
    };
    store.writeOAuth(data);
    const file = defaultCredentialsFilePath();
    assert.ok(fs.existsSync(file));
    const stat = fs.statSync(file);
    if (process.platform !== 'win32') {
      // Mode 0o600 = owner-only read/write. Phase 24's threat model: protect
      // against same-user processes only insofar as file perms enforce it.
      assert.equal(stat.mode & 0o777, 0o600);
    }
  });

  it('round-trips OAuth data through write→read', () => {
    const store = new FileCredentialStore();
    const data = {
      claudeAiOauth: { accessToken: 'sk-ant-oat01-X', refreshToken: 'sk-ant-ort01-Y', expiresAt: 9999 },
    };
    store.writeOAuth(data);
    assert.deepEqual(store.readOAuth(), data);
  });

  it('readOAuth returns null on corrupt JSON instead of throwing', () => {
    const store = new FileCredentialStore();
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(defaultCredentialsFilePath(), '{not-json');
    assert.equal(store.readOAuth(), null);
  });

  it('readOAuthForConfigDir reads <configDir>/.credentials.json', () => {
    const store = new FileCredentialStore();
    const configDir = path.join(tmpHome, '.claude', 'profiles', 'work');
    const data = { claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: 1 } };
    store.writeOAuthForConfigDir(configDir, data);
    assert.ok(fs.existsSync(path.join(configDir, '.credentials.json')));
    assert.deepEqual(store.readOAuthForConfigDir(configDir), data);
  });

  it('deleteOAuthForConfigDir removes the file (returns true), false when absent', () => {
    const store = new FileCredentialStore();
    const configDir = path.join(tmpHome, '.claude', 'profiles', 'work');
    store.writeOAuthForConfigDir(configDir, {
      claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: 1 },
    });
    assert.equal(store.deleteOAuthForConfigDir(configDir), true);
    assert.equal(fs.existsSync(path.join(configDir, '.credentials.json')), false);
    // second call: nothing to delete, returns false (not an error)
    assert.equal(store.deleteOAuthForConfigDir(configDir), false);
  });
});

describe('FileCredentialStore — API keys', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-test-'));
    setHomeTo(tmpHome);
    savedDisableKeychain = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
  });

  afterEach(() => {
    restoreHome();
    if (savedDisableKeychain === undefined) {
      delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    } else {
      process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = savedDisableKeychain;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('readApiKey returns null when nothing saved', () => {
    const store = new FileCredentialStore();
    assert.equal(store.readApiKey('a@b.com'), null);
  });

  it('writeApiKey then readApiKey round-trips for the same email', () => {
    const store = new FileCredentialStore();
    assert.equal(store.writeApiKey('a@b.com', 'sk-ant-api03-XYZ'), true);
    assert.equal(store.readApiKey('a@b.com'), 'sk-ant-api03-XYZ');
  });

  it('writeApiKey preserves other accounts\' keys', () => {
    const store = new FileCredentialStore();
    store.writeApiKey('a@b.com', 'key-a');
    store.writeApiKey('c@d.com', 'key-c');
    assert.equal(store.readApiKey('a@b.com'), 'key-a');
    assert.equal(store.readApiKey('c@d.com'), 'key-c');
  });

  it('deleteApiKey removes one and leaves the rest', () => {
    const store = new FileCredentialStore();
    store.writeApiKey('a@b.com', 'key-a');
    store.writeApiKey('c@d.com', 'key-c');
    assert.equal(store.deleteApiKey('a@b.com'), true);
    assert.equal(store.readApiKey('a@b.com'), null);
    assert.equal(store.readApiKey('c@d.com'), 'key-c');
  });

  it('rejects empty email + empty key', () => {
    const store = new FileCredentialStore();
    assert.equal(store.writeApiKey('', 'k'), false);
    assert.equal(store.writeApiKey('a@b.com', ''), false);
    assert.equal(store.readApiKey(''), null);
  });
});

describe('FileCredentialStore — kill switch (CLAUDE_SWITCH_DISABLE_KEYCHAIN=1)', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-test-'));
    setHomeTo(tmpHome);
    // Leave the flag ON: simulates the test-mode default the npm test
    // script sets globally.
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
  });

  afterEach(() => {
    restoreHome();
    delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('available() reports false', () => {
    assert.equal(new FileCredentialStore().available(), false);
  });

  it('readOAuth returns null even when a real file is present', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      defaultCredentialsFilePath(),
      JSON.stringify({ claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: 1 } }),
    );
    assert.equal(new FileCredentialStore().readOAuth(), null);
  });

  it('writeOAuth is a no-op (does not create the file)', () => {
    new FileCredentialStore().writeOAuth({
      claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: 1 },
    });
    assert.equal(fs.existsSync(defaultCredentialsFilePath()), false);
  });
});

describe('credentialsFileForConfigDir + configDirHash', () => {
  it('returns the default path when configDir is empty/null', () => {
    assert.equal(credentialsFileForConfigDir(null), defaultCredentialsFilePath());
    assert.equal(credentialsFileForConfigDir(undefined), defaultCredentialsFilePath());
    assert.equal(credentialsFileForConfigDir(''), defaultCredentialsFilePath());
  });

  it('appends .credentials.json inside the configDir', () => {
    const file = credentialsFileForConfigDir('/tmp/sirtheo-home/profile-a');
    assert.equal(file, path.join('/tmp/sirtheo-home/profile-a', '.credentials.json'));
  });

  it('configDirHash is stable for the same NFC-normalised path', () => {
    const a = configDirHash('/tmp/sirtheo-home/p');
    const b = configDirHash('/tmp/sirtheo-home/p');
    assert.equal(a, b);
    assert.equal(a.length, 8);
  });
});
