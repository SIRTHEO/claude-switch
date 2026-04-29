import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCurrent, save, load, list, remove } from '../src/accounts.js';

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
