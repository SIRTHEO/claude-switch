import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCurrent, save, load, list, remove, removeSafely, syncActiveSnapshotIfStale } from '../src/accounts.js';

describe('getCurrent', () => {
  let tmpDir: string;
  let claudeJson: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    claudeJson = path.join(tmpDir, '.claude.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns email from oauthAccount', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'test@example.com' }
    }));
    assert.equal(getCurrent(claudeJson), 'test@example.com');
  });

  it('returns empty string when no oauthAccount', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    assert.equal(getCurrent(claudeJson), '');
  });

  it('returns empty string when file does not exist', () => {
    assert.equal(getCurrent(claudeJson), '');
  });
});

describe('save', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves oauthAccount to accounts dir', () => {
    const oauthAccount = { emailAddress: 'a@b.com', token: 'tok123' };
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount }));
    save('a@b.com', claudeJson, accDir);

    const saved = JSON.parse(fs.readFileSync(path.join(accDir, 'a@b.com.json'), 'utf-8'));
    // _keychain may be present on macOS where the real Keychain is accessible.
    const { _keychain: _kc, ...metadata } = saved;
    assert.deepEqual(metadata, oauthAccount);
  });

  it('creates accounts dir if missing', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'x@y.com' } }));
    save('x@y.com', claudeJson, accDir);
    assert.ok(fs.existsSync(accDir));
  });

  it('sets 0o600 permissions on account file (unix)', () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'x@y.com' } }));
    save('x@y.com', claudeJson, accDir);
    const stat = fs.statSync(path.join(accDir, 'x@y.com.json'));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe('load', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads oauthAccount into claude.json', () => {
    const existing = { someKey: 'value', oauthAccount: { emailAddress: 'old@x.com' } };
    fs.writeFileSync(claudeJson, JSON.stringify(existing));

    const newAccount = { emailAddress: 'new@x.com', token: 'newtok' };
    fs.writeFileSync(path.join(accDir, 'new@x.com.json'), JSON.stringify(newAccount));

    load('new@x.com', claudeJson, accDir);

    const result = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(result.someKey, 'value');
    assert.deepEqual(result.oauthAccount, newAccount);
  });

  it('throws when account file does not exist', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    assert.throws(() => load('nope@x.com', claudeJson, accDir), /no saved account/i);
  });

  it('rejects symlinked account file (unix)', () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: {} }));
    const target = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(target, '{"emailAddress":"attacker@evil.com"}');
    fs.symlinkSync(target, path.join(accDir, 'victim@x.com.json'));
    assert.throws(() => load('victim@x.com', claudeJson, accDir), /symbolic link/i);
  });
});

describe('list', () => {
  let tmpDir: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns list of saved emails', () => {
    fs.writeFileSync(path.join(accDir, 'a@b.com.json'), '{}');
    fs.writeFileSync(path.join(accDir, 'c@d.com.json'), '{}');
    const result = list(accDir);
    assert.deepEqual(result.sort(), ['a@b.com', 'c@d.com']);
  });

  it('returns empty array when no accounts', () => {
    assert.deepEqual(list(accDir), []);
  });

  it('returns empty array when dir does not exist', () => {
    assert.deepEqual(list(path.join(tmpDir, 'nope')), []);
  });

  it('warns on stderr (and skips) accounts saved by older versions with chars now rejected', () => {
    // Older claude-switch used a blocklist that allowed e.g. "!" in local-part.
    // The file is still on disk but the new allowlist rejects it. Verify we
    // surface this rather than silently dropping the account from the list.
    fs.writeFileSync(path.join(accDir, 'a@b.com.json'), '{}');
    fs.writeFileSync(path.join(accDir, 'foo!bar@x.com.json'), '{}');
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = list(accDir);
      assert.deepEqual(result, ['a@b.com']);
      const stderrAll = stderrChunks.join('');
      assert.match(stderrAll, /skipped/);
      assert.match(stderrAll, /foo!bar@x\.com/);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('respects CLAUDE_SWITCH_QUIET=1 to suppress the legacy-email warning', () => {
    fs.writeFileSync(path.join(accDir, 'foo!bar@x.com.json'), '{}');
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    const prev = process.env.CLAUDE_SWITCH_QUIET;
    process.env.CLAUDE_SWITCH_QUIET = '1';
    try {
      list(accDir);
      assert.strictEqual(stderrChunks.join(''), '');
    } finally {
      process.stderr.write = origWrite;
      if (prev === undefined) delete process.env.CLAUDE_SWITCH_QUIET;
      else process.env.CLAUDE_SWITCH_QUIET = prev;
    }
  });
});

