// test/commands-versions.test.ts
//
// Coverage for `src/commands/versions.ts` and the multi-target version
// detection in `src/setup/versions/`. The handler is read-only — these
// tests inject a fake HTTP port + ProcessPort + clock so they never touch
// the real npm / GitHub / brew on a developer's machine.
//
// JSON-contract assertions per CLAUDE.md "JSON contract for new commands":
//   1. `--json` emits a single line of valid JSON on stdout
//   2. stderr stays clean
//   3. empty/unreachable case still returns a well-formed report (null latest)
//   4. shape matches VersionsReport

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import type { SpawnSyncReturns } from 'node:child_process';
import type { ProcessPort } from '../src/platform/process.js';
import type { HttpPort, HttpRequestInit } from '../src/platform/http.js';
import { handleVersions } from '../src/commands/versions.js';
import { cachePath } from '../src/setup/versions/cache.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

interface Harness {
  stdout: string[];
  stderr: string[];
  restore: () => void;
  /** Snapshot of HOME so we don't leak a real cache file. */
  homeBackup: string;
  tmpHome: string;
}

function captureOutput(): Harness {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ver-'));
  const homeBackup = process.env.HOME ?? '';
  process.env.HOME = tmpHome;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
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

/** ProcessPort that pretends `claude` is brew-installed at 2.1.150 and brew
 *  --prefix returns `/opt/homebrew`. spawn is never called by these tests
 *  (only spawnSync), so we throw on it to catch accidental usage. */
function fakeProcess(): ProcessPort {
  const ok = (stdout: string): SpawnSyncReturns<Buffer> =>
    ({ pid: 0, output: [], stdout: Buffer.from(stdout), stderr: Buffer.from(''), status: 0, signal: null } as SpawnSyncReturns<Buffer>);
  return {
    spawn: () => {
      throw new Error('unexpected spawn() in versions test');
    },
    spawnSync: (cmd, args) => {
      if (cmd === 'which' && args[0] === 'claude') return ok('/opt/homebrew/bin/claude\n');
      if (cmd === 'brew' && args[0] === '--prefix') return ok('/opt/homebrew\n');
      if (cmd === 'claude' && args[0] === '--version') return ok('2.1.150 (Claude Code)\n');
      // Inferred install method: brew cask installed (status 0) →
      // detect-claude.ts:isBrewCaskInstalled returns true → source = 'brew'.
      if (cmd === 'brew' && args[0] === 'list' && args[2] === 'claude-code') {
        return ok('claude-code');
      }
      // anything else → exit 1, empty output
      return ({ pid: 0, output: [], stdout: Buffer.from(''), stderr: Buffer.from(''), status: 1, signal: null } as SpawnSyncReturns<Buffer>);
    },
  };
}

/** HttpPort that returns canned latest versions for the three endpoints
 *  the detectors hit (npm dist-tags × 2, GitHub releases × 1). */
function fakeHttp(map: { claude?: string | null; switchPkg?: string | null; gui?: string | null }): HttpPort {
  return async (url: string, _init?: HttpRequestInit): Promise<Response> => {
    const reply = (body: object): Response => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('%40anthropic-ai%2Fclaude-code')) {
      return map.claude === null ? new Response('', { status: 500 }) : reply({ latest: map.claude ?? '2.1.156' });
    }
    if (url.includes('%40sirtheo%2Fclaude-switch')) {
      return map.switchPkg === null ? new Response('', { status: 500 }) : reply({ latest: map.switchPkg ?? '4.1.1' });
    }
    if (url.includes('api.github.com')) {
      return map.gui === null ? new Response('', { status: 500 }) : reply({ tag_name: `v${map.gui ?? '0.5.0'}` });
    }
    return new Response('', { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleVersions — JSON contract', () => {
  let h: Harness;
  beforeEach(() => { h = captureOutput(); });
  afterEach(() => { h.restore(); });

  it('emits a single line of valid JSON matching the VersionsReport shape', async () => {
    await handleVersions(
      { json: true, force: true },
      { process: fakeProcess(), http: fakeHttp({}), now: () => 1_700_000_000_000 },
    );
    // stderr clean
    assert.equal(h.stderr.join(''), '');
    // single line
    const out = h.stdout.join('');
    assert.equal(out.endsWith('\n'), true, 'output should be newline-terminated');
    const lines = out.trim().split('\n');
    assert.equal(lines.length, 1, 'one line of JSON');
    const parsed = JSON.parse(lines[0] ?? '');
    // shape
    for (const t of ['claude', 'switch', 'gui'] as const) {
      const row = parsed[t];
      assert.ok(row && typeof row === 'object', `${t} present`);
      assert.ok('current' in row, `${t}.current present`);
      assert.ok('latest' in row, `${t}.latest present`);
      assert.ok('source' in row, `${t}.source present`);
      assert.ok(typeof row.upgradable === 'boolean', `${t}.upgradable boolean`);
      assert.ok(typeof row.lastCheckedAt === 'string', `${t}.lastCheckedAt iso`);
    }
    assert.equal(parsed.claude.current, '2.1.150');
    assert.equal(parsed.claude.latest, '2.1.156');
    assert.equal(parsed.claude.source, 'brew');
    assert.equal(parsed.claude.upgradable, true);
    assert.equal(parsed.gui.current, null);
    assert.equal(parsed.gui.source, 'manual');
    assert.equal(typeof parsed.gui.manualUrl, 'string');
  });

  it('does not throw and reports null latest when a registry is unreachable', async () => {
    await handleVersions(
      { json: true, force: true },
      { process: fakeProcess(), http: fakeHttp({ claude: null, switchPkg: null, gui: null }), now: () => 1 },
    );
    assert.equal(h.stderr.join(''), '');
    const parsed = JSON.parse(h.stdout.join('').trim());
    assert.equal(parsed.claude.latest, null);
    assert.equal(parsed.switch.latest, null);
    assert.equal(parsed.gui.latest, null);
    assert.equal(parsed.claude.upgradable, false);
  });

  it('writes the on-disk cache so the next call can reuse it', async () => {
    await handleVersions(
      { json: true, force: true },
      { process: fakeProcess(), http: fakeHttp({}), now: () => 1 },
    );
    assert.ok(fs.existsSync(cachePath()), 'cache file written under $HOME');
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed.fetchedAt, 'number');
    assert.equal(parsed.targets.claude.latest, '2.1.156');
    assert.equal(parsed.targets.switch.latest, '4.1.1');
  });
});

describe('handleVersions — human mode', () => {
  let h: Harness;
  beforeEach(() => { h = captureOutput(); });
  afterEach(() => { h.restore(); });

  it('prints a table with one row per target and a "upgrade available" hint', async () => {
    await handleVersions(
      { json: false, force: true },
      { process: fakeProcess(), http: fakeHttp({}), now: () => 1 },
    );
    const out = h.stdout.join('');
    assert.match(out, /claude\s+2\.1\.150\s+\(latest 2\.1\.156\) \[brew\] → upgrade available/);
    assert.match(out, /claude-switch\s+4\.1\.1/);
    assert.match(out, /claude-switch-gui/);
    assert.match(out, /Last checked:/);
  });
});
