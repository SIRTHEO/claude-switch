// test/migrate-session.test.ts
// Coverage for the live-migration writer (src/sessions/migrate-session.ts).
//
// Runs under CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 (the suite default), so the
// credential vault is disabled and tokens live INLINE in the profile's
// .claude.json oauthAccount — exactly the embed path importProfileFromAccount
// takes in test mode. Assertions therefore target <configDir>/.claude.json, NOT
// <configDir>/.credentials.json (which writeOAuthForConfigDir no-ops in test
// mode). The target profile is resolved through an injected `ensureProfile`
// stub so the test never touches the real legacy-snapshot refresh / network.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateSession } from '../src/sessions/migrate-session.js';
import { prepareSessionWorkDir } from '../src/sessions/session-workdir.js';
import type { CredentialStore, KeychainData } from '../src/credentials/credential-store.js';

const WORK = 'sirtheo.work@example.com';
const PERSONAL = 'sirtheo.personal@example.com';

/** In-memory CredentialStore capturing per-config-dir vault writes. Its
 *  `readOAuthForConfigDir` returns null so the writer falls back to the token
 *  embedded in the target profile's .claude.json (the test fixture shape). */
function captureStore(): { store: CredentialStore; writes: Array<{ configDir: string | null; data: KeychainData }> } {
  const writes: Array<{ configDir: string | null; data: KeychainData }> = [];
  const store: CredentialStore = {
    readOAuth: () => null,
    writeOAuth: () => {},
    readOAuthForConfigDir: () => null,
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

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

describe('migrateSession', () => {
  let home: string;
  let claudeDir: string;
  let accountsDir: string;
  let bDir: string; // target (WORK) profile
  let cDir: string; // the running session's private config dir (currently PERSONAL)

  // Profile resolver stub: WORK → its profile, logged in.
  const ensureWork = async () => ({ profilePath: bDir, needsLogin: false });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-migrate-'));
    claudeDir = path.join(home, '.claude');
    accountsDir = path.join(claudeDir, 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });

    bDir = path.join(claudeDir, 'profiles', 'work');
    writeJson(path.join(bDir, '.claude.json'), {
      userID: 'b'.repeat(64),
      hasCompletedOnboarding: true,
      oauthAccount: {
        emailAddress: WORK,
        accountUuid: 'uuid-work',
        accessToken: 'sk-ant-oat01-WORK',
        refreshToken: 'rt-WORK',
        expiresAt: 9999999999999,
      },
    });

    // The running session's work dir is OUTSIDE the canonical profiles tree —
    // the interim safety guard refuses migration of a session running in
    // `<.claude>/profiles/*` (see the dedicated test below), so the writer can
    // only be exercised on a non-canonical dir (the future per-session work dir).
    cDir = path.join(home, 'session-work');
    writeJson(path.join(cDir, '.claude.json'), {
      userID: 'c'.repeat(64),
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: PERSONAL, accountUuid: 'uuid-personal' },
    });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('rewrites BOTH the identity and the inline token in the session config dir', async () => {
    const res = await migrateSession(WORK, cDir, accountsDir, { ensureProfile: ensureWork });
    assert.equal(res.noop, false);

    const oauth = readJson(path.join(cDir, '.claude.json')).oauthAccount as Record<string, unknown>;
    assert.equal(oauth.emailAddress, WORK, 'identity flips to the target account');
    assert.equal(oauth.accountUuid, 'uuid-work', 'accountUuid follows the target');
    assert.equal(oauth.accessToken, 'sk-ant-oat01-WORK', 'token embedded inline (vault disabled in test)');
    assert.equal(oauth.refreshToken, 'rt-WORK');
    assert.equal(oauth.expiresAt, 9999999999999);
  });

  it('vault branch: token goes to the credential vault, identity stays metadata-only', async () => {
    // Force the production file-vault branch even though the suite disables the
    // store; nothing else in the suite exercises writeOAuthForConfigDir.
    const { store, writes } = captureStore();
    const res = await migrateSession(WORK, cDir, accountsDir, {
      ensureProfile: ensureWork,
      credentials: store,
      useKeychain: true,
    });
    assert.equal(res.noop, false);

    assert.equal(writes.length, 1, 'one vault write for the migrating session');
    assert.equal(writes[0]!.configDir, cDir, 'token written to THIS session config dir');
    assert.equal(writes[0]!.data.claudeAiOauth?.accessToken, 'sk-ant-oat01-WORK');

    const oauth = readJson(path.join(cDir, '.claude.json')).oauthAccount as Record<string, unknown>;
    assert.equal(oauth.emailAddress, WORK, 'identity flips to the target');
    assert.equal(oauth.accountUuid, 'uuid-work');
    assert.equal(oauth.accessToken, undefined, 'token lives in the vault, NOT inline, on the vault branch');
  });

  it('preserves every other key of the session .claude.json (userID, onboarding)', async () => {
    await migrateSession(WORK, cDir, accountsDir, { ensureProfile: ensureWork });
    const cfg = readJson(path.join(cDir, '.claude.json'));
    assert.equal(cfg.userID, 'c'.repeat(64), 'userID untouched — only oauthAccount is replaced');
    assert.equal(cfg.hasCompletedOnboarding, true);
  });

  it('migrates a REAL per-session work dir end to end, leaving the data-container symlinks intact', async () => {
    // Seed a real work dir from a spawn profile A (the b+migrate full path).
    const canonA = path.join(claudeDir, 'profiles', 'personal-spawn');
    writeJson(path.join(canonA, '.claude.json'), {
      userID: 'a'.repeat(64),
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: PERSONAL, accountUuid: 'uuid-a', accessToken: 'sk-A', refreshToken: 'rt', expiresAt: 9999999999999 },
    });
    const workDir = prepareSessionWorkDir(canonA, accountsDir);
    const projectsBefore = fs.readlinkSync(path.join(workDir, 'projects'));
    assert.equal(projectsBefore, path.resolve(canonA, 'projects'), 'work dir containers link to spawn profile A');

    // Migrate the live work dir to WORK (bDir is the target profile).
    const res = await migrateSession(WORK, workDir, accountsDir, { ensureProfile: ensureWork });
    assert.equal(res.noop, false);

    const oauth = readJson(path.join(workDir, '.claude.json')).oauthAccount as Record<string, unknown>;
    assert.equal(oauth.emailAddress, WORK, 'identity flipped to the target in the work dir');
    assert.equal(oauth.accessToken, 'sk-ant-oat01-WORK', "target's token embedded");
    // The data-container symlinks are UNTOUCHED — history/sessions follow the
    // running session, not the account it now speaks as.
    assert.equal(fs.readlinkSync(path.join(workDir, 'projects')), projectsBefore, 'containers untouched by migrate');
    // The spawn profile A's canonical store is NOT corrupted.
    assert.equal(
      (readJson(path.join(canonA, '.claude.json')).oauthAccount as Record<string, unknown>).emailAddress,
      PERSONAL,
    );
  });

  it('refuses a session running in the canonical profiles tree (interim safety guard)', async () => {
    // A session whose configDir IS the account's canonical profile dir must be
    // refused — rewriting it would corrupt that account's store (the live-migration
    // canonical-dir corruption bug).
    const canonical = path.join(claudeDir, 'profiles', 'personal');
    writeJson(path.join(canonical, '.claude.json'), {
      userID: 'p'.repeat(64),
      oauthAccount: { emailAddress: PERSONAL, accountUuid: 'uuid-personal' },
    });
    await assert.rejects(
      () => migrateSession(WORK, canonical, accountsDir, { ensureProfile: ensureWork }),
      /not available yet|canonical profile/i,
    );
    // The canonical store is untouched by the refusal.
    assert.equal(
      (readJson(path.join(canonical, '.claude.json')).oauthAccount as Record<string, unknown>).emailAddress,
      PERSONAL,
    );
  });

  it('refuses a global-bound (null / ~/.claude) config dir — frozen default', async () => {
    await assert.rejects(
      () => migrateSession(WORK, claudeDir, accountsDir, { ensureProfile: ensureWork }),
      /global-bound/i,
    );
    await assert.rejects(
      () => migrateSession(WORK, '', accountsDir, { ensureProfile: ensureWork }),
      /global-bound/i,
    );
    // The frozen default's identity must be untouched by the refusal.
    assert.equal(
      (readJson(path.join(cDir, '.claude.json')).oauthAccount as Record<string, unknown>).emailAddress,
      PERSONAL,
    );
  });

  it('refuses when the target needs login', async () => {
    await assert.rejects(
      () => migrateSession(WORK, cDir, accountsDir, {
        ensureProfile: async () => ({ profilePath: bDir, needsLogin: true }),
      }),
      /login|credentials/i,
    );
  });

  it('refuses when the target is already live in another session', async () => {
    // Seed the registry with a live session running in the target's profile.
    // pid = process.pid so the default liveness probe (real process.kill) keeps
    // it — migrateSession reads the registry with the un-injectable default.
    const registry = [{
      pid: process.pid,
      account: WORK,
      configDir: bDir,
      isolated: true,
      cwd: '/tmp/other',
      startedAt: 1,
    }];
    fs.writeFileSync(path.join(accountsDir, '.sessions.json'), JSON.stringify(registry));

    await assert.rejects(
      () => migrateSession(WORK, cDir, accountsDir, { ensureProfile: ensureWork }),
      /already live/i,
    );
  });

  it('records currentAccount in the live registry after migrating', async () => {
    fs.writeFileSync(path.join(accountsDir, '.sessions.json'), JSON.stringify([
      { pid: process.pid, account: PERSONAL, configDir: cDir, isolated: true, cwd: '/tmp', startedAt: 1 },
    ]));
    await migrateSession(WORK, cDir, accountsDir, { ensureProfile: ensureWork });
    const reg = JSON.parse(fs.readFileSync(path.join(accountsDir, '.sessions.json'), 'utf-8')) as Array<Record<string, unknown>>;
    assert.equal(reg.find((s) => s.configDir === cDir)?.currentAccount, WORK);
  });

  it('refuses when the target is the CURRENT (migrated) account of another live session', async () => {
    // A session SPAWNED as personal but already migrated TO work — spawn `account`
    // would miss it; `currentAccount` is what makes the conflict check exact.
    const otherDir = path.join(home, 'other-session');
    fs.writeFileSync(path.join(accountsDir, '.sessions.json'), JSON.stringify([
      { pid: process.pid, account: PERSONAL, currentAccount: WORK, configDir: otherDir, isolated: true, cwd: '/tmp', startedAt: 1 },
    ]));
    await assert.rejects(
      () => migrateSession(WORK, cDir, accountsDir, { ensureProfile: ensureWork }),
      /already live/i,
    );
  });

  it('returns noop without rewriting when the session already runs the target', async () => {
    // C already runs WORK.
    writeJson(path.join(cDir, '.claude.json'), {
      userID: 'c'.repeat(64),
      oauthAccount: { emailAddress: WORK, accountUuid: 'uuid-work' },
    });
    const res = await migrateSession(WORK, cDir, accountsDir, { ensureProfile: ensureWork });
    assert.equal(res.noop, true);
    // accountUuid unchanged (no token embed happened).
    const oauth = readJson(path.join(cDir, '.claude.json')).oauthAccount as Record<string, unknown>;
    assert.equal(oauth.accessToken, undefined, 'no rewrite on a no-op migration');
  });
});
