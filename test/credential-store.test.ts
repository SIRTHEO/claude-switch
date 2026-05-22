// test/credential-store.test.ts
// Unit coverage for the credential-store adapters. The rest of the suite runs
// with CLAUDE_SWITCH_DISABLE_KEYCHAIN=1, which makes every KeychainAdapter
// method early-return before its real body — so the `security` shell-out logic
// (ACL args, candidate-account loop, error redaction, bypass warnings) had no
// assertions on it at all. This file drives KeychainAdapter directly with an
// injected fake `exec`, and toggles process.platform / the disable flag at
// runtime so the darwin code path runs even on a Linux CI box.
//
// The injected exec means NO real `security` process is spawned and the real
// login Keychain is never touched, regardless of the suite-wide flag.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import {
  KeychainAdapter,
  NoopCredentialStore,
  defaultCredentialStore,
  claudeKeychainServiceFor,
  claudeKeychainAccount,
  parseClaudeOAuthItems,
  type SecurityExec,
  type KeychainData,
} from '../src/credential-store.js';

const OAUTH_SERVICE = 'Claude Code-credentials';
const APIKEY_SERVICE = 'claude-switch-apikey';
const SAMPLE: KeychainData = { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } };

// --- fake exec --------------------------------------------------------------

interface Call {
  file: string;
  args: readonly string[];
}

/** Build a fake `security` runner. `script` returns the stdout (or throws). */
function makeExec(script: (call: Call, index: number) => Buffer | string): {
  fn: SecurityExec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn: SecurityExec = (file, args) => {
    const call: Call = { file, args };
    calls.push(call);
    return script(call, calls.length - 1);
  };
  return { fn, calls };
}

function execThatThrows(stderr?: string): SecurityExec {
  return makeExec(() => {
    const e: Error & { stderr?: Buffer } = Object.assign(new Error('exec failed'), {
      stderr: stderr === undefined ? undefined : Buffer.from(stderr),
    });
    throw e;
  }).fn;
}

/** Value following `flag` in an argv (e.g. argVal(args, '-s') → service). */
function argVal(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function count(args: readonly string[], token: string): number {
  return args.filter((a) => a === token).length;
}

// --- platform / env harness -------------------------------------------------

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
}

