// test/switcher.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fuzzyMatch, switchTo, savePendingRestore, checkPendingRestore, clearPendingRestore } from '../src/switcher.js';

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

  it('warns when target has no Keychain blob saved', () => {
    // Account file exists but has no _keychain field — keychainRestored=false,
    // switchTo should surface the warning ("API tokens may be wrong").
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'old@x.com', token: 'old' }
    }));
    // File exists but _keychain field is absent.
    fs.writeFileSync(path.join(accDir, 'new@x.com.json'), JSON.stringify({
      emailAddress: 'new@x.com'
    }));

    const msg = switchTo('new@x.com', claudeJson, accDir);
    assert.match(msg, /switched to new@x.com/i);
    assert.match(msg, /no saved credentials/i);
    assert.match(msg, /API tokens may be wrong/i);
  });

  it('handles switch with no current account (first-time use)', () => {
    // Empty claude.json — getCurrent returns null/empty.
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    fs.writeFileSync(path.join(accDir, 'new@x.com.json'), JSON.stringify({
      emailAddress: 'new@x.com', token: 'new'
    }));

    const msg = switchTo('new@x.com', claudeJson, accDir);
    assert.match(msg, /switched to new@x.com/i);
    // No old account file should be created since there was no current.
    assert.equal(fs.existsSync(path.join(accDir, 'undefined.json')), false);
  });
});

describe('savePendingRestore', () => {
  let tmpDir: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-switch-'));
    accDir = path.join(tmpDir, 'accounts');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets 0o600 permissions on .pending-restore (unix)', () => {
    if (process.platform === 'win32') return;
    savePendingRestore('a@x.com', accDir);
    const stat = fs.statSync(path.join(accDir, '.pending-restore'));
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('overwrites an existing .pending-restore', () => {
    savePendingRestore('first@x.com', accDir);
    savePendingRestore('second@x.com', accDir);
    const content = fs.readFileSync(path.join(accDir, '.pending-restore'), 'utf-8');
    assert.equal(content, 'second@x.com');
  });

  it('creates the accounts dir if missing', () => {
    const newAcc = path.join(tmpDir, 'fresh-accounts-dir');
    assert.equal(fs.existsSync(newAcc), false);
    savePendingRestore('a@x.com', newAcc);
    assert.equal(fs.existsSync(path.join(newAcc, '.pending-restore')), true);
  });
});

describe('checkPendingRestore + clearPendingRestore', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pending-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when .pending-restore does not exist', () => {
    assert.equal(checkPendingRestore(claudeJson, accDir), null);
  });

  it('returns null when .pending-restore is empty', () => {
    fs.writeFileSync(path.join(accDir, '.pending-restore'), '');
    assert.equal(checkPendingRestore(claudeJson, accDir), null);
  });

  it('drops the marker even when restore fails (no infinite retry loop)', () => {
    // Marker points to an account that has no saved file.
    fs.writeFileSync(path.join(accDir, '.pending-restore'), 'ghost@x.com');
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    // load() will not find ghost@x.com.json — checkPendingRestore should
    // still drop the marker so the next invocation doesn't loop on it.
    checkPendingRestore(claudeJson, accDir);
    assert.equal(fs.existsSync(path.join(accDir, '.pending-restore')), false);
  });

  it('restores the saved account and returns its email on success', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'temporary@x.com' }
    }));
    fs.writeFileSync(path.join(accDir, 'original@x.com.json'), JSON.stringify({
      emailAddress: 'original@x.com', token: 'orig'
    }));
    fs.writeFileSync(path.join(accDir, '.pending-restore'), 'original@x.com');

    const restored = checkPendingRestore(claudeJson, accDir);
    assert.equal(restored, 'original@x.com');

    const result = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(result.oauthAccount.emailAddress, 'original@x.com');
    // Marker dropped after successful restore.
    assert.equal(fs.existsSync(path.join(accDir, '.pending-restore')), false);
  });

  it('clearPendingRestore removes the marker if present', () => {
    fs.writeFileSync(path.join(accDir, '.pending-restore'), 'a@x.com');
    clearPendingRestore(accDir);
    assert.equal(fs.existsSync(path.join(accDir, '.pending-restore')), false);
  });

  it('clearPendingRestore is a no-op when the marker is absent', () => {
    // Should not throw.
    clearPendingRestore(accDir);
  });
});

import {
  reAuthOutcome,
  switchInteractive,
  runTemporarySwitch,
  reAuthenticate,
  addAccount,
  type SwitcherDeps,
} from '../src/switcher.js';

