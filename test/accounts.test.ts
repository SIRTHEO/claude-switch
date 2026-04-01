import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCurrent, save, load } from '../src/accounts.js';

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
    assert.deepEqual(saved, oauthAccount);
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
});
