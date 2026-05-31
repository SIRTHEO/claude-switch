// test/session-workdir.test.ts
// Coverage for the per-session work-dir seeder (src/sessions/session-workdir.ts).
// Runs under CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 (suite default): the credential
// vault is disabled, so readOAuthForConfigDir returns null and the token rides in
// the copied .claude.json — the no-creds guard keys off the embedded token. The
// port-copy path (file vault / Keychain) is exercised with an injected fake store.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanupPendingWorkDirs, prepareSessionWorkDir, sweepStaleWorkDirs } from '../src/sessions/session-workdir.js';
import type { CredentialStore, KeychainData } from '../src/credentials/credential-store.js';

const CONTAINERS = ['projects', 'sessions', 'skills', 'shell-snapshots', 'file-history', 'todos'];

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** A profile with an INLINE token in .claude.json (the test-mode embed path). */
function seedCanonical(dir: string, email: string, opts: { overlay?: boolean; embedToken?: boolean } = {}): void {
  const oauthAccount: Record<string, unknown> = { emailAddress: email, accountUuid: `uuid-${email}` };
  if (opts.embedToken !== false) {
    oauthAccount.accessToken = 'sk-ant-oat01-SEED';
    oauthAccount.refreshToken = 'rt-seed';
    oauthAccount.expiresAt = 9999999999999;
  }
  writeJson(path.join(dir, '.claude.json'), { userID: 'c'.repeat(64), hasCompletedOnboarding: true, oauthAccount });
  writeJson(path.join(dir, 'settings.json'), { statusLine: { type: 'command', command: 'x' } });
  if (opts.overlay) fs.writeFileSync(path.join(dir, '.cs-overlay'), '', { mode: 0o600 });
}

function captureStore(read: KeychainData | null): { store: CredentialStore; writes: Array<{ configDir: string | null; data: KeychainData }> } {
  const writes: Array<{ configDir: string | null; data: KeychainData }> = [];
  const store: CredentialStore = {
    readOAuth: () => null,
    writeOAuth: () => {},
    readOAuthForConfigDir: () => read,
    writeOAuthForConfigDir: (configDir, data) => { writes.push({ configDir, data }); },
    deleteOAuthForConfigDir: () => false,
    available: () => true,
    readApiKey: () => null,
    writeApiKey: () => true,
    deleteApiKey: () => false,
    listOAuthKeychainItems: () => [],
    setPartitionList: () => false,
  };
  return { store, writes };
}

