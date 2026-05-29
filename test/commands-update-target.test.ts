// test/commands-update-target.test.ts
//
// Coverage for `claude switch update <target>` (handleUpdateTarget +
// the install command builder). Mocks the HttpPort (so we don't hit
// npm/GitHub), the ProcessPort (so we don't really `npm i -g`), and
// HOME (so the cache file lands in a tmp dir).
//
// JSON-contract assertions per CLAUDE.md "JSON contract":
//   1. `--json` emits one line of valid JSON on stdout
//   2. stderr stays clean on the happy path
//   3. exit codes 0 / 1 / 2 match the brief

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';

import type { ProcessPort } from '../src/platform/process.js';
import { buildInstallCommand } from '../src/setup/versions/install-commands.js';
import { runInstall } from '../src/setup/versions/install.js';

interface Harness {
  stdout: string[];
  stderr: string[];
  homeBackup: string;
  tmpHome: string;
  restore: () => void;
}

function captureOutput(): Harness {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upd-'));
  const homeBackup = process.env.HOME ?? '';
  process.env.HOME = tmpHome;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr.push(String(chunk));
    return true;
  };
  return {
    stdout,
    stderr,
    homeBackup,
    tmpHome,
    restore: () => {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      process.env.HOME = homeBackup;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// buildInstallCommand — pure
// ---------------------------------------------------------------------------

describe('buildInstallCommand', () => {
  it('picks brew upgrade for claude on brew', () => {
    const c = buildInstallCommand('claude', 'brew');
    assert.equal(c?.cmd, 'brew');
    assert.deepEqual(c?.args, ['upgrade', '--cask', 'claude-code']);
  });

  it('picks npm global for claude on npm', () => {
    const c = buildInstallCommand('claude', 'npm');
    assert.equal(c?.cmd, 'npm');
    assert.match(c?.label ?? '', /@anthropic-ai\/claude-code@latest/);
  });

  it('picks npm global for switch (npm-only in v1)', () => {
    const c = buildInstallCommand('switch', 'npm');
    assert.equal(c?.cmd, 'npm');
    assert.match(c?.label ?? '', /@sirtheo\/claude-switch@latest/);
  });

  it('returns null for gui (manual-by-design in v1)', () => {
    assert.equal(buildInstallCommand('gui', 'manual'), null);
  });

  it('delegates to `claude update` for manual standalone installs', () => {
    const c = buildInstallCommand('claude', 'manual');
    assert.equal(c?.cmd, 'claude');
    assert.deepEqual(c?.args, ['update']);
  });

  it('returns null for truly unknown claude sources', () => {
    assert.equal(buildInstallCommand('claude', 'unknown'), null);
  });
});

// ---------------------------------------------------------------------------
// runInstall — spawn + stream
// ---------------------------------------------------------------------------

function fakeProc(opts: { exitCode: number | null; stderr?: string }): ProcessPort {
  return {
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
      };
      child.stderr = new EventEmitter();
      // Defer the close event so the caller's listeners attach first.
      setImmediate(() => {
        if (opts.stderr) child.stderr.emit('data', opts.stderr);
        child.emit('close', opts.exitCode);
      });
      return child as unknown as ChildProcess;
    },
    spawnSync: (): SpawnSyncReturns<Buffer> => {
      throw new Error('spawnSync not expected in runInstall test');
    },
  };
}

describe('runInstall', () => {
  it('resolves ok:true on exit 0', async () => {
    const r = await runInstall(
      { cmd: 'npm', args: ['--version'], label: 'npm --version' },
      { process: fakeProc({ exitCode: 0 }), silent: true },
    );
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
    assert.equal(r.errorMessage, '');
  });

  it('captures stderr and surfaces it on failure', async () => {
    const r = await runInstall(
      { cmd: 'npm', args: ['oops'], label: 'npm oops' },
      { process: fakeProc({ exitCode: 1, stderr: 'EACCES permission denied\n' }), silent: true },
    );
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
    assert.match(r.errorMessage, /EACCES/);
  });
});

// ---------------------------------------------------------------------------
// handleUpdateTarget — JSON contract
// ---------------------------------------------------------------------------

describe('handleUpdateTarget — gui (manual exit 0)', () => {
  let h: Harness;
  beforeEach(() => { h = captureOutput(); });
  afterEach(() => h.restore());

  it('emits ok:true with manualUrl when --json and target=gui', async () => {
    // Inject fake HTTP + ProcessPort so getVersionsReport returns
    // deterministic data without hitting npm / GitHub / shelling out.
    const fakeHttp = async (url: string): Promise<Response> => {
      const reply = (body: object): Response => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes('api.github.com')) return reply({ tag_name: 'v0.5.0' });
      if (url.includes('claude-code')) return reply({ latest: '2.1.156' });
      if (url.includes('claude-switch')) return reply({ latest: '4.1.1' });
      return new Response('', { status: 404 });
    };
    const fakeProc: ProcessPort = {
      spawn: () => { throw new Error('spawn not expected'); },
      spawnSync: () => ({ pid: 0, output: [], stdout: Buffer.from(''), stderr: Buffer.from(''), status: 1, signal: null } as SpawnSyncReturns<Buffer>),
    };

    const { handleUpdateTarget } = await import('../src/commands/update-target.js');
    const code = await handleUpdateTarget(
      { target: 'gui', check: false, json: true },
      { http: fakeHttp, process: fakeProc },
    );
    assert.equal(code, 0);
    assert.equal(h.stderr.join(''), '');
    const parsed = JSON.parse(h.stdout.join('').trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.target, 'gui');
    assert.equal(typeof parsed.manualUrl, 'string');
  });
});