describe('reAuthOutcome — re-auth decision logic', () => {
  it('success: token was broken, login fixed it (same account)', () => {
    const out = reAuthOutcome(
      'me@x.com',
      { status: 'expired' },
      'me@x.com',
      { status: 'valid' },
    );
    assert.strictEqual(out, 'me@x.com');
  });

  it('success: token was valid, refreshed (still valid)', () => {
    const out = reAuthOutcome(
      'me@x.com',
      { status: 'valid' },
      'me@x.com',
      { status: 'valid' },
    );
    assert.strictEqual(out, 'me@x.com');
  });

  it('failure: login left no active account', () => {
    const out = reAuthOutcome('me@x.com', { status: 'expired' }, '', null);
    assert.strictEqual(out, null);
  });

  it('failure: login changed the active account (silent swap)', () => {
    const out = reAuthOutcome(
      'me@x.com',
      { status: 'expired' },
      'someone-else@x.com',
      { status: 'valid' },
    );
    assert.strictEqual(out, null);
  });

  it('failure: token was broken before and is still broken after (login cancelled)', () => {
    const out = reAuthOutcome(
      'me@x.com',
      { status: 'expired' },
      'me@x.com',
      { status: 'expired' },
    );
    assert.strictEqual(out, null);
  });

  it('failure: missing → still missing (login cancelled)', () => {
    const out = reAuthOutcome(
      'me@x.com',
      { status: 'missing' },
      'me@x.com',
      { status: 'missing' },
    );
    assert.strictEqual(out, null);
  });

  it('first-time auth: no previous email, login created the account', () => {
    // emailBefore empty (no prior account) — should accept the new login
    // since there's no "previous account" to compare against.
    const out = reAuthOutcome('', null, 'me@x.com', { status: 'valid' });
    assert.strictEqual(out, 'me@x.com');
  });
});

// ─── DI-refactored function tests ────────────────────────────────────────────

function makeExitFn(): { exitFn: (code: number) => never; codes: number[] } {
  const codes: number[] = [];
  const exitFn = (code: number): never => {
    codes.push(code);
    throw new Error(`exit:${code}`);
  };
  return { exitFn, codes };
}

function makeSpawnFn(exitCode = 0, error?: Error): SwitcherDeps['spawnSyncFn'] {
  return (_cmd, _args, _opts) => ({
    pid: 1,
    output: [],
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    status: exitCode,
    signal: null,
    error,
  });
}

describe('switchInteractive — with mocked ask', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-si-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints no-accounts message when list is empty', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
    try {
      await switchInteractive(claudeJson, accDir);
    } finally {
      console.log = origLog;
    }
    assert.ok(logged.some(l => l.includes('No saved accounts')));
  });

  it('prints only-one-account message when exactly one account saved', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'a@x.com.json'), JSON.stringify({ emailAddress: 'a@x.com' }));
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
    try {
      await switchInteractive(claudeJson, accDir);
    } finally {
      console.log = origLog;
    }
    assert.ok(logged.some(l => l.includes('Only one account')));
  });

  it('switches to chosen account via injected askFn', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'a@x.com.json'), JSON.stringify({ emailAddress: 'a@x.com' }));
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({ emailAddress: 'b@x.com' }));
    const deps: SwitcherDeps = { askFn: async () => '2' };
    await switchInteractive(claudeJson, accDir, deps);
    const result = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(result.oauthAccount.emailAddress, 'b@x.com');
  });

  it('throws ExitError on invalid choice', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'a@x.com.json'), JSON.stringify({ emailAddress: 'a@x.com' }));
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({ emailAddress: 'b@x.com' }));
    const deps: SwitcherDeps = { askFn: async () => 'bad' };
    await assert.rejects(() => switchInteractive(claudeJson, accDir, deps), /Invalid choice/);
  });
});

