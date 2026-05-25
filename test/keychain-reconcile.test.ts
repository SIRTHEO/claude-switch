import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileClaudeCodeKeychain, type SecurityExec } from '../src/credentials/keychain-reconcile.js';
import { FileCredentialStore, defaultCredentialsFilePath } from '../src/credentials/file-credential-store.js';

// reconcile shells out to `security` (faked here) and writes the file vault
// under $HOME. Redirect HOME to a temp dir and fake the exec so no real
// Keychain or real home is touched. Force darwin + clear the gating flags so
// the production code path runs.

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let savedEnv: Record<string, string | undefined>;
let savedPlatform: PropertyDescriptor | undefined;

function setPlatform(p: NodeJS.Platform): void {
  savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: p, configurable: true, writable: true });
}

const SAMPLE = { claudeAiOauth: { accessToken: 'sk-ant-oat01-X', refreshToken: 'r', expiresAt: 1 } };

interface Call { args: readonly string[]; }
function makeExec(script: (call: Call) => Buffer | string): { fn: SecurityExec; calls: Call[] } {
  const calls: Call[] = [];
  const fn: SecurityExec = (_file, args) => {
    const call: Call = { args };
    calls.push(call);
    return script(call);
  };
  return { fn, calls };
}
const isProbe = (a: readonly string[]) => a[0] === 'find-generic-password' && !a.includes('-w');
const isRead = (a: readonly string[]) => a[0] === 'find-generic-password' && a.includes('-w');
const isDelete = (a: readonly string[]) => a[0] === 'delete-generic-password';

describe('reconcileClaudeCodeKeychain', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-recon-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    // os.homedir() reads USERPROFILE on Windows regardless of the faked
    // process.platform below, so redirect both to keep the temp home isolated.
    process.env.USERPROFILE = tmpHome;
    savedEnv = {
      disable: process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN,
      noPrompt: process.env.CLAUDE_SWITCH_NO_KEYCHAIN_PROMPT,
      useKc: process.env.CLAUDE_SWITCH_USE_KEYCHAIN,
    };
    delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    delete process.env.CLAUDE_SWITCH_NO_KEYCHAIN_PROMPT;
    delete process.env.CLAUDE_SWITCH_USE_KEYCHAIN;
    setPlatform('darwin');
  });
  afterEach(() => {
    if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    for (const [k, key] of [['disable', 'CLAUDE_SWITCH_DISABLE_KEYCHAIN'], ['noPrompt', 'CLAUDE_SWITCH_NO_KEYCHAIN_PROMPT'], ['useKc', 'CLAUDE_SWITCH_USE_KEYCHAIN']] as const) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('absorbs a present item into the vault then deletes it', () => {
    let deleted = false;
    const { fn, calls } = makeExec((call) => {
      if (isProbe(call.args)) {
        // first candidate (username) exists, second (legacy) does not
        return call.args.includes(os.userInfo().username) ? Buffer.from('') : (() => { throw new Error('not found'); })();
      }
      if (isRead(call.args)) return Buffer.from(JSON.stringify(SAMPLE));
      if (isDelete(call.args)) { deleted = true; return Buffer.from('deleted'); }
      return Buffer.from('');
    });
    const n = reconcileClaudeCodeKeychain({ exec: fn, fileStore: new FileCredentialStore() });
    assert.equal(n, 1, 'one item absorbed');
    assert.ok(deleted, 'item deleted after absorb');
    // vault now holds the tokens
    const written = JSON.parse(fs.readFileSync(defaultCredentialsFilePath(), 'utf-8'));
    assert.deepEqual(written, SAMPLE);
    // order: probe → read → delete (read before delete)
    const readIdx = calls.findIndex(c => isRead(c.args));
    const delIdx = calls.findIndex(c => isDelete(c.args));
    assert.ok(readIdx >= 0 && delIdx > readIdx, 'read precedes delete');
  });

  it('is a no-op when no item exists (steady state)', () => {
    const { fn } = makeExec((call) => {
      if (isProbe(call.args)) throw new Error('item not found (44)');
      throw new Error('should not read/delete when probe says absent');
    });
    const n = reconcileClaudeCodeKeychain({ exec: fn, fileStore: new FileCredentialStore() });
    assert.equal(n, 0);
    assert.equal(fs.existsSync(defaultCredentialsFilePath()), false, 'no vault write on no-op');
  });

  it('still deletes a present-but-unreadable item (no absorb, but cleared)', () => {
    let deleted = false;
    const { fn } = makeExec((call) => {
      if (isProbe(call.args)) return call.args.includes(os.userInfo().username) ? Buffer.from('') : (() => { throw new Error('absent'); })();
      if (isRead(call.args)) throw new Error('locked / would prompt');
      if (isDelete(call.args)) { deleted = true; return Buffer.from('deleted'); }
      return Buffer.from('');
    });
    const n = reconcileClaudeCodeKeychain({ exec: fn, fileStore: new FileCredentialStore() });
    assert.equal(n, 0, 'nothing absorbed (read failed)');
    assert.ok(deleted, 'unreadable item still deleted so Claude Code stops preferring it');
  });

  it('skips off-darwin', () => {
    setPlatform('linux');
    let called = false;
    const { fn } = makeExec(() => { called = true; return Buffer.from(''); });
    assert.equal(reconcileClaudeCodeKeychain({ exec: fn, fileStore: new FileCredentialStore() }), 0);
    assert.equal(called, false, 'no security spawn off-darwin');
  });

  it('skips under CLAUDE_SWITCH_DISABLE_KEYCHAIN=1', () => {
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
    let called = false;
    const { fn } = makeExec(() => { called = true; return Buffer.from(''); });
    assert.equal(reconcileClaudeCodeKeychain({ exec: fn, fileStore: new FileCredentialStore() }), 0);
    assert.equal(called, false);
  });

  it('skips under CLAUDE_SWITCH_NO_KEYCHAIN_PROMPT=1 (background processes)', () => {
    process.env.CLAUDE_SWITCH_NO_KEYCHAIN_PROMPT = '1';
    let called = false;
    const { fn } = makeExec(() => { called = true; return Buffer.from(''); });
    assert.equal(reconcileClaudeCodeKeychain({ exec: fn, fileStore: new FileCredentialStore() }), 0);
    assert.equal(called, false, 'background processes never drain (could stall on a prompt)');
  });

  it('skips under CLAUDE_SWITCH_USE_KEYCHAIN=1 (opt-in legacy backend)', () => {
    process.env.CLAUDE_SWITCH_USE_KEYCHAIN = '1';
    let called = false;
    const { fn } = makeExec(() => { called = true; return Buffer.from(''); });
    assert.equal(reconcileClaudeCodeKeychain({ exec: fn, fileStore: new FileCredentialStore() }), 0);
    assert.equal(called, false);
  });

  it('drains both candidate accounts when both items exist', () => {
    const deletedAccts: string[] = [];
    const { fn } = makeExec((call) => {
      if (isProbe(call.args)) return Buffer.from(''); // both exist
      if (isRead(call.args)) return Buffer.from(JSON.stringify(SAMPLE));
      if (isDelete(call.args)) {
        const a = call.args[call.args.indexOf('-a') + 1];
        deletedAccts.push(a as string);
        return Buffer.from('deleted');
      }
      return Buffer.from('');
    });
    const n = reconcileClaudeCodeKeychain({ exec: fn, fileStore: new FileCredentialStore() });
    assert.equal(n, 2, 'both candidates absorbed');
    assert.equal(deletedAccts.length, 2, 'both deleted');
  });
});
