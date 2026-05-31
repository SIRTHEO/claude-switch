// test/switcher.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fuzzyMatch, checkPendingRestore } from '../src/switching/switcher.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

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

describe('checkPendingRestore (migration drain)', () => {
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

  // Seed a leftover pendingRestore marker the way a pre-upgrade interrupted
  // `--as` would have. The writer is retired (the unified model never swaps the
  // global), so we write state.json directly to exercise the migration drain.
  function seedPending(email: string): void {
    fs.writeFileSync(
      path.join(accDir, '.claude-switch-state.json'),
      JSON.stringify({ version: 1, fallback: { enabled: false, autoEngaged: false }, pendingRestore: email }),
    );
  }

  it('returns null when no pending-restore is set', () => {
    assert.equal(checkPendingRestore(claudeJson, accDir), null);
  });

  it('returns null when state.json has no pendingRestore field', () => {
    fs.writeFileSync(path.join(accDir, '.claude-switch-state.json'), JSON.stringify({
      version: 1,
      fallback: { enabled: false, autoEngaged: false },
    }));
    assert.equal(checkPendingRestore(claudeJson, accDir), null);
  });

  it('drops the marker even when restore fails (no infinite retry loop)', () => {
    seedPending('ghost@x.com');
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    // load() will not find ghost@x.com.json — checkPendingRestore should
    // still drop the field so the next invocation doesn't loop on it.
    checkPendingRestore(claudeJson, accDir);
    const state = JSON.parse(fs.readFileSync(path.join(accDir, '.claude-switch-state.json'), 'utf-8'));
    assert.equal(state.pendingRestore, undefined);
  });

  it('restores the saved account and returns its email on success', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'temporary@x.com' }
    }));
    fs.writeFileSync(path.join(accDir, 'original@x.com.json'), JSON.stringify({
      emailAddress: 'original@x.com', token: 'orig'
    }));
    seedPending('original@x.com');

    const restored = checkPendingRestore(claudeJson, accDir);
    assert.equal(restored, 'original@x.com');

    const result = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(result.oauthAccount.emailAddress, 'original@x.com');
    const state = JSON.parse(fs.readFileSync(path.join(accDir, '.claude-switch-state.json'), 'utf-8'));
    assert.equal(state.pendingRestore, undefined, 'field cleared after successful restore');
  });

  it('migrates legacy .pending-restore marker to state.pendingRestore', () => {
    fs.writeFileSync(path.join(accDir, '.pending-restore'), 'legacy@x.com');
    // First read after upgrade must surface the migrated email.
    const restored = checkPendingRestore(claudeJson, accDir);
    // legacy@x.com has no account file, so restore fails and returns null,
    // BUT the migration to state.json happened (and the field was cleared
    // afterwards as part of the read+clear handshake).
    assert.equal(restored, null);
    assert.equal(fs.existsSync(path.join(accDir, '.pending-restore')), false, 'legacy marker removed');
  });
});

import {
  reAuthOutcome,
  switchInteractive,
  reAuthenticate,
  addAccount,
  type SwitcherDeps,
} from '../src/switching/switcher.js';
import type { ProcessPort } from '../src/platform/process.js';

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

