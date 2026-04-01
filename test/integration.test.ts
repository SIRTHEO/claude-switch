import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCurrent, save, load, list, remove } from '../src/accounts.js';
import { switchTo, fuzzyMatch } from '../src/switcher.js';

describe('integration: full account lifecycle', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-int-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: save → list → switch → remove', () => {
    // Start with account A active
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'a@test.com', token: 'tok-a' }
    }));

    // Save account A
    save('a@test.com', claudeJson, accDir);
    assert.deepEqual(list(accDir), ['a@test.com']);

    // Simulate adding account B (write directly since we can't run auth login)
    fs.writeFileSync(path.join(accDir, 'b@test.com.json'), JSON.stringify({
      emailAddress: 'b@test.com', token: 'tok-b'
    }));
    assert.deepEqual(list(accDir).sort(), ['a@test.com', 'b@test.com']);

    // Switch to B
    const msg1 = switchTo('b@test.com', claudeJson, accDir);
    assert.match(msg1, /switched to b@test.com/i);
    assert.equal(getCurrent(claudeJson), 'b@test.com');

    // Switch back to A
    const msg2 = switchTo('a@test.com', claudeJson, accDir);
    assert.match(msg2, /switched to a@test.com/i);
    assert.equal(getCurrent(claudeJson), 'a@test.com');

    // Remove B
    remove('b@test.com', accDir);
    assert.deepEqual(list(accDir), ['a@test.com']);
  });

  it('switch preserves non-account data in claude.json', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      customSetting: 'keep-me',
      oauthAccount: { emailAddress: 'a@test.com', token: 'tok-a' }
    }));

    // Save A, prepare B
    save('a@test.com', claudeJson, accDir);
    fs.writeFileSync(path.join(accDir, 'b@test.com.json'), JSON.stringify({
      emailAddress: 'b@test.com', token: 'tok-b'
    }));

    // Switch to B
    switchTo('b@test.com', claudeJson, accDir);

    // Verify customSetting preserved
    const data = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(data.customSetting, 'keep-me');
    assert.equal(data.oauthAccount.emailAddress, 'b@test.com');
  });
});

describe('integration: fuzzy match + switch', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-int-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });

    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'work@company.com', token: 'tok-w' }
    }));
    save('work@company.com', claudeJson, accDir);
    fs.writeFileSync(path.join(accDir, 'personal@gmail.com.json'), JSON.stringify({
      emailAddress: 'personal@gmail.com', token: 'tok-p'
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fuzzy match resolves unique partial and switches', () => {
    const matches = fuzzyMatch('personal', list(accDir));
    assert.equal(matches.length, 1);
    assert.equal(matches[0], 'personal@gmail.com');

    const msg = switchTo(matches[0], claudeJson, accDir);
    assert.match(msg, /switched to personal@gmail.com/i);
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com');
  });

  it('fuzzy match returns multiple for ambiguous input', () => {
    fs.writeFileSync(path.join(accDir, 'test@company.com.json'), JSON.stringify({
      emailAddress: 'test@company.com'
    }));
    const matches = fuzzyMatch('company', list(accDir));
    assert.ok(matches.length > 1);
  });
});

describe('integration: error cases', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-int-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('switch to non-existent account throws', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    assert.throws(() => switchTo('nobody@x.com', claudeJson, accDir), /no saved account/i);
  });

  it('remove non-existent account throws', () => {
    assert.throws(() => remove('nobody@x.com', accDir), /no saved account/i);
  });

  it('getCurrent returns empty on missing file', () => {
    assert.equal(getCurrent(path.join(tmpDir, 'nonexistent.json')), '');
  });
});