describe('save - validation', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'x@y.com' } }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects email with unsafe filesystem characters', () => {
    assert.throws(() => save('user/admin@x.com', claudeJson, accDir), /unsafe for filenames/i);
  });

  it('rejects empty email', () => {
    assert.throws(() => save('', claudeJson, accDir), /unsafe for filenames/i);
  });

  it('rejects email with path traversal', () => {
    assert.throws(() => save('../../.bashrc', claudeJson, accDir), /unsafe for filenames|outside accounts/i);
  });

  it('accepts email with + character', () => {
    save('user+tag@gmail.com', claudeJson, accDir);
    assert.ok(fs.existsSync(path.join(accDir, 'user+tag@gmail.com.json')));
  });

  it('throws clear error on corrupted claude.json', () => {
    fs.writeFileSync(claudeJson, '{invalid json!!!');
    assert.throws(() => save('a@b.com', claudeJson, accDir), /invalid JSON/i);
  });
});

describe('load - validation', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws clear error on corrupted claude.json', () => {
    fs.writeFileSync(claudeJson, 'not json');
    fs.writeFileSync(path.join(accDir, 'a@b.com.json'), '{}');
    assert.throws(() => load('a@b.com', claudeJson, accDir), /invalid JSON/i);
  });

  it('throws clear error on corrupted account file', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: {} }));
    fs.writeFileSync(path.join(accDir, 'a@b.com.json'), 'not json');
    assert.throws(() => load('a@b.com', claudeJson, accDir), /invalid JSON/i);
  });
});

describe('remove', () => {
  let tmpDir: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes account file', () => {
    fs.writeFileSync(path.join(accDir, 'a@b.com.json'), '{}');
    remove('a@b.com', accDir);
    assert.ok(!fs.existsSync(path.join(accDir, 'a@b.com.json')));
  });

  it('throws when account does not exist', () => {
    assert.throws(() => remove('nope@x.com', accDir), /no saved account/i);
  });

  it('rejects path traversal in remove', () => {
    assert.throws(() => remove('../../.bashrc', accDir), /unsafe for filenames|outside accounts/i);
  });
});