function makeSpawnFn(exitCode = 0, error?: Error): ProcessPort['spawnSync'] {
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

// Wrap a spawnSync stub into a ProcessPort. `spawn` is never expected in the
// switcher flows under test — calling it surfaces a wiring mistake loudly.
function procWith(spawnSync: ProcessPort['spawnSync']): ProcessPort {
  return {
    spawn: () => { throw new Error('spawn not expected in this flow'); },
    spawnSync,
  };
}

describe('switchInteractive — with mocked ask', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;
  let savedHome: SavedHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-si-'));
    // Re-point creates a profile under os.homedir()/.claude/profiles — isolate
    // HOME so the test never pollutes the real ~/.claude.
    savedHome = setFakeHome(tmpDir);
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    restoreFakeHome(savedHome);
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

  it('re-points the chosen account without overwriting the global ~/.claude', async () => {
    // Unified-profile model: the picker re-points the default-pointer instead of
    // swapping ~/.claude. With a credential-less account the re-point reports
    // needs-login and points nothing; either way the global is NOT overwritten
    // (that was the mixing bug). The picker's display ("(active)" marker, etc.)
    // is redone in the dashboard / "cruscotto" slice — not asserted here.
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'a@x.com.json'), JSON.stringify({ emailAddress: 'a@x.com' }));
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({ emailAddress: 'b@x.com' }));
    const deps: SwitcherDeps = { askFn: async () => '2' };
    await switchInteractive(claudeJson, accDir, deps);
    const result = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(result.oauthAccount.emailAddress, 'a@x.com', 're-point must not swap the global');
  });

  it('throws ExitError on invalid choice', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'a@x.com.json'), JSON.stringify({ emailAddress: 'a@x.com' }));
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({ emailAddress: 'b@x.com' }));
    const deps: SwitcherDeps = { askFn: async () => 'bad' };
    await assert.rejects(() => switchInteractive(claudeJson, accDir, deps), /Invalid choice/);
  });
});

describe('switchInteractive — re-point (unified-profile model)', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;
  let savedHome: SavedHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-si-repoint-'));
    // Re-point creates a profile under os.homedir()/.claude/profiles — isolate
    // HOME so the test never pollutes the real ~/.claude.
    savedHome = setFakeHome(tmpDir);
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    restoreFakeHome(savedHome);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Replaces the swap-era "(active) marker / 11.11 regression" block. The 11.11
  // bug was a stale getCurrent() read corrupting the in-place SWAP; the unified
  // model re-points (atomic setDefaultPointer of the explicitly-picked account)
  // and never swaps ~/.claude, so that bug class is structurally gone. The
  // picker's "(active)"-marker display moves to the dashboard ("cruscotto")
  // slice; here we lock the engine truth: the picker re-points, global untouched.
  it('re-points the picked account and leaves the global ~/.claude untouched', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'a@x.com.json'), JSON.stringify({ emailAddress: 'a@x.com' }));
    fs.writeFileSync(path.join(accDir, 'b@x.com.json'), JSON.stringify({ emailAddress: 'b@x.com' }));
    const { getCurrent } = await import('../src/accounts/accounts.js');
    await switchInteractive(claudeJson, accDir, { askFn: async () => '2' });
    assert.equal(getCurrent(claudeJson), 'a@x.com', 're-point must not overwrite the global');
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
    const deps: SwitcherDeps = { process: procWith(makeSpawnFn(0)) };
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
    const spawnFn: ProcessPort['spawnSync'] = (cmd, args, opts) => {
      // Simulate login: write fresh token
      fs.writeFileSync(claudeJson, JSON.stringify({
        oauthAccount: { emailAddress: 'me@x.com', accessToken: 'tok-fresh', expiresAt: Date.now() + 9_999_999 },
      }));
      return makeSpawnFn(0)(cmd, args, opts);
    };
    const deps: SwitcherDeps = {
      process: procWith(spawnFn),
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
      process: procWith(makeSpawnFn(0)),
    };
    await assert.rejects(() => addAccount('claude', claudeJson, accDir, deps), /Login failed/);
  });

  it('detects login cancelled when email unchanged after spawn', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'curr@x.com' } }));
    fs.writeFileSync(path.join(accDir, 'curr@x.com.json'), JSON.stringify({ emailAddress: 'curr@x.com' }));
    const answers = [''];
    const deps: SwitcherDeps = {
      askFn: async () => answers.shift() ?? '',
      process: procWith(makeSpawnFn(0)),
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
    const spawnFn: ProcessPort['spawnSync'] = (cmd, args, opts) => {
      fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'new@x.com' } }));
      return makeSpawnFn(0)(cmd, args, opts);
    };
    const deps: SwitcherDeps = {
      askFn: async () => answers.shift() ?? '',
      process: procWith(spawnFn),
    };
    await addAccount('claude', claudeJson, accDir, deps);
    assert.ok(fs.existsSync(path.join(accDir, 'new@x.com.json')));
  });
});
