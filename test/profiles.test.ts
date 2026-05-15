import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isValidProfileName,
  profilePath,
  profileExists,
  listProfiles,
  createProfile,
  readProfile,
  removeProfile,
  importProfileFromAccount,
  ensureProfileForAccount,
} from '../src/profiles.js';

// All tests redirect HOME so the profiles dir is sandboxed in /tmp.
// On Windows, os.homedir() uses USERPROFILE (not HOME), so both are set.
let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-profiles-'));
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  if (process.platform === 'win32') process.env.USERPROFILE = tmpHome;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (process.platform === 'win32') {
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('isValidProfileName', () => {
  it('accepts simple names', () => {
    assert.ok(isValidProfileName('work'));
    assert.ok(isValidProfileName('personal'));
    assert.ok(isValidProfileName('client_acme'));
    assert.ok(isValidProfileName('side-project-1'));
  });
  it('rejects empty / whitespace / non-string', () => {
    assert.ok(!isValidProfileName(''));
    assert.ok(!isValidProfileName(' '));
    assert.ok(!isValidProfileName(undefined as unknown as string));
    assert.ok(!isValidProfileName(null as unknown as string));
  });
  it('rejects shell metacharacters and path separators', () => {
    assert.ok(!isValidProfileName('work/personal'));
    assert.ok(!isValidProfileName('a b'));
    assert.ok(!isValidProfileName('back$pwd'));
    assert.ok(!isValidProfileName('foo;bar'));
    assert.ok(!isValidProfileName('..'));
  });
  it('rejects reserved subcommand names', () => {
    for (const r of ['list', 'ls', 'create', 'use', 'login', 'remove', 'rm', 'status', 'help']) {
      assert.ok(!isValidProfileName(r), `should reject "${r}"`);
    }
  });
  it('rejects names longer than 64 chars', () => {
    assert.ok(!isValidProfileName('a'.repeat(65)));
    assert.ok(isValidProfileName('a'.repeat(64)));
  });
});

describe('profilePath', () => {
  it('returns a path under the profiles dir', () => {
    const p = profilePath('work');
    assert.ok(p.startsWith(path.join(tmpHome, '.claude', 'profiles')));
    assert.ok(p.endsWith(path.sep + 'work') || p.endsWith('/work'));
  });
  it('throws for invalid names (path traversal etc.)', () => {
    assert.throws(() => profilePath('../escape'), /Invalid profile name/);
    assert.throws(() => profilePath('a/b'), /Invalid profile name/);
    assert.throws(() => profilePath(''), /Invalid profile name/);
  });
});

describe('createProfile + profileExists + listProfiles', () => {
  it('creates a fresh profile dir', () => {
    const p = createProfile('work');
    assert.ok(fs.statSync(p).isDirectory());
    assert.ok(profileExists('work'));
  });
  it('creates the dir with mode 0o700 on unix', { skip: process.platform === 'win32' }, () => {
    const p = createProfile('work');
    assert.strictEqual(fs.statSync(p).mode & 0o777, 0o700);
  });
  it('throws when the profile already exists', () => {
    createProfile('work');
    assert.throws(() => createProfile('work'), /already exists/);
  });
  it('listProfiles returns empty when no profiles dir', () => {
    assert.deepStrictEqual(listProfiles(), []);
  });
  it('listProfiles returns sorted profile names', () => {
    createProfile('work');
    createProfile('personal');
    createProfile('client_acme');
    assert.deepStrictEqual(listProfiles(), ['client_acme', 'personal', 'work']);
  });
  it('listProfiles ignores non-profile names that may appear in the dir', () => {
    createProfile('work');
    // Stray file/dir with an invalid name should be skipped.
    fs.writeFileSync(path.join(tmpHome, '.claude', 'profiles', '.DS_Store'), '');
    fs.mkdirSync(path.join(tmpHome, '.claude', 'profiles', 'not valid'));
    assert.deepStrictEqual(listProfiles(), ['work']);
  });
});

describe('readProfile', () => {
  it('returns null fields for a fresh profile (no .claude.json yet)', () => {
    createProfile('work');
    const info = readProfile('work');
    assert.strictEqual(info.name, 'work');
    assert.strictEqual(info.userID, null);
    assert.strictEqual(info.emailAddress, null);
    assert.strictEqual(info.hasLogin, false);
  });
  it('parses userID and emailAddress when claude has populated the dir', () => {
    const p = createProfile('work');
    fs.writeFileSync(path.join(p, '.claude.json'), JSON.stringify({
      userID: 'cfc0482b6ae14ad3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      oauthAccount: { emailAddress: 'me@x.com' },
    }));
    const info = readProfile('work');
    assert.strictEqual(info.userID, 'cfc0482b6ae14ad3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(info.emailAddress, 'me@x.com');
    assert.strictEqual(info.hasLogin, true);
  });
  it('throws for non-existent profile', () => {
    assert.throws(() => readProfile('nope'), /does not exist/);
  });
  it('handles malformed .claude.json gracefully', () => {
    const p = createProfile('work');
    fs.writeFileSync(path.join(p, '.claude.json'), '{ not json');
    const info = readProfile('work');
    // Should fall back to nulls instead of throwing.
    assert.strictEqual(info.userID, null);
    assert.strictEqual(info.emailAddress, null);
    assert.strictEqual(info.hasLogin, false);
  });
});

describe('removeProfile', () => {
  it('deletes the directory', () => {
    const p = createProfile('work');
    assert.ok(fs.existsSync(p));
    removeProfile('work');
    assert.ok(!fs.existsSync(p));
  });
  it('returns the userID for Keychain cleanup hint', () => {
    const p = createProfile('work');
    fs.writeFileSync(path.join(p, '.claude.json'), JSON.stringify({
      userID: 'abc123def456',
    }));
    const result = removeProfile('work');
    assert.strictEqual(result.userID, 'abc123def456');
    assert.ok(result.dir.endsWith('work'));
  });
  it('returns userID=null when the profile never ran claude', () => {
    createProfile('work');
    const result = removeProfile('work');
    assert.strictEqual(result.userID, null);
  });
});

describe('importProfileFromAccount', () => {
  let accountsDir: string;
  beforeEach(() => {
    accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
  });

  it('throws for unknown account', () => {
    assert.throws(
      () => importProfileFromAccount('nope@x.com', accountsDir),
      /No saved account for nope@x\.com/,
    );
  });

  it('rejects path-traversal email values before opening any file', () => {
    // Regression: pre-fix, `path.join(accountsDir, "../../foo.json")` resolved
    // outside the accounts dir, letting `claude switch profile import` read
    // arbitrary files. The guard must trip on the email shape, not on
    // missing-file behaviour.
    assert.throws(
      () => importProfileFromAccount('../../etc/passwd', accountsDir),
      /unsafe for filenames|outside accounts directory/i,
    );
    assert.throws(
      () => importProfileFromAccount('../escape@x.com', accountsDir),
      /unsafe for filenames|outside accounts directory/i,
    );
  });

  it('rejects symlink account files', () => {
    // Plant a symlink in the accounts directory and confirm we refuse to
    // follow it into another location.
    const target = path.join(tmpHome, 'sneaky.json');
    fs.writeFileSync(target, JSON.stringify({ emailAddress: 'evil@x.com' }));
    fs.symlinkSync(target, path.join(accountsDir, 'evil@x.com.json'));
    assert.throws(
      () => importProfileFromAccount('evil@x.com', accountsDir),
      /symbolic link/i,
    );
  });

  it('uses email local-part as default profile name', () => {
    fs.writeFileSync(path.join(accountsDir, 'work@example.com.json'), JSON.stringify({
      emailAddress: 'work@example.com',
    }));
    const result = importProfileFromAccount('work@example.com', accountsDir);
    assert.strictEqual(result.profileName, 'work');
    assert.strictEqual(result.emailAddress, 'work@example.com');
  });

  it('respects an explicit profile name override', () => {
    fs.writeFileSync(path.join(accountsDir, 'a@b.com.json'), JSON.stringify({
      emailAddress: 'a@b.com',
    }));
    const result = importProfileFromAccount('a@b.com', accountsDir, 'custom-name');
    assert.strictEqual(result.profileName, 'custom-name');
  });

  it('flags needsLogin=true for legacy accounts without _keychain snapshot', () => {
    fs.writeFileSync(path.join(accountsDir, 'pre-v22@x.com.json'), JSON.stringify({
      emailAddress: 'pre-v22@x.com',
    }));
    const result = importProfileFromAccount('pre-v22@x.com', accountsDir);
    assert.strictEqual(result.needsLogin, true);
    assert.strictEqual(result.wroteToKeychain, false);
    // Profile dir created, but only userID — no oauthAccount yet.
    const cfg = JSON.parse(fs.readFileSync(path.join(result.profilePath, '.claude.json'), 'utf-8'));
    assert.ok(cfg.userID);
    assert.strictEqual(cfg.oauthAccount, undefined,
      'should NOT pre-populate oauthAccount when there are no tokens — otherwise the profile-use guard incorrectly thinks the profile is logged in');
  });

  it('generates a userID that is 64 hex chars (matches Claude Code format)', () => {
    fs.writeFileSync(path.join(accountsDir, 'a@b.com.json'), JSON.stringify({
      emailAddress: 'a@b.com',
    }));
    const result = importProfileFromAccount('a@b.com', accountsDir);
    assert.match(result.userID, /^[0-9a-f]{64}$/);
  });

  it('generates DIFFERENT userIDs for two imports — each profile gets its own', () => {
    fs.writeFileSync(path.join(accountsDir, 'a@b.com.json'), JSON.stringify({ emailAddress: 'a@b.com' }));
    fs.writeFileSync(path.join(accountsDir, 'c@d.com.json'), JSON.stringify({ emailAddress: 'c@d.com' }));
    const r1 = importProfileFromAccount('a@b.com', accountsDir);
    const r2 = importProfileFromAccount('c@d.com', accountsDir);
    assert.notStrictEqual(r1.userID, r2.userID);
  });

  it('refuses to import twice into the same profile name', () => {
    fs.writeFileSync(path.join(accountsDir, 'a@b.com.json'), JSON.stringify({ emailAddress: 'a@b.com' }));
    importProfileFromAccount('a@b.com', accountsDir, 'mine');
    assert.throws(
      () => importProfileFromAccount('a@b.com', accountsDir, 'mine'),
      /already exists/,
    );
  });

  it('on Linux/Windows, embeds tokens directly in oauthAccount.accessToken when _keychain is present',
    { skip: process.platform === 'darwin' }, () => {
    fs.writeFileSync(path.join(accountsDir, 'work@x.com.json'), JSON.stringify({
      emailAddress: 'work@x.com',
      _keychain: {
        claudeAiOauth: {
          accessToken: 'tok-A',
          refreshToken: 'rtok-A',
          expiresAt: 9999999999999,
        },
      },
    }));
    const result = importProfileFromAccount('work@x.com', accountsDir);
    assert.strictEqual(result.needsLogin, false);
    assert.strictEqual(result.wroteToKeychain, false);
    const cfg = JSON.parse(fs.readFileSync(path.join(result.profilePath, '.claude.json'), 'utf-8'));
    assert.strictEqual(cfg.oauthAccount.accessToken, 'tok-A');
    assert.strictEqual(cfg.oauthAccount.refreshToken, 'rtok-A');
    assert.strictEqual(cfg.oauthAccount.emailAddress, 'work@x.com');
  });

  it('rejects emails whose local-part contains chars that would make an invalid profile name', () => {
    // Email allowed by accounts.ts validation but produces an invalid profile name.
    // Localpart char "+": accounts.ts allows it, but profile names don't (PROFILE_NAME_RE).
    fs.writeFileSync(path.join(accountsDir, 'foo+bar@x.com.json'), JSON.stringify({ emailAddress: 'foo+bar@x.com' }));
    // Auto-derived name "foo+bar" → contains '+' which isn't in our profile alphabet.
    // Our impl does .replace(/[^A-Za-z0-9_-]/g, '_') so it becomes "foo_bar". Verify.
    const result = importProfileFromAccount('foo+bar@x.com', accountsDir);
    assert.strictEqual(result.profileName, 'foo_bar');
  });
});

describe('ensureProfileForAccount', () => {
  let accountsDir: string;
  beforeEach(() => {
    accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
  });

  it('creates a new profile when none exists for the email', async () => {
    fs.writeFileSync(path.join(accountsDir, 'new@x.com.json'), JSON.stringify({ emailAddress: 'new@x.com' }));
    const result = await ensureProfileForAccount('new@x.com', accountsDir);
    assert.strictEqual(result.emailAddress, 'new@x.com');
    assert.strictEqual(result.created, true);
    assert.ok(profileExists(result.profileName));
  });

  it('reuses an existing profile already linked to the email', async () => {
    fs.writeFileSync(path.join(accountsDir, 'mine@x.com.json'), JSON.stringify({ emailAddress: 'mine@x.com' }));
    const first = await ensureProfileForAccount('mine@x.com', accountsDir);
    assert.strictEqual(first.created, true);

    // Second call must reuse, not create.
    const second = await ensureProfileForAccount('mine@x.com', accountsDir);
    assert.strictEqual(second.profileName, first.profileName);
    assert.strictEqual(second.created, false);
  });

  it('needsLogin=true when no credential snapshot in account', async () => {
    fs.writeFileSync(path.join(accountsDir, 'pre@x.com.json'), JSON.stringify({ emailAddress: 'pre@x.com' }));
    const result = await ensureProfileForAccount('pre@x.com', accountsDir);
    assert.strictEqual(result.needsLogin, true);
  });

  it('needsLogin=false when reusing a profile that already has a login', async () => {
    const dir = createProfile('ready');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      userID: 'a'.repeat(64),
      oauthAccount: { emailAddress: 'ready@x.com' },
    }));
    // Profile already exists and has login — no account file needed.
    const result = await ensureProfileForAccount('ready@x.com', accountsDir);
    assert.strictEqual(result.needsLogin, false);
    assert.strictEqual(result.created, false);
    assert.strictEqual(result.profileName, 'ready');
  });

  // Phase 12.2 regressions — live-Keychain capture for the active-account
  // isolated path. All tests below run with CLAUDE_SWITCH_DISABLE_KEYCHAIN=1
  // (the npm-test default), so the live-capture helper is a no-op by
  // contract. We assert that:
  //   1. the helper does NOT crash or short-circuit unrelated logic
  //      when the disable flag is on,
  //   2. the legacy-snapshot path keeps working unchanged,
  //   3. the helper does NOT manufacture a needsLogin=false when the
  //      legacy path can't recover (no _keychain) and Keychain is disabled.
  // The actual live capture on darwin is exercised manually — the same
  // policy already in place for tryRecoverFromLegacy since v3.5.

  it('live capture is a no-op when CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 (active email, no snapshot)', async () => {
    // Simulate: active account is "active@x.com", no legacy snapshot file
    // exists. Without Keychain access, the helper cannot fabricate
    // credentials. Result: needsLogin=true (the honest answer).
    const claudeJsonPath = path.join(tmpHome, '.claude.json');
    fs.mkdirSync(path.dirname(claudeJsonPath), { recursive: true });
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      oauthAccount: { emailAddress: 'active@x.com' },
    }));
    // No accounts file → import path → must reject (no legacy snapshot to import).
    await assert.rejects(
      () => ensureProfileForAccount('active@x.com', accountsDir),
      /No saved account for active@x\.com/,
    );
  });

  it('live capture is a no-op for non-active email (legacy path still authoritative)', async () => {
    // Pre-condition: active account is "other@x.com", but we're opening
    // isolated for "target@x.com". The live-capture branch must NOT fire
    // (email mismatch) — fall through to the existing logic.
    const claudeJsonPath = path.join(tmpHome, '.claude.json');
    fs.mkdirSync(path.dirname(claudeJsonPath), { recursive: true });
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      oauthAccount: { emailAddress: 'other@x.com' },
    }));
    fs.writeFileSync(path.join(accountsDir, 'target@x.com.json'), JSON.stringify({
      emailAddress: 'target@x.com',
    }));
    const result = await ensureProfileForAccount('target@x.com', accountsDir);
    assert.strictEqual(result.created, true);
    assert.strictEqual(result.needsLogin, true,
      'no _keychain snapshot + non-active email + Keychain disabled → genuine login required');
  });

  it('existing-profile reuse with active email + disable flag stays on legacy logic', async () => {
    // Profile exists and has a hasLogin signal in JSON. With disable flag
    // on, hasLogin is NOT demoted by Keychain absence (the v3.5 darwin
    // check is gated by the same flag), so needsLogin stays false.
    // The live-capture helper short-circuits on the disable flag —
    // confirms we didn't break this path by adding the new code.
    const claudeJsonPath = path.join(tmpHome, '.claude.json');
    fs.mkdirSync(path.dirname(claudeJsonPath), { recursive: true });
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      oauthAccount: { emailAddress: 'active@x.com' },
    }));
    const dir = createProfile('active');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      userID: 'b'.repeat(64),
      oauthAccount: { emailAddress: 'active@x.com' },
    }));
    const result = await ensureProfileForAccount('active@x.com', accountsDir);
    assert.strictEqual(result.profileName, 'active');
    assert.strictEqual(result.created, false);
    assert.strictEqual(result.needsLogin, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 12.3 — refreshLegacySnapshotIfStale consolidated inside ensureProfileForAccount
// ─────────────────────────────────────────────────────────────────────────────

describe('ensureProfileForAccount — built-in refresh (Phase 12.3)', () => {
  let accountsDir: string;
  let origDisableKc: string | undefined;

  beforeEach(() => {
    accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    origDisableKc = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
  });

  afterEach(() => {
    if (origDisableKc === undefined) delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    else process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = origDisableKc;
  });

  it('refreshes a stale snapshot and updates the account file before importing (fetch mock)', async () => {
    // Snapshot with an expired access token — simulates "dormant account".
    const staleExpiry = Date.now() - 10_000;
    const email = 'sirtheo.stale@example.com';
    const accountFile = path.join(accountsDir, `${email}.json`);
    fs.writeFileSync(accountFile, JSON.stringify({
      emailAddress: email,
      _keychain: {
        claudeAiOauth: {
          accessToken: 'old-token',
          refreshToken: 'rtok-stale',
          expiresAt: staleExpiry,
        },
      },
    }));

    // Stub globalThis.fetch to simulate a successful OAuth refresh.
    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async (_url: string | URL | Request, _opts?: RequestInit) => {
      fetchCalled = true;
      return new Response(JSON.stringify({
        access_token: 'new-token',
        refresh_token: 'rtok-stale',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      await ensureProfileForAccount(email, accountsDir);
    } finally {
      globalThis.fetch = origFetch;
    }

    assert.ok(fetchCalled, 'fetch should have been called to refresh the stale token');
    // The account file must now have the refreshed access token.
    const updated = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
    assert.strictEqual(updated._keychain.claudeAiOauth.accessToken, 'new-token',
      'account file should contain the refreshed access token after ensure');
  });

  it('does NOT call fetch when the snapshot is fresh (expiresAt far in the future)', async () => {
    const freshExpiry = Date.now() + 3_600_000;
    const email = 'sirtheo.fresh@example.com';
    const accountFile = path.join(accountsDir, `${email}.json`);
    fs.writeFileSync(accountFile, JSON.stringify({
      emailAddress: email,
      _keychain: {
        claudeAiOauth: {
          accessToken: 'valid-token',
          refreshToken: 'rtok-fresh',
          expiresAt: freshExpiry,
        },
      },
    }));

    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async (_url: string | URL | Request, _opts?: RequestInit) => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };

    try {
      await ensureProfileForAccount(email, accountsDir);
    } finally {
      globalThis.fetch = origFetch;
    }

    assert.strictEqual(fetchCalled, false, 'fetch must NOT be called when the token is still fresh');
    // Token unchanged in file.
    const unchanged = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
    assert.strictEqual(unchanged._keychain.claudeAiOauth.accessToken, 'valid-token',
      'account file access token should remain unchanged');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE_SWITCH_DEBUG_PROFILES diagnostic flag (Phase 12.1 Part A)
// ─────────────────────────────────────────────────────────────────────────────

describe('CLAUDE_SWITCH_DEBUG_PROFILES', () => {
  let tmpHome2: string;
  let accountsDir2: string;
  let origDebug: string | undefined;
  let origDisableKc: string | undefined;

  beforeEach(() => {
    tmpHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dbg-'));
    accountsDir2 = path.join(tmpHome2, 'accounts');
    fs.mkdirSync(accountsDir2, { recursive: true });
    process.env.HOME = tmpHome2;
    origDebug = process.env.CLAUDE_SWITCH_DEBUG_PROFILES;
    origDisableKc = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
  });

  afterEach(() => {
    if (origDebug === undefined) delete process.env.CLAUDE_SWITCH_DEBUG_PROFILES;
    else process.env.CLAUDE_SWITCH_DEBUG_PROFILES = origDebug;
    if (origDisableKc === undefined) delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    else process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = origDisableKc;
    fs.rmSync(tmpHome2, { recursive: true, force: true });
  });

  it('flag OFF — ensureProfileForAccount produces no debug output to stderr', async () => {
    delete process.env.CLAUDE_SWITCH_DEBUG_PROFILES;
    // Write a minimal account file so ensureProfileForAccount completes.
    fs.writeFileSync(path.join(accountsDir2, 'sirtheo.work@example.com.json'), JSON.stringify({
      emailAddress: 'sirtheo.work@example.com',
    }));

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const spy = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === 'string') stderrChunks.push(chunk);
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    process.stderr.write = spy as typeof process.stderr.write;

    try {
      await ensureProfileForAccount('sirtheo.work@example.com', accountsDir2);
    } finally {
      process.stderr.write = origWrite;
    }

    const debugLines = stderrChunks.filter(l => l.includes('[claude-switch:profiles]'));
    assert.strictEqual(debugLines.length, 0, 'No debug output expected when flag is OFF');
  });

  it('flag ON — ensureProfileForAccount emits ≥1 [claude-switch:profiles] line to stderr', async () => {
    process.env.CLAUDE_SWITCH_DEBUG_PROFILES = '1';
    fs.writeFileSync(path.join(accountsDir2, 'sirtheo.work@example.com.json'), JSON.stringify({
      emailAddress: 'sirtheo.work@example.com',
    }));

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const spy = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === 'string') stderrChunks.push(chunk);
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    process.stderr.write = spy as typeof process.stderr.write;

    try {
      await ensureProfileForAccount('sirtheo.work@example.com', accountsDir2);
    } finally {
      process.stderr.write = origWrite;
    }

    const debugLines = stderrChunks.filter(l => l.includes('[claude-switch:profiles]'));
    assert.ok(debugLines.length >= 1,
      `Expected ≥1 debug line when CLAUDE_SWITCH_DEBUG_PROFILES=1, got ${debugLines.length}`);
  });
});
