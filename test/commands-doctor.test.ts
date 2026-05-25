import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleDoctor } from '../src/commands/doctor.js';

// handleDoctor reads claude.json + account snapshots + usage caches and writes
// to stdout. Drive it against a temp accountsDir; capture stdout. The global
// CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 (set by npm test) makes keychainItemPresent
// return false, so no `security` spawn — pure fs flow.

let tmp: string;
let claudeJson: string;
let accDir: string;
let out: string;
let originalWrite: typeof process.stdout.write;

function capture(): void {
  out = '';
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString();
    return true;
  }) as typeof process.stdout.write;
}
function restore(): void {
  process.stdout.write = originalWrite;
}

const NOW = 2_000_000_000_000;
const writeSnap = (email: string, obj: Record<string, unknown>): void =>
  fs.writeFileSync(path.join(accDir, `${email}.json`), JSON.stringify(obj));

describe('handleDoctor', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-doc-'));
    claudeJson = path.join(tmp, '.claude.json');
    accDir = path.join(tmp, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
  });
  afterEach(() => {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports a healthy store as ok (human)', () => {
    writeSnap('a@x.com', { emailAddress: 'a@x.com', accountUuid: 'uuid-a', _keychain: { claudeAiOauth: { accessToken: 'tok-a', refreshToken: 'r', expiresAt: 1 } }, _capturedFrom: { accountUuid: 'uuid-a' } });
    capture();
    handleDoctor({ claudeJsonPath: claudeJson, accountsDirPath: accDir }, { json: false, fix: false }, { now: () => NOW });
    assert.match(out, /ok/);
    assert.match(out, /No issues found/);
  });

  it('emits a JSON report flagging a token collision', () => {
    writeSnap('a@x.com', { emailAddress: 'a@x.com', accountUuid: 'uuid-a', _keychain: { claudeAiOauth: { accessToken: 'SHARED', refreshToken: 'r', expiresAt: 1 } } });
    writeSnap('b@x.com', { emailAddress: 'b@x.com', accountUuid: 'uuid-b', _keychain: { claudeAiOauth: { accessToken: 'SHARED', refreshToken: 'r', expiresAt: 1 } } });
    capture();
    handleDoctor({ claudeJsonPath: claudeJson, accountsDirPath: accDir }, { json: true, fix: false }, { now: () => NOW });
    const report = JSON.parse(out.trim());
    assert.equal(report.status, 'error');
    assert.equal(report.activeAccount, 'a@x.com');
    assert.ok(report.findings.some((f: { code: string }) => f.code === 'snapshot-token-collision'));
  });

  it('--fix clears poisoned tokens from snapshots, then re-reports clean', () => {
    writeSnap('a@x.com', { emailAddress: 'a@x.com', accountUuid: 'uuid-a', _keychain: { claudeAiOauth: { accessToken: 'SHARED', refreshToken: 'r', expiresAt: 1 } }, _capturedFrom: { accountUuid: 'uuid-a' } });
    writeSnap('b@x.com', { emailAddress: 'b@x.com', accountUuid: 'uuid-b', _keychain: { claudeAiOauth: { accessToken: 'SHARED', refreshToken: 'r', expiresAt: 1 } }, _capturedFrom: { accountUuid: 'uuid-b' } });
    capture();
    handleDoctor({ claudeJsonPath: claudeJson, accountsDirPath: accDir }, { json: true, fix: true }, { now: () => NOW });
    const after = JSON.parse(out.trim());
    // post-fix report is clean of the collision
    assert.ok(!after.findings.some((f: { code: string }) => f.code === 'snapshot-token-collision'));
    assert.ok(Array.isArray(after.fixed) && after.fixed.length >= 2, 'reports the cleared snapshots');
    // _keychain stripped from both snapshots on disk
    for (const e of ['a@x.com', 'b@x.com']) {
      const raw = JSON.parse(fs.readFileSync(path.join(accDir, `${e}.json`), 'utf-8'));
      assert.equal('_keychain' in raw, false, `${e} _keychain cleared`);
      assert.equal('_capturedFrom' in raw, false, `${e} _capturedFrom cleared`);
    }
  });

  it('--fix human output lists the actions taken', () => {
    writeSnap('a@x.com', { emailAddress: 'a@x.com', accountUuid: 'uuid-a', _keychain: { claudeAiOauth: { accessToken: 'SHARED', refreshToken: 'r', expiresAt: 1 } } });
    writeSnap('b@x.com', { emailAddress: 'b@x.com', accountUuid: 'uuid-b', _keychain: { claudeAiOauth: { accessToken: 'SHARED', refreshToken: 'r', expiresAt: 1 } } });
    capture();
    handleDoctor({ claudeJsonPath: claudeJson, accountsDirPath: accDir }, { json: false, fix: true }, { now: () => NOW });
    assert.match(out, /Fixed \d+ issue/);
    assert.match(out, /cleared stale tokens/);
  });

  it('--fix on a healthy store says nothing to fix', () => {
    writeSnap('a@x.com', { emailAddress: 'a@x.com', accountUuid: 'uuid-a', _keychain: { claudeAiOauth: { accessToken: 'tok-a', refreshToken: 'r', expiresAt: 1 } }, _capturedFrom: { accountUuid: 'uuid-a' } });
    capture();
    handleDoctor({ claudeJsonPath: claudeJson, accountsDirPath: accDir }, { json: false, fix: true }, { now: () => NOW });
    assert.match(out, /Nothing to fix/);
  });

  it('detects a rate-limited usage cache and --fix deletes it', () => {
    writeSnap('a@x.com', { emailAddress: 'a@x.com', accountUuid: 'uuid-a' });
    const cacheFile = path.join(accDir, '.usage-cache.deadbeef.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: NOW, account: 'a@x.com', rateLimitedUntil: NOW + 60_000 }));
    capture();
    handleDoctor({ claudeJsonPath: claudeJson, accountsDirPath: accDir }, { json: true, fix: true }, { now: () => NOW });
    assert.equal(fs.existsSync(cacheFile), false, 'rate-limited cache deleted by --fix');
  });
});