describe('save/load — API-key acceptance leak prevention', () => {
  // Regression: switching from a key-bearing account to a key-less one was
  // leaving `customApiKeyResponses.approved` (and any `apiKey` field) in
  // ~/.claude.json, so Claude Code would silently keep using the previous
  // account's API key under the new account's identity. Observed 2026-05-06.

  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-leak-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('snapshots customApiKeyResponses + apiKey into the per-account file on save', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'alice@example.com' },
      customApiKeyResponses: { approved: ['sk-ant-api03-aaa'], rejected: [] },
      apiKey: 'sk-ant-api03-aaa',
    }));
    save('alice@example.com', claudeJson, accDir);
    const stored = JSON.parse(fs.readFileSync(path.join(accDir, 'alice@example.com.json'), 'utf-8'));
    assert.deepEqual(stored._customApiKeyResponses, { approved: ['sk-ant-api03-aaa'], rejected: [] });
    assert.equal(stored._claudeJsonApiKey, 'sk-ant-api03-aaa');
  });

  it('clears customApiKeyResponses + apiKey on load when target has no snapshot', () => {
    // Simulate the bug: claude.json carries alice’s key approval, target
    // account file has no snapshot (older claude-switch never captured it).
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'alice@example.com' },
      customApiKeyResponses: { approved: ['sk-ant-api03-alice'], rejected: [] },
      apiKey: 'sk-ant-api03-alice',
    }));
    fs.writeFileSync(path.join(accDir, 'bob@example.com.json'), JSON.stringify({
      emailAddress: 'bob@example.com',
    }));
    load('bob@example.com', claudeJson, accDir);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(after.oauthAccount.emailAddress, 'bob@example.com');
    assert.equal(after.customApiKeyResponses, undefined, 'must drop the prior account key approval');
    assert.equal(after.apiKey, undefined, 'must drop the prior account apiKey field');
  });

  it('restores customApiKeyResponses + apiKey on load when claude-switch tracks an apikey for the account (Phase 14.2)', () => {
    // Restore only happens when claude-switch ALSO tracks an apikey for
    // the target (via `_apiKey` in snapshot or Keychain entry).
    // Here we include `_apiKey: '...'` so the tracker recognises bob's key.
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'alice@example.com' },
    }));
    fs.writeFileSync(path.join(accDir, 'bob@example.com.json'), JSON.stringify({
      emailAddress: 'bob@example.com',
      _apiKey: 'sk-ant-api03-bob',
      _customApiKeyResponses: { approved: ['sk-ant-api03-bob'], rejected: [] },
      _claudeJsonApiKey: 'sk-ant-api03-bob',
    }));
    load('bob@example.com', claudeJson, accDir);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.deepEqual(after.customApiKeyResponses, { approved: ['sk-ant-api03-bob'], rejected: [] });
    assert.equal(after.apiKey, 'sk-ant-api03-bob');
  });

  it('round-trip: save A, switch to B, switch back to A — A regains its own approval when A tracks an apikey', () => {
    // Setup alice WITH _apiKey so 14.2 considers her "tracked" and the
    // approval restores on switch-back.
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'alice@example.com' },
      customApiKeyResponses: { approved: ['sk-ant-api03-alice'], rejected: [] },
    }));
    fs.writeFileSync(path.join(accDir, 'alice@example.com.json'), JSON.stringify({
      emailAddress: 'alice@example.com',
      _apiKey: 'sk-ant-api03-alice',
    }));
    save('alice@example.com', claudeJson, accDir);

    // Switch to bob (no snapshot) — claude.json should be wiped.
    fs.writeFileSync(path.join(accDir, 'bob@example.com.json'), JSON.stringify({
      emailAddress: 'bob@example.com',
    }));
    load('bob@example.com', claudeJson, accDir);
    const midway = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(midway.customApiKeyResponses, undefined);

    // Switch back to alice — restore alice's snapshot (she's tracked).
    save('bob@example.com', claudeJson, accDir);
    load('alice@example.com', claudeJson, accDir);
    const restored = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.deepEqual(restored.customApiKeyResponses, { approved: ['sk-ant-api03-alice'], rejected: [] });
  });

  // ----- Silent-billing leak prevention -----

  it('Phase 14.2: load() PURGES apiKey + customApiKeyResponses when claude-switch does NOT track an apikey', () => {
    // The bug class: account file carries _claudeJsonApiKey + approval
    // hash from a past Anthropic-side prompt acceptance, but
    // claude-switch itself never had that key set (no _apiKey, no
    // Keychain entry). Pre-14.2 load() resuscitated apiKey in
    // claude.json on every switch → silent API-tier billing.
    // 14.2: refuse to restore unless claude-switch tracks the key.
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'alice@example.com' },
    }));
    fs.writeFileSync(path.join(accDir, 'leak@example.com.json'), JSON.stringify({
      emailAddress: 'leak@example.com',
      // NO _apiKey, NO Keychain entry → claude-switch doesn't track it
      _customApiKeyResponses: { approved: ['sk-ant-api03-leak'], rejected: [] },
      _claudeJsonApiKey: 'sk-ant-api03-leak',
    }));
    load('leak@example.com', claudeJson, accDir);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(after.apiKey, undefined,
      'apiKey must NOT be restored when claude-switch does not track it');
    assert.equal(after.customApiKeyResponses, undefined,
      'customApiKeyResponses must also be purged to prevent silent re-approval');
  });

  it('Phase 14.2: env escape CLAUDE_SWITCH_KEEP_UNTRACKED_APIKEY=1 preserves pre-14.2 behavior', () => {
    // One-release back-compat lever: if a user relied on the silent
    // persistence, this flag restores the old semantics so they have
    // time to migrate (e.g., explicit `claude switch apikey set`).
    const prev = process.env.CLAUDE_SWITCH_KEEP_UNTRACKED_APIKEY;
    process.env.CLAUDE_SWITCH_KEEP_UNTRACKED_APIKEY = '1';
    try {
      fs.writeFileSync(claudeJson, JSON.stringify({
        oauthAccount: { emailAddress: 'alice@example.com' },
      }));
      fs.writeFileSync(path.join(accDir, 'escape@example.com.json'), JSON.stringify({
        emailAddress: 'escape@example.com',
        _customApiKeyResponses: { approved: ['sk-ant-api03-escape'], rejected: [] },
        _claudeJsonApiKey: 'sk-ant-api03-escape',
      }));
      load('escape@example.com', claudeJson, accDir);
      const after = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
      assert.equal(after.apiKey, 'sk-ant-api03-escape',
        'env escape preserves the old restore semantics');
      assert.deepEqual(after.customApiKeyResponses,
        { approved: ['sk-ant-api03-escape'], rejected: [] });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_SWITCH_KEEP_UNTRACKED_APIKEY;
      else process.env.CLAUDE_SWITCH_KEEP_UNTRACKED_APIKEY = prev;
    }
  });

  it('does not strip _customApiKeyResponses internal field into claude.json', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' } }));
    fs.writeFileSync(path.join(accDir, 'bob@example.com.json'), JSON.stringify({
      emailAddress: 'bob@example.com',
      _customApiKeyResponses: { approved: ['sk-ant-api03-bob'], rejected: [] },
    }));
    load('bob@example.com', claudeJson, accDir);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    // Internal field name stays inside the per-account file, never bleeds
    // into the live ~/.claude.json snapshot.
    assert.equal(after._customApiKeyResponses, undefined);
    assert.equal(after.oauthAccount._customApiKeyResponses, undefined);
  });
});