describe('prepareSessionWorkDir', () => {
  let home: string;
  let claudeDir: string;
  let accountsDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-workdir-'));
    claudeDir = path.join(home, '.claude');
    accountsDir = path.join(claudeDir, 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('classic profile: copies identity+settings, symlinks each container to the (real) canonical dir', () => {
    const canonical = path.join(claudeDir, 'profiles', 'work');
    seedCanonical(canonical, 'sirtheo.work@example.com');

    const workDir = prepareSessionWorkDir(canonical, accountsDir);

    assert.ok(workDir.startsWith(path.join(claudeDir, 'session-dirs')), 'work dir is under session-dirs');
    assert.ok(fs.existsSync(path.join(workDir, '.claude.json')), '.claude.json copied');
    assert.ok(fs.existsSync(path.join(workDir, 'settings.json')), 'settings.json copied (not symlinked)');
    assert.ok(!fs.lstatSync(path.join(workDir, '.claude.json')).isSymbolicLink(), '.claude.json is a real copy');
    assert.ok(!fs.lstatSync(path.join(workDir, 'settings.json')).isSymbolicLink(), 'settings.json is a real copy');

    for (const sub of CONTAINERS) {
      const link = path.join(workDir, sub);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), `${sub} is a symlink`);
      assert.equal(fs.readlinkSync(link), path.resolve(canonical, sub), `${sub} → canonical/${sub}`);
      assert.ok(fs.statSync(path.join(canonical, sub)).isDirectory(), `classic canonical/${sub} is a real dir`);
      assert.ok(!fs.lstatSync(path.join(canonical, sub)).isSymbolicLink(), `classic canonical/${sub} not a symlink`);
    }
  });

  it('overlay profile: containers chain work dir → canonical → global, writes land in the global', () => {
    const canonical = path.join(claudeDir, 'profiles', 'over');
    seedCanonical(canonical, 'sirtheo.personal@example.com', { overlay: true });

    const workDir = prepareSessionWorkDir(canonical, accountsDir);

    for (const sub of CONTAINERS) {
      assert.ok(fs.lstatSync(path.join(canonical, sub)).isSymbolicLink(), `overlay canonical/${sub} is a symlink`);
      assert.equal(fs.readlinkSync(path.join(canonical, sub)), path.resolve(claudeDir, sub), `canonical/${sub} → global/${sub}`);
      assert.equal(fs.readlinkSync(path.join(workDir, sub)), path.resolve(canonical, sub), `workDir/${sub} → canonical/${sub}`);
    }
    // A write through the chain lands in the GLOBAL home.
    fs.writeFileSync(path.join(workDir, 'projects', 'probe.txt'), 'x');
    assert.ok(fs.existsSync(path.join(claudeDir, 'projects', 'probe.txt')), 'write reached the global via the chain');
  });

  it('copies the credential through the port when the vault resolves one', () => {
    const canonical = path.join(claudeDir, 'profiles', 'work');
    // No embedded token → the guard relies on the port returning a credential.
    seedCanonical(canonical, 'sirtheo.work@example.com', { embedToken: false });
    const blob: KeychainData = { claudeAiOauth: { accessToken: 'sk-ant-oat01-VAULT', refreshToken: 'rt', expiresAt: 9999999999999 } };
    const { store, writes } = captureStore(blob);

    const workDir = prepareSessionWorkDir(canonical, accountsDir, { credentials: store });

    assert.equal(writes.length, 1, 'one vault write for the work dir');
    assert.equal(writes[0]!.configDir, workDir);
    assert.equal(writes[0]!.data.claudeAiOauth?.accessToken, 'sk-ant-oat01-VAULT');
  });

  it('refuses (and removes the dir) when no credential is resolvable', () => {
    const canonical = path.join(claudeDir, 'profiles', 'work');
    seedCanonical(canonical, 'sirtheo.work@example.com', { embedToken: false }); // no inline token
    const { store } = captureStore(null); // empty vault

    assert.throws(
      () => prepareSessionWorkDir(canonical, accountsDir, { credentials: store }),
      /no resolvable credentials/i,
    );
    assert.ok(!fs.existsSync(path.join(claudeDir, 'session-dirs', `work.${process.pid}`)), 'half-seeded dir removed');
  });

  it('sweepStaleWorkDirs removes dead-pid work dirs, keeps live ones and non-work entries', () => {
    const sessionDirs = path.join(claudeDir, 'session-dirs');
    fs.mkdirSync(path.join(sessionDirs, 'work.999999'), { recursive: true }); // dead pid (injected)
    fs.mkdirSync(path.join(sessionDirs, `live.${process.pid}`), { recursive: true });
    fs.mkdirSync(path.join(sessionDirs, 'notours'), { recursive: true }); // no .<pid> suffix
    // Inject liveness so the test is deterministic (only THIS pid is alive).
    sweepStaleWorkDirs(claudeDir, { isAlive: (pid) => pid === process.pid });
    assert.ok(!fs.existsSync(path.join(sessionDirs, 'work.999999')), 'dead-pid work dir removed');
    assert.ok(fs.existsSync(path.join(sessionDirs, `live.${process.pid}`)), 'live work dir kept');
    assert.ok(fs.existsSync(path.join(sessionDirs, 'notours')), 'non-work entry left alone');
  });

  it('schedules the work dir for exit cleanup; cleanupPendingWorkDirs removes it', () => {
    const canonical = path.join(claudeDir, 'profiles', 'work');
    seedCanonical(canonical, 'sirtheo.work@example.com');
    const workDir = prepareSessionWorkDir(canonical, accountsDir);
    assert.ok(fs.existsSync(workDir), 'work dir created');
    cleanupPendingWorkDirs(); // what the exit listener calls
    assert.ok(!fs.existsSync(workDir), 'cleanup removed the work dir');
  });

  it('recycles a stale work dir from a reused pid', () => {
    const canonical = path.join(claudeDir, 'profiles', 'work');
    seedCanonical(canonical, 'sirtheo.work@example.com');
    const expected = path.join(claudeDir, 'session-dirs', `work.${process.pid}`);
    fs.mkdirSync(expected, { recursive: true });
    fs.writeFileSync(path.join(expected, 'stale.txt'), 'old');

    const workDir = prepareSessionWorkDir(canonical, accountsDir);

    assert.equal(workDir, expected);
    assert.ok(!fs.existsSync(path.join(workDir, 'stale.txt')), 'stale content removed');
    assert.ok(fs.existsSync(path.join(workDir, '.claude.json')), 're-seeded');
  });
});
