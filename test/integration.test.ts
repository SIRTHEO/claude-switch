import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCurrent, save, list, remove } from '../src/accounts.js';
import { switchTo, fuzzyMatch, savePendingRestore, checkPendingRestore, clearPendingRestore } from '../src/switcher.js';
import { setAlias, resolveAlias, getAliasesForEmail } from '../src/aliases.js';
import { setApiKey, getApiKey } from '../src/apikey.js';
import { isFallbackEnabled, setFallbackEnabled } from '../src/fallback.js';

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

describe('integration: aliases', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-int-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });

    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'work@co.com', token: 'tok-w' }
    }));
    save('work@co.com', claudeJson, accDir);
    fs.writeFileSync(path.join(accDir, 'personal@gmail.com.json'), JSON.stringify({
      emailAddress: 'personal@gmail.com', token: 'tok-p'
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('alias resolves and switches correctly', () => {
    setAlias('p', 'personal@gmail.com', accDir);
    const resolved = resolveAlias('p', accDir);
    assert.equal(resolved, 'personal@gmail.com');
    const msg = switchTo(resolved, claudeJson, accDir);
    assert.match(msg, /switched to personal@gmail.com/i);
  });

  it('getAliasesForEmail returns all aliases for an email', () => {
    setAlias('work', 'work@co.com', accDir);
    setAlias('w', 'work@co.com', accDir);
    setAlias('personal', 'personal@gmail.com', accDir);
    const aliases = getAliasesForEmail('work@co.com', accDir);
    assert.deepEqual(aliases.sort(), ['w', 'work']);
  });
});

describe('integration: pending restore (--as crash recovery)', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-int-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });

    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'work@co.com', token: 'tok-w' }
    }));
    save('work@co.com', claudeJson, accDir);
    fs.writeFileSync(path.join(accDir, 'personal@gmail.com.json'), JSON.stringify({
      emailAddress: 'personal@gmail.com', token: 'tok-p'
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and restores pending account', () => {
    savePendingRestore('work@co.com', accDir);

    switchTo('personal@gmail.com', claudeJson, accDir);
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com');

    const restored = checkPendingRestore(claudeJson, accDir);
    assert.equal(restored, 'work@co.com');
    assert.equal(getCurrent(claudeJson), 'work@co.com');

    const stateRaw = fs.readFileSync(path.join(accDir, '.claude-switch-state.json'), 'utf-8');
    assert.equal(JSON.parse(stateRaw).pendingRestore, undefined);
  });

  it('clearPendingRestore removes file', () => {
    savePendingRestore('work@co.com', accDir);
    clearPendingRestore(accDir);
    const stateRaw = fs.readFileSync(path.join(accDir, '.claude-switch-state.json'), 'utf-8');
    assert.equal(JSON.parse(stateRaw).pendingRestore, undefined);
  });

  it('checkPendingRestore returns null when no file', () => {
    const result = checkPendingRestore(claudeJson, accDir);
    assert.equal(result, null);
  });
});

describe('integration: fallback auto-sync on switch', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  // Simulate what cli.ts and select-account.ts do after switchTo:
  // check if the new account has an API key and set fallback accordingly.
  function switchAndSync(email: string): void {
    switchTo(email, claudeJson, accDir);
    setFallbackEnabled(accDir, !!getApiKey(email, accDir));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fb-sync-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });

    // Account A (with API key), account B (no key)
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    save('a@x.com', claudeJson, accDir);
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({ emailAddress: 'b@x.com' }));
    setApiKey('a@x.com', 'sk-ant-test-key', accDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enables fallback when switching to account with API key', () => {
    switchAndSync('a@x.com');
    assert.equal(isFallbackEnabled(accDir), true);
  });

  it('disables fallback when switching to account without API key', () => {
    setFallbackEnabled(accDir, true); // start with fallback on
    switchAndSync('b@x.com');
    assert.equal(isFallbackEnabled(accDir), false);
  });

  it('fallback follows the active account as you switch between accounts', () => {
    switchAndSync('a@x.com');
    assert.equal(isFallbackEnabled(accDir), true, 'on after switch to account with key');
    switchAndSync('b@x.com');
    assert.equal(isFallbackEnabled(accDir), false, 'off after switch to account without key');
    switchAndSync('a@x.com');
    assert.equal(isFallbackEnabled(accDir), true, 'on again after switching back');
  });

  it('switchToAndSyncFallback bundles switch + flip atomically', async () => {
    const { switchToAndSyncFallback } = await import('../src/switcher.js');
    setFallbackEnabled(accDir, true);

    // Switching to a key-less account with autoFlipFallback=true should
    // both load the new account AND turn fallback OFF in the SAME lock.
    const out = switchToAndSyncFallback('b@x.com', claudeJson, accDir, { autoFlipFallback: true });
    assert.equal(out.hasApiKey, false);
    assert.equal(out.fallbackFlipped, true);
    assert.equal(isFallbackEnabled(accDir), false);
    // getCurrent must reflect the new account — both reads are inside the
    // same lock so we never observe an inconsistent intermediate state.
    const { getCurrent } = await import('../src/accounts.js');
    assert.equal(getCurrent(claudeJson), 'b@x.com');
  });

  it('switchToAndSyncFallback respects autoFlipFallback=false', async () => {
    const { switchToAndSyncFallback } = await import('../src/switcher.js');
    setFallbackEnabled(accDir, true);
    const out = switchToAndSyncFallback('b@x.com', claudeJson, accDir, { autoFlipFallback: false });
    assert.equal(out.fallbackFlipped, false);
    assert.equal(isFallbackEnabled(accDir), true, 'caller opted out of auto-flip');
  });

  it('switchToAndSyncFallback is idempotent when no flip is needed', async () => {
    const { switchToAndSyncFallback } = await import('../src/switcher.js');
    // Account a@x.com has key, fallback already ON.
    setFallbackEnabled(accDir, true);
    const out = switchToAndSyncFallback('a@x.com', claudeJson, accDir, { autoFlipFallback: true });
    // Already on a@x.com so message reflects that, no flip needed.
    assert.equal(out.fallbackFlipped, false);
    assert.equal(isFallbackEnabled(accDir), true);
  });
});