describe('runTemporarySwitch — with mocked spawnSync + exitFn', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rts-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits with child process status when targetEmail === current', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }));
    const { exitFn, codes } = makeExitFn();
    const deps: SwitcherDeps = { spawnSyncFn: makeSpawnFn(42), exitFn };
    await assert.rejects(
      () => runTemporarySwitch('claude', 'me@x.com', [], claudeJson, accDir, null, deps),
      /exit:42/,
    );
    assert.deepEqual(codes, [42]);
  });

  it('exits code 1 on spawnSync error when targetEmail === current', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }));
    const { exitFn, codes } = makeExitFn();
    const deps: SwitcherDeps = { spawnSyncFn: makeSpawnFn(0, new Error('ENOENT')), exitFn };
    await assert.rejects(
      () => runTemporarySwitch('claude', 'me@x.com', [], claudeJson, accDir, null, deps),
      /exit:1/,
    );
    assert.deepEqual(codes, [1]);
  });

  it('saves pending restore, swaps account, exits with child status', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'a@x.com.json'), JSON.stringify({ emailAddress: 'a@x.com' }));
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({ emailAddress: 'b@x.com', _keychain: 'yes' }));
    const { exitFn, codes } = makeExitFn();
    const deps: SwitcherDeps = {
      spawnSyncFn: makeSpawnFn(7),
      exitFn,
      saveFn: (email, sourcePath, accountsPath) => {
        const data = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
        fs.writeFileSync(path.join(accountsPath, `${email}.json`), JSON.stringify(data.oauthAccount));
      },
      loadFn: (email, targetPath, accountsPath) => {
        const account = JSON.parse(fs.readFileSync(path.join(accountsPath, `${email}.json`), 'utf-8'));
        fs.writeFileSync(targetPath, JSON.stringify({ oauthAccount: account }));
        return { keychainRestored: false };
      },
    };
    await assert.rejects(
      () => runTemporarySwitch('claude', 'b@x.com', [], claudeJson, accDir, null, deps),
      /exit:7/,
    );
    assert.deepEqual(codes, [7]);
    // claude.json should have been restored to original after restoreOriginal()
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(after.oauthAccount.emailAddress, 'a@x.com');
  });
});

describe('reAuthenticate — with mocked spawnSync', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reauth-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when login leaves no active account', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    const deps: SwitcherDeps = { spawnSyncFn: makeSpawnFn(0) };
    const result = await reAuthenticate('claude', claudeJson, accDir, deps);
    assert.strictEqual(result, null);
  });

  it('returns email and saves account when login succeeds', async () => {
    // Simulate: before=expired, spawn writes new token to claudeJson.
    // getTokenHealth reads account.accessToken and account.expiresAt at the
    // oauthAccount level (not inside tokenInfo).
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'me@x.com', accessToken: 'tok-old', expiresAt: 1 },
    }));
    const spawnFn: SwitcherDeps['spawnSyncFn'] = (cmd, args, opts) => {
      // Simulate login: write fresh token
      fs.writeFileSync(claudeJson, JSON.stringify({
        oauthAccount: { emailAddress: 'me@x.com', accessToken: 'tok-fresh', expiresAt: Date.now() + 9_999_999 },
      }));
      return makeSpawnFn(0)!(cmd, args, opts);
    };
    const deps: SwitcherDeps = {
      spawnSyncFn: spawnFn,
      getTokenHealthFn: pathToRead => {
        const data = JSON.parse(fs.readFileSync(pathToRead, 'utf-8'));
        const expiresAt = data.oauthAccount?.expiresAt ?? 0;
        return expiresAt > Date.now() ? { status: 'valid' } : { status: 'expired' };
      },
    };
    const result = await reAuthenticate('claude', claudeJson, accDir, deps);
    assert.strictEqual(result, 'me@x.com');
    assert.ok(fs.existsSync(path.join(accDir, 'me@x.com.json')));
  });
});

describe('addAccount — with mocked ask + spawnSync', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-addacc-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws ExitError when spawnSync leaves no account', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    const answers = ['new@x.com'];
    const deps: SwitcherDeps = {
      askFn: async () => answers.shift() ?? '',
      spawnSyncFn: makeSpawnFn(0),
    };
    await assert.rejects(() => addAccount('claude', claudeJson, accDir, deps), /Login failed/);
  });

  it('detects login cancelled when email unchanged after spawn', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'curr@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'curr@x.com.json'), JSON.stringify({ emailAddress: 'curr@x.com' }));
    const answers = [''];
    const deps: SwitcherDeps = {
      askFn: async () => answers.shift() ?? '',
      spawnSyncFn: makeSpawnFn(0),
    };
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
    try {
      await addAccount('claude', claudeJson, accDir, deps);
    } finally {
      console.log = origLog;
    }
    assert.ok(logged.some(l => l.includes('Login cancelled')));
  });

  it('saves new account and sets alias when login succeeds', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'curr@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'curr@x.com.json'), JSON.stringify({ emailAddress: 'curr@x.com' }));
    const answers = ['new@x.com', 'myalias'];
    const spawnFn: SwitcherDeps['spawnSyncFn'] = (cmd, args, opts) => {
      fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'new@x.com' } }));
      return makeSpawnFn(0)!(cmd, args, opts);
    };
    const deps: SwitcherDeps = {
      askFn: async () => answers.shift() ?? '',
      spawnSyncFn: spawnFn,
    };
    await addAccount('claude', claudeJson, accDir, deps);
    assert.ok(fs.existsSync(path.join(accDir, 'new@x.com.json')));
  });
});
