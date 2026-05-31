// test/commands-migrate.test.ts
// JSON-contract + output coverage for `claude switch migrate <pid> <account>
// [--json]` (src/commands/migrate.ts). The GUI consumes this command, so the
// contract is: --json emits a single JSON line on stdout, stderr stays clean,
// failures are `{ ok: false, error }` with a non-zero exit, success is
// `{ ok: true, target, configDir, noop }`. The actual migration is injected
// (deps.migrate) so these tests exercise only the handler's resolve + format
// paths, never the real credential write.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleMigrate } from '../src/commands/migrate.js';
import type { MigrateResult } from '../src/sessions/migrate-session.js';
import type { LiveSession } from '../src/sessions/session-registry.js';

async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { out, err };
}

describe('handleMigrate — JSON contract + output paths', () => {
  let home: string;
  let accountsDir: string;

  /** Seed the live registry with one isolated session at the live pid so the
   *  handler's pid lookup (default, un-injectable liveness) resolves it. */
  function seedIsolated(over: Partial<LiveSession> = {}): number {
    const entry: LiveSession = {
      pid: process.pid,
      account: 'sirtheo.personal@example.com',
      configDir: path.join(home, '.claude', 'profiles', 'personal'),
      isolated: true,
      cwd: '/tmp/work',
      startedAt: 1,
      ...over,
    };
    fs.writeFileSync(path.join(accountsDir, '.sessions.json'), JSON.stringify([entry]));
    return entry.pid;
  }

  const okMigrate = (noop: boolean) =>
    async (target: string, configDir: string): Promise<MigrateResult> => ({ target, configDir, noop });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cmd-migrate-'));
    accountsDir = path.join(home, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0; // handler sets 1 on failure — reset so the runner exits clean
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('is INERT by default: a valid pid with no injected migrate refuses "not available"', async () => {
    // The command is wired but disabled until per-session work dirs land — its
    // default action refuses, never reaching a real migration. Inject NOTHING.
    const pid = seedIsolated();
    const { out, err } = await capture(() =>
      handleMigrate({ accountsDirPath: accountsDir }, String(pid), 'sirtheo.work@example.com', { json: true }),
    );
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /not available/i);
    assert.equal(err, '', 'stderr clean in json mode');
    assert.equal(process.exitCode, 1);
  });

  it('--json success emits one JSON line {ok:true,...} and clean stderr', async () => {
    const pid = seedIsolated();
    const { out, err } = await capture(() =>
      handleMigrate({ accountsDirPath: accountsDir }, String(pid), 'sirtheo.work@example.com', { json: true }, { migrate: okMigrate(false) }),
    );
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.target, 'sirtheo.work@example.com');
    assert.equal(parsed.noop, false);
    assert.equal(err, '', 'stderr clean in json mode');
    assert.equal(process.exitCode, 0);
  });

  it('--json passes a migration failure through as {ok:false,error}', async () => {
    const pid = seedIsolated();
    const failing = async (): Promise<MigrateResult> => { throw new Error('Target account X is already live in another session.'); };
    const { out, err } = await capture(() =>
      handleMigrate({ accountsDirPath: accountsDir }, String(pid), 'x@y.com', { json: true }, { migrate: failing }),
    );
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /already live/);
    assert.equal(err, '');
    assert.equal(process.exitCode, 1);
  });

  it('refuses a non-integer pid (json failure shape, exit 1)', async () => {
    const { out } = await capture(() =>
      handleMigrate({ accountsDirPath: accountsDir }, 'notapid', 'x@y.com', { json: true }),
    );
    assert.equal(JSON.parse(out.trim()).ok, false);
    assert.match(JSON.parse(out.trim()).error, /not a valid pid/);
    assert.equal(process.exitCode, 1);
  });

  it('refuses a pid with no live session', async () => {
    const { out } = await capture(() =>
      handleMigrate({ accountsDirPath: accountsDir }, '2147483646', 'x@y.com', { json: true }),
    );
    assert.match(JSON.parse(out.trim()).error, /No live session/);
    assert.equal(process.exitCode, 1);
  });

  it('refuses a global-bound session (cannot migrate the shared default)', async () => {
    const pid = seedIsolated({ isolated: false, configDir: null });
    const { out } = await capture(() =>
      handleMigrate({ accountsDirPath: accountsDir }, String(pid), 'x@y.com', { json: true }, { migrate: okMigrate(false) }),
    );
    assert.match(JSON.parse(out.trim()).error, /global-bound/);
    assert.equal(process.exitCode, 1);
  });

  it('missing args → usage error', async () => {
    const { out } = await capture(() =>
      handleMigrate({ accountsDirPath: accountsDir }, undefined, undefined, { json: true }),
    );
    assert.match(JSON.parse(out.trim()).error, /usage/);
    assert.equal(process.exitCode, 1);
  });

  it('human mode: a noop migration prints a friendly line, not JSON', async () => {
    const pid = seedIsolated();
    const { out, err } = await capture(() =>
      handleMigrate({ accountsDirPath: accountsDir }, String(pid), 'sirtheo.work@example.com', { json: false }, { migrate: okMigrate(true) }),
    );
    assert.match(out, /already runs/);
    assert.doesNotThrow(() => out); // not JSON
    assert.equal(err, '');
    assert.equal(process.exitCode, 0);
  });
});