let savedEnv: Record<string, string | undefined>;
function saveEnv(): void {
  savedEnv = {
    disable: process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN,
    nodeEnv: process.env.NODE_ENV,
    testing: process.env.CLAUDE_SWITCH_TESTING,
  };
}
function restoreEnv(): void {
  for (const [key, val] of [
    ['CLAUDE_SWITCH_DISABLE_KEYCHAIN', savedEnv.disable],
    ['NODE_ENV', savedEnv.nodeEnv],
    ['CLAUDE_SWITCH_TESTING', savedEnv.testing],
  ] as const) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

/** Put the process in "macOS, Keychain enabled" mode for the real code path. */
function enableKeychain(): void {
  setPlatform('darwin');
  delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
  delete process.env.NODE_ENV;
  delete process.env.CLAUDE_SWITCH_TESTING;
}

// ---------------------------------------------------------------------------

describe('KeychainAdapter — OAuth read', () => {
  beforeEach(() => {
    saveEnv();
    enableKeychain();
  });
  afterEach(() => {
    restorePlatform();
    restoreEnv();
  });

  it('reads + parses the blob from the first candidate account', () => {
    const { fn, calls } = makeExec(() => Buffer.from(JSON.stringify(SAMPLE)));
    const out = new KeychainAdapter(fn).readOAuth();
    assert.deepEqual(out, SAMPLE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.file, 'security');
    assert.equal(calls[0]!.args[0], 'find-generic-password');
    assert.equal(argVal(calls[0]!.args, '-s'), OAUTH_SERVICE);
    assert.equal(argVal(calls[0]!.args, '-a'), os.userInfo().username);
    assert.ok(calls[0]!.args.includes('-w'));
  });

  it('falls through to the second candidate account when the first throws', () => {
    let n = 0;
    const { fn, calls } = makeExec(() => {
      if (n++ === 0) throw new Error('not found');
      return Buffer.from(JSON.stringify(SAMPLE));
    });
    const out = new KeychainAdapter(fn).readOAuth();
    assert.deepEqual(out, SAMPLE);
    assert.equal(calls.length, 2);
    assert.equal(argVal(calls[1]!.args, '-a'), OAUTH_SERVICE);
  });

  it('returns null when every candidate throws', () => {
    assert.equal(new KeychainAdapter(execThatThrows()).readOAuth(), null);
  });

  it('returns null when the stored value is valid JSON but not an object', () => {
    const { fn } = makeExec(() => Buffer.from('42'));
    assert.equal(new KeychainAdapter(fn).readOAuth(), null);
  });

  it('returns null and never spawns exec off darwin', () => {
    setPlatform('linux');
    const { fn, calls } = makeExec(() => Buffer.from(JSON.stringify(SAMPLE)));
    assert.equal(new KeychainAdapter(fn).readOAuth(), null);
    assert.equal(calls.length, 0);
  });

  it('returns null and never spawns exec when the disable flag is set', () => {
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
    process.env.NODE_ENV = 'test'; // suppress the bypass banner here
    const { fn, calls } = makeExec(() => Buffer.from(JSON.stringify(SAMPLE)));
    assert.equal(new KeychainAdapter(fn).readOAuth(), null);
    assert.equal(calls.length, 0);
  });

  it('readOAuthForConfigDir targets the derived service + claude account', () => {
    const dir = '/tmp/sirtheo-home/profileA';
    const { fn, calls } = makeExec(() => Buffer.from(JSON.stringify(SAMPLE)));
    new KeychainAdapter(fn).readOAuthForConfigDir(dir);
    assert.equal(argVal(calls[0]!.args, '-s'), claudeKeychainServiceFor(dir));
    assert.equal(argVal(calls[0]!.args, '-a'), claudeKeychainAccount());
  });
});

describe('KeychainAdapter — OAuth write', () => {
  beforeEach(() => {
    saveEnv();
    enableKeychain();
  });
  afterEach(() => {
    restorePlatform();
    restoreEnv();
  });

  it('writes with mode, the security ACL, and the upsert flag', () => {
    const { fn, calls } = makeExec(() => Buffer.alloc(0));
    new KeychainAdapter(fn).writeOAuth(SAMPLE);
    const args = calls[0]!.args;
    assert.equal(args[0], 'add-generic-password');
    assert.equal(argVal(args, '-s'), OAUTH_SERVICE);
    assert.equal(argVal(args, '-a'), os.userInfo().username);
    assert.equal(argVal(args, '-w'), JSON.stringify(SAMPLE));
    assert.equal(argVal(args, '-T'), '/usr/bin/security');
    assert.ok(args.includes('-U'));
  });

  it('appends a -T entry for each trusted binary', () => {
    const { fn, calls } = makeExec(() => Buffer.alloc(0));
    new KeychainAdapter(fn).writeOAuthForConfigDir('/tmp/sirtheo-home/p', SAMPLE, [
      '/path/to/claude',
      '/other/bin',
    ]);
    const args = calls[0]!.args;
    assert.equal(count(args, '-T'), 3); // /usr/bin/security + the two bins
    assert.ok(args.includes('/path/to/claude'));
    assert.ok(args.includes('/other/bin'));
    assert.equal(argVal(args, '-s'), claudeKeychainServiceFor('/tmp/sirtheo-home/p'));
  });

  it('throws a redacted error (no token) when the write fails', () => {
    const adapter = new KeychainAdapter(execThatThrows('keychain is locked'));
    assert.throws(
      () => adapter.writeOAuth(SAMPLE),
      (err: Error) => {
        assert.match(err.message, /Failed to write to macOS Keychain/);
        assert.match(err.message, /keychain is locked/);
        assert.ok(!err.message.includes('accessToken'), 'token must not leak into the error');
        return true;
      },
    );
  });

  it('is a no-op off darwin', () => {
    setPlatform('linux');
    const { fn, calls } = makeExec(() => Buffer.alloc(0));
    new KeychainAdapter(fn).writeOAuth(SAMPLE);
    assert.equal(calls.length, 0);
  });

  it('deleteOAuthForConfigDir reports success / failure from exec', () => {
    const okAdapter = new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn);
    assert.equal(okAdapter.deleteOAuthForConfigDir('/tmp/sirtheo-home/p'), true);
    assert.equal(new KeychainAdapter(execThatThrows()).deleteOAuthForConfigDir('/tmp/x'), false);
  });
});

