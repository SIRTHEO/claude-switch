// test/switcher.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fuzzyMatch, switchTo } from '../src/switcher.js';

describe('fuzzyMatch', () => {
  const accounts = ['work@company.com', 'personal@gmail.com', 'test@company.com'];

  it('returns exact match', () => {
    assert.deepEqual(fuzzyMatch('work@company.com', accounts), ['work@company.com']);
  });

  it('returns single partial match', () => {
    assert.deepEqual(fuzzyMatch('personal', accounts), ['personal@gmail.com']);
  });

  it('returns multiple matches when ambiguous', () => {
    assert.deepEqual(fuzzyMatch('company', accounts), ['work@company.com', 'test@company.com']);
  });

  it('returns empty when no match', () => {
    assert.deepEqual(fuzzyMatch('nope', accounts), []);
  });

  it('is case-insensitive', () => {
    assert.deepEqual(fuzzyMatch('PERSONAL', accounts), ['personal@gmail.com']);
  });
});

describe('switchTo', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-switch-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('switches to target account', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'old@x.com', token: 'old' }
    }));
    fs.writeFileSync(path.join(accDir, 'new@x.com.json'), JSON.stringify({
      emailAddress: 'new@x.com', token: 'new'
    }));

    const msg = switchTo('new@x.com', claudeJson, accDir);
    assert.match(msg, /switched to new@x.com/i);

    const result = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(result.oauthAccount.emailAddress, 'new@x.com');
  });

  it('saves current account before switching', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'old@x.com', token: 'old' }
    }));
    fs.writeFileSync(path.join(accDir, 'new@x.com.json'), JSON.stringify({
      emailAddress: 'new@x.com', token: 'new'
    }));

    switchTo('new@x.com', claudeJson, accDir);
    const savedOld = JSON.parse(fs.readFileSync(path.join(accDir, 'old@x.com.json'), 'utf-8'));
    assert.equal(savedOld.token, 'old');
  });

  it('returns already-active message when switching to current', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'a@x.com' }
    }));

    const msg = switchTo('a@x.com', claudeJson, accDir);
    assert.match(msg, /already on/i);
  });
});
