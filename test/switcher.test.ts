// test/switcher.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fuzzyMatch, switchTo, switchToAndSyncFallback, savePendingRestore, checkPendingRestore, clearPendingRestore } from '../src/switching/switcher.js';
import { isFallbackEnabled, setFallbackEnabledInLock } from '../src/fallback/fallback.js';
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

describe('switchToAndSyncFallback (auto-flip OAuth-aware)', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;
  let prevDisableKeychain: string | undefined;

  beforeEach(() => {
    // Force the JSON `_apiKey` fallback path so tests don't read the
    // real macOS Keychain. Mirrors the rule from architecture.md.
    prevDisableKeychain = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-flip-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'old@x.com', token: 'old' }
    }));
  });

  afterEach(() => {
    if (prevDisableKeychain === undefined) delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    else process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = prevDisableKeychain;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('leaves fallback OFF when target has OAuth + API key (the v3.5 regression fix)', () => {
    // Account file has BOTH a Keychain snapshot (OAuth) AND an API key.
    // Pre-fix the switcher would flip fallback ON purely on hasApiKey,
    // silently routing every claude request via the Anthropic Console
    // API key even when the OAuth subscription was perfectly usable.
    fs.writeFileSync(path.join(accDir, 'tech@x.com.json'), JSON.stringify({
      emailAddress: 'tech@x.com',
      token: 'oauth-token',
      _keychain: { service: 'Claude Code-credentials-aaaa', account: 'theo', value: '{}' },
      _apiKey: 'sk-ant-api03-deadbeef',
    }));

    const outcome = switchToAndSyncFallback('tech@x.com', claudeJson, accDir, { autoFlipFallback: true });

    assert.equal(outcome.hasApiKey, true, 'API key was saved on this account');
    assert.equal(isFallbackEnabled(accDir), false, 'fallback should stay OFF — OAuth is available');
    assert.equal(outcome.fallbackFlipped, false, 'no flip needed (fallback was already off)');
  });

  it('flips fallback ON when target is API-key-only (no OAuth available)', () => {
    // No `_keychain` snapshot → load() reports keychainRestored=false →
    // hasOAuth=false. The API key is the only auth source, so fallback
    // MUST be on or claude would have nothing to talk to upstream.
    fs.writeFileSync(path.join(accDir, 'keyonly@x.com.json'), JSON.stringify({
      emailAddress: 'keyonly@x.com',
      _apiKey: 'sk-ant-api03-keyonly',
    }));

    const outcome = switchToAndSyncFallback('keyonly@x.com', claudeJson, accDir, { autoFlipFallback: true });

    assert.equal(outcome.hasApiKey, true);
    assert.equal(isFallbackEnabled(accDir), true, 'fallback ON — only API key auth available');
    assert.equal(outcome.fallbackFlipped, true);
  });

  it('flips fallback OFF when switching from key-only to OAuth+key account', () => {
    // Pre-condition: fallback ON (a previous switch to a key-only
    // account left it on). Switching to an OAuth-capable account must
    // reset it OFF rather than inherit the leftover state.
    setFallbackEnabledInLock(accDir, true);
    fs.writeFileSync(path.join(accDir, 'sub@x.com.json'), JSON.stringify({
      emailAddress: 'sub@x.com',
      token: 'oauth',
      _keychain: { service: 'Claude Code-credentials-bbbb', account: 'theo', value: '{}' },
      _apiKey: 'sk-ant-api03-keepit',
    }));

    const outcome = switchToAndSyncFallback('sub@x.com', claudeJson, accDir, { autoFlipFallback: true });

    assert.equal(isFallbackEnabled(accDir), false, 'fallback flipped OFF — OAuth available');
    assert.equal(outcome.fallbackFlipped, true);
  });

  it('respects autoFlipFallback=false — never touches the flag', () => {
    setFallbackEnabledInLock(accDir, true);
    fs.writeFileSync(path.join(accDir, 'sub@x.com.json'), JSON.stringify({
      emailAddress: 'sub@x.com',
      _keychain: { service: 'Claude Code-credentials-cccc', account: 'theo', value: '{}' },
      _apiKey: 'sk-ant-api03-keepit',
    }));

    const outcome = switchToAndSyncFallback('sub@x.com', claudeJson, accDir, { autoFlipFallback: false });

    assert.equal(isFallbackEnabled(accDir), true, 'flag preserved when auto-flip is off');
    assert.equal(outcome.fallbackFlipped, false);
  });

  it('keeps fallback OFF when switching to OAuth-only account', () => {
    fs.writeFileSync(path.join(accDir, 'oauthonly@x.com.json'), JSON.stringify({
      emailAddress: 'oauthonly@x.com',
      token: 'oauth',
      _keychain: { service: 'Claude Code-credentials-dddd', account: 'theo', value: '{}' },
    }));

    const outcome = switchToAndSyncFallback('oauthonly@x.com', claudeJson, accDir, { autoFlipFallback: true });

    assert.equal(outcome.hasApiKey, false);
    assert.equal(isFallbackEnabled(accDir), false);
    assert.equal(outcome.fallbackFlipped, false);
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

  it('sets 0o600 permissions on the state file (unix)', () => {
    if (process.platform === 'win32') return;
    savePendingRestore('a@x.com', accDir);
    const stat = fs.statSync(path.join(accDir, '.claude-switch-state.json'));
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('overwrites an existing pending-restore', () => {
    savePendingRestore('first@x.com', accDir);
    savePendingRestore('second@x.com', accDir);
    const state = JSON.parse(fs.readFileSync(path.join(accDir, '.claude-switch-state.json'), 'utf-8'));
    assert.equal(state.pendingRestore, 'second@x.com');
  });

  it('creates the accounts dir if missing', () => {
    const newAcc = path.join(tmpDir, 'fresh-accounts-dir');
    assert.equal(fs.existsSync(newAcc), false);
    savePendingRestore('a@x.com', newAcc);
    assert.equal(fs.existsSync(path.join(newAcc, '.claude-switch-state.json')), true);
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
    savePendingRestore('ghost@x.com', accDir);
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
    savePendingRestore('original@x.com', accDir);

    const restored = checkPendingRestore(claudeJson, accDir);
    assert.equal(restored, 'original@x.com');

    const result = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(result.oauthAccount.emailAddress, 'original@x.com');
    const state = JSON.parse(fs.readFileSync(path.join(accDir, '.claude-switch-state.json'), 'utf-8'));
    assert.equal(state.pendingRestore, undefined, 'field cleared after successful restore');
  });

  it('clearPendingRestore drops the field if present', () => {
    savePendingRestore('a@x.com', accDir);
    clearPendingRestore(accDir);
    const state = JSON.parse(fs.readFileSync(path.join(accDir, '.claude-switch-state.json'), 'utf-8'));
    assert.equal(state.pendingRestore, undefined);
  });

  it('clearPendingRestore is a no-op when nothing is pending', () => {
    // Should not throw.
    clearPendingRestore(accDir);
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
  runTemporarySwitch,
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

function makeExitFn(): { exitFn: (code: number) => never; codes: number[] } {
  const codes: number[] = [];
  const exitFn = (code: number): never => {
    codes.push(code);
    throw new Error(`exit:${code}`);
  };
  return { exitFn, codes };
}

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
    const deps: SwitcherDeps = { process: procWith(makeSpawnFn(42)), exitFn };
    await assert.rejects(
      () => runTemporarySwitch('claude', 'me@x.com', [], claudeJson, accDir, null, deps),
      /exit:42/,
    );
    assert.deepEqual(codes, [42]);
  });

  it('exits code 1 on spawnSync error when targetEmail === current', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }));
    const { exitFn, codes } = makeExitFn();
    const deps: SwitcherDeps = { process: procWith(makeSpawnFn(0, new Error('ENOENT'))), exitFn };
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
      process: procWith(makeSpawnFn(7)),
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