describe('KeychainAdapter — API key', () => {
  beforeEach(() => {
    saveEnv();
    enableKeychain();
  });
  afterEach(() => {
    restorePlatform();
    restoreEnv();
  });

  it('reads a trimmed key from the dedicated service', () => {
    const { fn, calls } = makeExec(() => Buffer.from('sk-ant-123\n'));
    assert.equal(new KeychainAdapter(fn).readApiKey('a@b.com'), 'sk-ant-123');
    assert.equal(argVal(calls[0]!.args, '-s'), APIKEY_SERVICE);
    assert.equal(argVal(calls[0]!.args, '-a'), 'a@b.com');
  });

  it('returns null on empty stored value, on throw, and on empty email', () => {
    assert.equal(new KeychainAdapter(makeExec(() => Buffer.from('')).fn).readApiKey('a@b.com'), null);
    assert.equal(new KeychainAdapter(execThatThrows()).readApiKey('a@b.com'), null);
    assert.equal(new KeychainAdapter(makeExec(() => Buffer.from('x')).fn).readApiKey(''), null);
  });

  it('writes with the upsert flag and reports success', () => {
    const { fn, calls } = makeExec(() => Buffer.alloc(0));
    assert.equal(new KeychainAdapter(fn).writeApiKey('a@b.com', 'sk-ant-xyz'), true);
    const args = calls[0]!.args;
    assert.equal(args[0], 'add-generic-password');
    assert.equal(argVal(args, '-s'), APIKEY_SERVICE);
    assert.equal(argVal(args, '-a'), 'a@b.com');
    assert.equal(argVal(args, '-w'), 'sk-ant-xyz');
    assert.ok(args.includes('-U'));
  });

  it('throws on empty email or empty key', () => {
    const a = new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn);
    assert.throws(() => a.writeApiKey('', 'k'));
    assert.throws(() => a.writeApiKey('a@b.com', ''));
  });

  it('throws a redacted error (no key) when the write fails', () => {
    const adapter = new KeychainAdapter(execThatThrows('locked'));
    assert.throws(
      () => adapter.writeApiKey('a@b.com', 'sk-ant-secret'),
      (err: Error) => {
        assert.match(err.message, /Failed to write API key to macOS Keychain/);
        assert.ok(!err.message.includes('sk-ant-secret'), 'key must not leak into the error');
        return true;
      },
    );
  });

  it('deleteApiKey reports success / failure from exec', () => {
    assert.equal(new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn).deleteApiKey('a@b.com'), true);
    assert.equal(new KeychainAdapter(execThatThrows()).deleteApiKey('a@b.com'), false);
  });

  it('available() reflects platform and the disable flag', () => {
    assert.equal(new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn).available(), true);
    setPlatform('linux');
    assert.equal(new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn).available(), false);
    setPlatform('darwin');
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
    process.env.NODE_ENV = 'test';
    assert.equal(new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn).available(), false);
  });
});

describe('KeychainAdapter — bypass warnings', () => {
  let written: string[];
  let realWrite: typeof process.stderr.write;

  beforeEach(() => {
    saveEnv();
    setPlatform('darwin');
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
    delete process.env.NODE_ENV;
    delete process.env.CLAUDE_SWITCH_TESTING;
    written = [];
    realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = realWrite;
    restorePlatform();
    restoreEnv();
  });

  it('warns once for OAuth bypass, then latches silent', () => {
    const adapter = new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn);
    adapter.readOAuth();
    adapter.readOAuth();
    const banners = written.filter((w) => w.includes('CLAUDE_SWITCH_DISABLE_KEYCHAIN=1'));
    assert.equal(banners.length, 1, 'OAuth bypass warning must fire exactly once');
  });

  it('suppresses the warning under NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn).readOAuth();
    assert.equal(written.length, 0);
  });

  it('suppresses the warning under CLAUDE_SWITCH_TESTING=1', () => {
    process.env.CLAUDE_SWITCH_TESTING = '1';
    new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn).readOAuth();
    assert.equal(written.length, 0);
  });

  it('emits a distinct API-key bypass message from available()', () => {
    new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn).available();
    assert.ok(written.some((w) => w.includes('API-key Keychain is bypassed')));
  });
});

describe('NoopCredentialStore', () => {
  let written: string[];
  let realWrite: typeof process.stderr.write;

  beforeEach(() => {
    saveEnv();
    written = [];
    realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = realWrite;
    restoreEnv();
  });

  it('every credential operation is null / false', () => {
    delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    const noop = new NoopCredentialStore();
    assert.equal(noop.readOAuth(), null);
    assert.equal(noop.readOAuthForConfigDir(), null);
    assert.equal(noop.deleteOAuthForConfigDir(), false);
    assert.equal(noop.available(), false);
    assert.equal(noop.readApiKey(), null);
    assert.equal(noop.writeApiKey(), false);
    assert.equal(noop.deleteApiKey(), false);
    assert.doesNotThrow(() => {
      noop.writeOAuth();
      noop.writeOAuthForConfigDir();
    });
  });

  it('available() warns once under the disable flag, still returns false', () => {
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
    delete process.env.NODE_ENV;
    delete process.env.CLAUDE_SWITCH_TESTING;
    const noop = new NoopCredentialStore();
    assert.equal(noop.available(), false);
    assert.equal(noop.available(), false);
    const banners = written.filter((w) => w.includes('API-key Keychain is bypassed'));
    assert.equal(banners.length, 1);
  });
});

