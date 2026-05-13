// Phase 13.6 — proxy runtime mode marker (.proxy-mode.json) lifecycle.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProxyMode, readProxyMode, clearProxyMode, PROXY_MODE_STALE_MS } from '../src/proxy-mode.js';

describe('proxy-mode marker (Phase 13.6)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-proxy-mode-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when the marker file does not exist', () => {
    assert.strictEqual(readProxyMode(dir), null);
  });

  it('writes and reads back a fresh marker (round-trip)', () => {
    writeProxyMode(dir, 'oauth-first', 'proxy started');
    const got = readProxyMode(dir);
    assert.ok(got, 'marker should be readable');
    assert.strictEqual(got?.mode, 'oauth-first');
    assert.strictEqual(got?.lastReason, 'proxy started');
    assert.ok(typeof got?.updatedAt === 'number');
    assert.ok(typeof got?.pid === 'number');
  });

  it('reflects subsequent transitions (oauth-first → oauth-burst → oauth-first)', () => {
    writeProxyMode(dir, 'oauth-first', 'startup');
    writeProxyMode(dir, 'oauth-burst', '3 consecutive OAuth failures');
    assert.strictEqual(readProxyMode(dir)?.mode, 'oauth-burst');
    writeProxyMode(dir, 'oauth-first', 'probe succeeded');
    assert.strictEqual(readProxyMode(dir)?.mode, 'oauth-first');
  });

  it('returns null when the marker is older than PROXY_MODE_STALE_MS', () => {
    // Hand-craft a stale marker — simulate a crashed proxy.
    const stalePath = path.join(dir, '.proxy-mode.json');
    fs.writeFileSync(stalePath, JSON.stringify({
      mode: 'oauth-burst',
      updatedAt: Date.now() - (PROXY_MODE_STALE_MS + 1000),
      lastReason: 'from a process that died',
    }));
    // Reader must self-heal — pretend the marker isn't there so the
    // statusline falls back to the persistent flag.
    assert.strictEqual(readProxyMode(dir), null);
  });

  it('returns null on malformed JSON', () => {
    fs.writeFileSync(path.join(dir, '.proxy-mode.json'), 'not json at all');
    assert.strictEqual(readProxyMode(dir), null);
  });

  it('returns null on unknown mode values (defensive — never trust foreign writers)', () => {
    fs.writeFileSync(path.join(dir, '.proxy-mode.json'), JSON.stringify({
      mode: 'definitely-not-a-real-mode',
      updatedAt: Date.now(),
    }));
    assert.strictEqual(readProxyMode(dir), null);
  });

  it('clearProxyMode removes the file', () => {
    writeProxyMode(dir, 'oauth-burst', 'in burst');
    assert.ok(readProxyMode(dir), 'precondition: marker exists');
    clearProxyMode(dir);
    assert.strictEqual(readProxyMode(dir), null, 'marker should be gone');
  });

  it('clearProxyMode is a no-op when the file does not exist (idempotent)', () => {
    // Calling close() twice or close() before any transition should not
    // throw — proxy lifecycle does this in practice.
    clearProxyMode(dir);
    clearProxyMode(dir);
    assert.strictEqual(readProxyMode(dir), null);
  });

  it('writeProxyMode creates the accounts dir if it does not exist', () => {
    const newDir = path.join(dir, 'nested', 'accounts');
    // newDir does not exist yet — writeProxyMode must mkdirp on its own.
    writeProxyMode(newDir, 'oauth-first');
    assert.ok(readProxyMode(newDir), 'marker should be created in mkdirp-ed dir');
  });
});
