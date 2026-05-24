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

  it('probes metadata then reads the blob from the existing candidate account', () => {
    // The new probe-first read pattern (no-dialog regression fix): the
    // adapter first calls `security find-generic-password -s SERVICE -a ACCT`
    // WITHOUT `-w` for each candidate to see which item exists, then issues
    // the read (with `-w`) only against the existing one. The probe never
    // raises a macOS authorization dialog because it doesn't touch the
    // encrypted blob, so probing both candidates is free.
    const { fn, calls } = makeExec(() => Buffer.from(JSON.stringify(SAMPLE)));
    const out = new KeychainAdapter(fn).readOAuth();
    assert.deepEqual(out, SAMPLE);
    // 2 probes (one per candidate, both reported as existing by the fake)
    // + 1 read of the first existing candidate (the OS username).
    assert.equal(calls.length, 3);
    // Probes are calls 0 and 1 (no `-w`); the read is call 2 (has `-w`).
    assert.ok(!calls[0]!.args.includes('-w'), 'probe 1 must not pass -w');
    assert.ok(!calls[1]!.args.includes('-w'), 'probe 2 must not pass -w');
    assert.ok(calls[2]!.args.includes('-w'), 'read must pass -w');
    assert.equal(calls[2]!.file, 'security');
    assert.equal(calls[2]!.args[0], 'find-generic-password');
    assert.equal(argVal(calls[2]!.args, '-s'), OAUTH_SERVICE);
    assert.equal(argVal(calls[2]!.args, '-a'), os.userInfo().username);
  });

  it('skips the read entirely for a candidate whose probe says "not present"', () => {
    // The first probe (username) says "not present" → that candidate is
    // dropped, no read is attempted against it (which would have prompted
    // for a password under macOS), so the dialog cascade is broken. The
    // second probe (legacy service name) says "present" → only that one is
    // read, with `-w`.
    let probeIdx = 0;
    const { fn, calls } = makeExec((call) => {
      const isProbe = !call.args.includes('-w');
      if (isProbe) {
        const presentForLegacy = probeIdx++ === 1; // probe 0 = username (absent), probe 1 = legacy (present)
        if (!presentForLegacy) throw new Error('item not found (44)');
        return Buffer.from('');
      }
      return Buffer.from(JSON.stringify(SAMPLE));
    });
    const out = new KeychainAdapter(fn).readOAuth();
    assert.deepEqual(out, SAMPLE);
    // 2 probes + 1 read against the legacy account only.
    assert.equal(calls.length, 3);
    assert.equal(argVal(calls[2]!.args, '-a'), OAUTH_SERVICE);
    assert.ok(calls[2]!.args.includes('-w'));
  });

  it('returns null when no candidate exists (no read attempt, no dialog)', () => {
    // Both probes throw → no candidate exists → readOAuth returns null
    // without ever attempting a `-w` read. This is the critical guarantee
    // that prevents the spurious-dialog regression on a fresh machine.
    const { fn, calls } = makeExec(() => { throw new Error('item not found (44)'); });
    assert.equal(new KeychainAdapter(fn).readOAuth(), null);
    // Only 2 probes — never any read.
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(!call.args.includes('-w'), 'no read with -w was attempted');
    }
  });

  it('returns null when the stored value is valid JSON but not an object', () => {
    // probe says present, read returns "42" — must reject (not an OAuth blob).
    let probed = false;
    const { fn } = makeExec((call) => {
      const isProbe = !call.args.includes('-w');
      if (isProbe) {
        probed = true;
        return Buffer.from('');
      }
      return Buffer.from('42');
    });
    assert.equal(new KeychainAdapter(fn).readOAuth(), null);
    assert.ok(probed, 'probe must have happened');
  });

  it('auto-applies partition-list when the silent read fails, then succeeds (23.8)', () => {
    // Scenario: item exists (probe OK), but the silent read returns ""
    // because the ACL would prompt. The adapter should call
    // set-generic-password-partition-list to widen the partition, then
    // re-attempt the silent read and succeed. The user pays a single
    // password prompt (for the partition-list write) instead of one per
    // read forever — durable fix.
    //
    // The fake `security` exec produces:
    //   - probe (no -w): "" (exists)
    //   - first silent read with -w: throws (silent read failed)
    //   - set-generic-password-partition-list: "" (success)
    //   - second silent read with -w: SAMPLE blob
    let readWithWAttempts = 0;
    let setPartitionListCalled = false;
    const { fn, calls } = makeExec((call) => {
      if (call.args[0] === 'set-generic-password-partition-list') {
        setPartitionListCalled = true;
        return Buffer.from('');
      }
      const hasW = call.args.includes('-w');
      if (!hasW) return Buffer.from(''); // probe success
      readWithWAttempts++;
      if (readWithWAttempts === 1) throw new Error('would prompt');
      return Buffer.from(JSON.stringify(SAMPLE));
    });
    const out = new KeychainAdapter(fn).readOAuth();
    assert.deepEqual(out, SAMPLE);
    assert.ok(setPartitionListCalled, 'set-generic-password-partition-list was attempted');
    // 1 probe (username) + 1 probe (legacy) + 1 failed -w + 1 setPartitionList + 1 retry -w
    // Order matters: probes come first for the first candidate found.
    const partitionListIdx = calls.findIndex(c => c.args[0] === 'set-generic-password-partition-list');
    assert.ok(partitionListIdx >= 0, 'setPartitionList in call sequence');
    // The probes (cmd `find-generic-password` without -w) precede the
    // partition-list mutation.
    assert.ok(calls.slice(0, partitionListIdx).some(c => c.args[0] === 'find-generic-password' && !c.args.includes('-w')),
      'a metadata probe ran before the partition-list mutation');
  });

  it('skips auto-partition when CLAUDE_SWITCH_NO_AUTO_PARTITION=1', () => {
    process.env.CLAUDE_SWITCH_NO_AUTO_PARTITION = '1';
    try {
      let setCalled = false;
      let wAttempts = 0;
      const { fn } = makeExec((call) => {
        if (call.args[0] === 'set-generic-password-partition-list') {
          setCalled = true;
          return Buffer.from('');
        }
        const hasW = call.args.includes('-w');
        if (!hasW) return Buffer.from(''); // probe ok
        wAttempts++;
        // First -w invocation is the silent read (1s timeout). Throw so it
        // resolves to "ACL would prompt". The classic fallback then issues
        // ANOTHER -w invocation (no timeout) which we satisfy.
        if (wAttempts === 1) throw new Error('would prompt (silent)');
        return Buffer.from(JSON.stringify(SAMPLE));
      });
      const out = new KeychainAdapter(fn).readOAuth();
      assert.deepEqual(out, SAMPLE);
      assert.equal(setCalled, false, 'partition-list NOT auto-applied when opted out');
    } finally {
      delete process.env.CLAUDE_SWITCH_NO_AUTO_PARTITION;
    }
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
    // The write path now probes for partition-list state first (23.9); the
    // actual add-generic-password call is the last `add-generic-password`
    // invocation in the call list.
    const writeCall = calls.find(c => c.args[0] === 'add-generic-password');
    assert.ok(writeCall, 'add-generic-password was issued');
    const args = writeCall.args;
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
    const writeCall = calls.find(c => c.args[0] === 'add-generic-password');
    assert.ok(writeCall, 'add-generic-password was issued');
    const args = writeCall.args;
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

  it('auto-applies partition-list before write when existing item would prompt (23.9)', () => {
    // Scenario: an item already exists (Claude Code wrote it with its own
    // restrictive partition-list); a silent read confirms the OS would
    // prompt; the adapter applies set-generic-password-partition-list FIRST
    // so the subsequent add-generic-password -U is silent.
    let setPartitionCalled = false;
    let wAttempts = 0;
    const { fn } = makeExec((call) => {
      if (call.args[0] === 'set-generic-password-partition-list') {
        setPartitionCalled = true;
        return Buffer.from('');
      }
      const hasW = call.args.includes('-w');
      if (!hasW) return Buffer.from(''); // probe says item exists
      if (call.args[0] === 'find-generic-password') {
        // silent read first → throw to signal "ACL would prompt"
        wAttempts++;
        if (wAttempts === 1) throw new Error('would prompt');
        return Buffer.from('');
      }
      // add-generic-password (the actual write) — succeeds silently after
      // the partition-list was widened
      return Buffer.from('');
    });
    new KeychainAdapter(fn).writeOAuth(SAMPLE);
    assert.ok(setPartitionCalled, 'partition-list applied before write');
  });

  it('skips auto-partition on write when item does NOT exist yet (no probe match)', () => {
    // Fresh item path: nothing to widen because the item is being created.
    let setPartitionCalled = false;
    const { fn } = makeExec((call) => {
      if (call.args[0] === 'set-generic-password-partition-list') {
        setPartitionCalled = true;
        return Buffer.from('');
      }
      const hasW = call.args.includes('-w');
      if (!hasW) throw new Error('item not found (44)'); // probe miss
      return Buffer.from('');
    });
    new KeychainAdapter(fn).writeOAuth(SAMPLE);
    assert.equal(setPartitionCalled, false, 'no partition-list on fresh item');
  });

  it('skips auto-partition on write under NO_KEYCHAIN_PROMPT (background)', () => {
    process.env.CLAUDE_SWITCH_NO_KEYCHAIN_PROMPT = '1';
    try {
      let setPartitionCalled = false;
      const { fn } = makeExec((call) => {
        if (call.args[0] === 'set-generic-password-partition-list') {
          setPartitionCalled = true;
          return Buffer.from('');
        }
        return Buffer.from('');
      });
      new KeychainAdapter(fn).writeOAuth(SAMPLE);
      assert.equal(setPartitionCalled, false, 'background writes never auto-widen');
    } finally {
      delete process.env.CLAUDE_SWITCH_NO_KEYCHAIN_PROMPT;
    }
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
  it('is FileCredentialStore on every platform (Phase 24)', async () => {
    // Phase 24 made the file vault the default everywhere. The legacy
    // KeychainAdapter is reachable only via CLAUDE_SWITCH_USE_KEYCHAIN=1
    // for one back-compat release before removal.
    const { FileCredentialStore } = await import('../src/file-credential-store.js');
    assert.ok(defaultCredentialStore instanceof FileCredentialStore);
  });
});