describe('parseClaudeOAuthItems', () => {
  const dump = [
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'class: "genp"',
    'attributes:',
    '    "acct"<blob>="Claude Code-credentials"',
    '    "svce"<blob>="Claude Code-credentials"',
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'class: "genp"',
    'attributes:',
    '    "acct"<blob>="localuser"',
    '    "svce"<blob>="Claude Code-credentials-2937da2b"',
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'class: "genp"',
    'attributes:',
    '    "acct"<blob>="localuser"',
    '    "svce"<blob>="some-other-service"',
  ].join('\n');

  it('extracts only Claude Code-credentials items, with their accounts', () => {
    const items = parseClaudeOAuthItems(dump);
    assert.deepEqual(items, [
      { service: 'Claude Code-credentials', account: 'Claude Code-credentials' },
      { service: 'Claude Code-credentials-2937da2b', account: 'localuser' },
    ]);
  });

  it('returns empty for a dump with no Claude items', () => {
    assert.deepEqual(parseClaudeOAuthItems('keychain: "x"\n"svce"<blob>="Login"\n"acct"<blob>="me"'), []);
  });

  it('de-dupes repeated service+account pairs', () => {
    const twice = `${dump}\n${dump}`;
    assert.equal(parseClaudeOAuthItems(twice).length, 2);
  });
});

describe('KeychainAdapter — partition list', () => {
  beforeEach(() => {
    saveEnv();
    enableKeychain();
  });
  afterEach(() => {
    restorePlatform();
    restoreEnv();
  });

  it('listOAuthKeychainItems dumps the keychain and parses Claude items', () => {
    const dump = 'keychain: "k"\nclass: "genp"\n"acct"<blob>="Claude Code-credentials"\n"svce"<blob>="Claude Code-credentials"';
    const { fn, calls } = makeExec(() => Buffer.from(dump));
    const items = new KeychainAdapter(fn).listOAuthKeychainItems();
    assert.deepEqual(items, [{ service: 'Claude Code-credentials', account: 'Claude Code-credentials' }]);
    assert.equal(calls[0]!.args[0], 'dump-keychain');
  });

  it('listOAuthKeychainItems returns [] off darwin / under the disable flag / on throw', () => {
    setPlatform('linux');
    assert.deepEqual(new KeychainAdapter(makeExec(() => Buffer.from('x')).fn).listOAuthKeychainItems(), []);
    setPlatform('darwin');
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = '1';
    process.env.NODE_ENV = 'test';
    assert.deepEqual(new KeychainAdapter(makeExec(() => Buffer.from('x')).fn).listOAuthKeychainItems(), []);
    delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    delete process.env.NODE_ENV;
    assert.deepEqual(new KeychainAdapter(execThatThrows()).listOAuthKeychainItems(), []);
  });

  it('setPartitionList passes the right argv and reports success', () => {
    const { fn, calls } = makeExec(() => Buffer.alloc(0));
    const ok = new KeychainAdapter(fn).setPartitionList('Claude Code-credentials', 'localuser', 'apple-tool:');
    assert.equal(ok, true);
    const args = calls[0]!.args;
    assert.equal(args[0], 'set-generic-password-partition-list');
    assert.equal(argVal(args, '-S'), 'apple-tool:');
    assert.equal(argVal(args, '-s'), 'Claude Code-credentials');
    assert.equal(argVal(args, '-a'), 'localuser');
  });

  it('setPartitionList returns false on exec failure, empty args, off darwin', () => {
    assert.equal(new KeychainAdapter(execThatThrows()).setPartitionList('s', 'a', 'apple-tool:'), false);
    assert.equal(new KeychainAdapter(makeExec(() => Buffer.alloc(0)).fn).setPartitionList('', 'a', 'apple-tool:'), false);
    setPlatform('linux');
    const { fn, calls } = makeExec(() => Buffer.alloc(0));
    assert.equal(new KeychainAdapter(fn).setPartitionList('s', 'a', 'apple-tool:'), false);
    assert.equal(calls.length, 0);
  });
});

describe('defaultCredentialStore selection', () => {
  it('matches the host platform', () => {
    if (realPlatform === 'darwin') {
      assert.ok(defaultCredentialStore instanceof KeychainAdapter);
    } else {
      assert.ok(defaultCredentialStore instanceof NoopCredentialStore);
    }
  });
});