describe('removeSafely', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rm-safe-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(path.join(accDir, 'a@b.com.json'), '{}');
    fs.writeFileSync(path.join(accDir, 'c@d.com.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes a non-active account', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'c@d.com' } }));
    removeSafely('a@b.com', claudeJson, accDir);
    assert.ok(!fs.existsSync(path.join(accDir, 'a@b.com.json')));
  });

  it('refuses to remove the active account', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@b.com' } }));
    assert.throws(
      () => removeSafely('a@b.com', claudeJson, accDir),
      /Cannot remove the active account/,
    );
    assert.ok(fs.existsSync(path.join(accDir, 'a@b.com.json')), 'file must remain on disk');
  });

  it('still throws ENOENT when the account file is missing', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'c@d.com' } }));
    assert.throws(() => removeSafely('nope@x.com', claudeJson, accDir), /No saved account/i);
  });
});

describe('syncActiveSnapshotIfStale', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;
  const email = 'a@b.com';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sync-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    // Seed: active account is `email`, snapshot exists for it.
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: email, accessToken: 'old-tok' },
    }));
    save(email, claudeJson, accDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-ops when claude.json is older than the snapshot', () => {
    // After save() the snapshot was written *after* claude.json, so
    // claudeJson.mtime ≤ snapshot.mtime → nothing to do.
    assert.equal(syncActiveSnapshotIfStale(claudeJson, accDir), false);
  });

  it('re-saves the snapshot when claude.json was mutated externally', () => {
    // Simulate a /login inside running claude: it rotates tokens in
    // ~/.claude.json but doesn't touch our snapshot.
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: email, accessToken: 'fresh-tok' },
    }));
    // Bump mtime explicitly past the 1s skew tolerance.
    const now = Date.now();
    fs.utimesSync(claudeJson, now / 1000, now / 1000);
    fs.utimesSync(path.join(accDir, `${email}.json`), (now - 5000) / 1000, (now - 5000) / 1000);

    assert.equal(syncActiveSnapshotIfStale(claudeJson, accDir), true);

    const snapshot = JSON.parse(fs.readFileSync(path.join(accDir, `${email}.json`), 'utf-8'));
    assert.equal(snapshot.accessToken, 'fresh-tok',
      'snapshot must reflect the externally-mutated claude.json');
  });

  it('returns false when no active account is set', () => {
    fs.writeFileSync(claudeJson, '{}');
    assert.equal(syncActiveSnapshotIfStale(claudeJson, accDir), false);
  });

  it('returns false when the snapshot file does not exist yet', () => {
    fs.rmSync(path.join(accDir, `${email}.json`));
    assert.equal(syncActiveSnapshotIfStale(claudeJson, accDir), false,
      'never silently create a snapshot for an account that was never explicitly added');
  });
});
