import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFileVaultMigration, isMigrated } from '../src/credential-migration.js';
import { FileCredentialStore, defaultCredentialsFilePath } from '../src/file-credential-store.js';
import type { CredentialStore, KeychainData } from '../src/credential-store.js';

// The migration helper reads HOME both directly (for marker placement) and
// indirectly through FileCredentialStore (for vault file placement). Redirect
// HOME to a temp dir so we never touch the developer's real files.

let tmpHome: string;
let originalHome: string | undefined;
let savedDisable: string | undefined;
let savedPlatformDescriptor: PropertyDescriptor | undefined;

function setHomeTo(p: string): void {
  originalHome = process.env.HOME;
  process.env.HOME = p;
}
function restoreHome(): void {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}
function setPlatform(p: NodeJS.Platform): void {
  savedPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: p, configurable: true, writable: true });
}
function restorePlatform(): void {
  if (savedPlatformDescriptor) Object.defineProperty(process, 'platform', savedPlatformDescriptor);
}

/** Fake legacy CredentialStore producing canned OAuth data. */
function fakeLegacy(blob: KeychainData | null): CredentialStore {
  return {
    readOAuth: () => blob,
    writeOAuth: () => { throw new Error('legacy is read-only in migration'); },
    readOAuthForConfigDir: () => null,
    writeOAuthForConfigDir: () => { throw new Error('not called'); },
    deleteOAuthForConfigDir: () => false,
    available: () => true,
    readApiKey: () => null,
    writeApiKey: () => false,
    deleteApiKey: () => false,
    listOAuthKeychainItems: () => [],
    setPartitionList: () => false,
  };
}

function fakeLegacyThatThrows(): CredentialStore {
  return { ...fakeLegacy(null), readOAuth: () => { throw new Error('keychain locked'); } };
}

describe('Phase 24 migration — runFileVaultMigration', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mig-'));
    setHomeTo(tmpHome);
    savedDisable = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    setPlatform('darwin');
  });
  afterEach(() => {
    restorePlatform();
    if (savedDisable === undefined) delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    else process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = savedDisable;
    restoreHome();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('copies OAuth blob from legacy Keychain into the file vault', () => {
    const blob: KeychainData = {
      claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: 1 },
    };
    const ok = runFileVaultMigration({
      legacy: fakeLegacy(blob),
      fileStore: new FileCredentialStore(),
    });
    assert.equal(ok, true);
    // File vault now contains the migrated blob.
    const written = JSON.parse(fs.readFileSync(defaultCredentialsFilePath(), 'utf-8'));
    assert.deepEqual(written, blob);
  });

  it('writes a marker after running so re-runs no-op', () => {
    runFileVaultMigration({
      legacy: fakeLegacy({ claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: 1 } }),
      fileStore: new FileCredentialStore(),
    });
    assert.equal(isMigrated(), true);

    // Second call: must NOT touch the legacy adapter again. Inject a legacy
    // that throws if used, to detect any unexpected re-read.
    const shouldNotBeCalled = {
      ...fakeLegacyThatThrows(),
      readOAuth: () => { throw new Error('would have prompted'); },
    };
    const second = runFileVaultMigration({
      legacy: shouldNotBeCalled,
      fileStore: new FileCredentialStore(),
    });
    assert.equal(second, false, 'idempotent re-run is a no-op');
  });

  it('writes a "none" marker (no vault file) when the legacy read fails', () => {
    const ok = runFileVaultMigration({
      legacy: fakeLegacyThatThrows(),
      fileStore: new FileCredentialStore(),
    });
    assert.equal(ok, false);
    assert.equal(isMigrated(), true, 'marker still written so we don\'t retry');
    assert.equal(fs.existsSync(defaultCredentialsFilePath()), false, 'no vault file on failure');
  });

  it('skips when the test-mode disable flag is set, writing a "none" marker', () => {
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
    // The legacy adapter must not even be queried; we use a throwing one
    // to catch any accidental call.
    const ok = runFileVaultMigration({
      legacy: fakeLegacyThatThrows(),
      fileStore: new FileCredentialStore(),
    });
    assert.equal(ok, false);
    assert.equal(isMigrated(), true);
  });

  it('skips on non-darwin platforms', () => {
    setPlatform('linux');
    const ok = runFileVaultMigration({
      legacy: fakeLegacyThatThrows(),
      fileStore: new FileCredentialStore(),
    });
    assert.equal(ok, false);
    assert.equal(isMigrated(), true);
  });

  it('refuses to write the vault when the legacy blob lacks claudeAiOauth.accessToken', () => {
    const ok = runFileVaultMigration({
      legacy: fakeLegacy({} as KeychainData),
      fileStore: new FileCredentialStore(),
    });
    assert.equal(ok, false);
    assert.equal(fs.existsSync(defaultCredentialsFilePath()), false);
  });
});

describe('Phase 24 migration — isMigrated marker integrity', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mig-'));
    setHomeTo(tmpHome);
  });
  afterEach(() => {
    restoreHome();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns false when the marker file is absent', () => {
    assert.equal(isMigrated(), false);
  });

  it('returns false on corrupt JSON', () => {
    const marker = path.join(tmpHome, '.claude-switch', '.migration-v4.json');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '{not-json');
    assert.equal(isMigrated(marker), false);
  });
});
