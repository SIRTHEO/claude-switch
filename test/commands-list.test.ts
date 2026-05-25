// test/commands-list.test.ts
// Coverage for `src/commands/list.ts` — handleList.
// Exercises: empty state, active marker, aliases label, stderr warning on
// unreadable claude.json.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleList } from '../src/commands/list.js';
import { save as saveAccount } from '../src/accounts/accounts.js';
import { setAlias } from '../src/switching/aliases.js';
import type { CommandContext } from '../src/commands/context.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
  ctx: CommandContext;
  stdout: string[];
  stderr: string[];
}

function setup(activeEmail?: string): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-list-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  if (activeEmail) {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: activeEmail },
    }));
    saveAccount(activeEmail, claudeJson, accDir);
  } else {
    fs.writeFileSync(claudeJson, '{}');
  }
  const ctx: CommandContext = {
    claudeJsonPath: claudeJson,
    accountsDirPath: accDir,
    updateInfo: null,
    selfUrl: fileURLToPath(import.meta.url),
  };
  return { tmpDir, claudeJson, accDir, ctx, stdout: [], stderr: [] };
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

function captureOutput(h: Harness): () => void {
  const origLog = console.log;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]) => {
    h.stdout.push(args.map(String).join(' '));
  };
  process.stdout.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    h.stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    h.stderr.push(String(chunk));
    return true;
  };
  return () => {
    console.log = origLog;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleList — empty state', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup();
    restore = captureOutput(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('prints no-accounts hint when accounts dir is empty', () => {
    handleList(h.ctx);
    const out = h.stdout.join('\n');
    assert.match(out, /No saved accounts/);
    assert.match(out, /claude switch add/);
  });
});

describe('handleList — with accounts', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('active@example.com');
    restore = captureOutput(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('marks the active account with an asterisk', () => {
    handleList(h.ctx);
    const out = h.stdout.join('\n');
    assert.match(out, /\*.*active@example\.com/);
    assert.match(out, /\(active\)/);
  });

  it('shows a second account without the active marker', () => {
    saveAccount('other@example.com', h.claudeJson, h.accDir);
    h.stdout.length = 0;
    handleList(h.ctx);
    const out = h.stdout.join('\n');
    assert.match(out, /other@example\.com/);
    // should NOT have asterisk on the non-active row
    const otherLine = h.stdout.find(l => l.includes('other@example.com')) ?? '';
    assert.ok(!otherLine.includes('*'), 'inactive account must not have asterisk');
  });

  it('includes alias label when account has aliases', () => {
    setAlias('work', 'active@example.com', h.accDir);
    h.stdout.length = 0;
    handleList(h.ctx);
    const out = h.stdout.join('\n');
    assert.match(out, /\[work\]/);
  });

  it('writes a warning to stderr when claude.json is unreadable but still lists accounts', () => {
    // chmod 0o000 doesn't make files unreadable on Windows — the NTFS ACL model
    // is independent of POSIX permission bits. Skip on win32; the production
    // path is identical and exercised on macOS + linux CI matrix entries.
    if (process.platform === 'win32') return;

    // Make the file unreadable by replacing it with something unreadable
    fs.chmodSync(h.claudeJson, 0o000);
    h.stdout.length = 0;
    try {
      handleList(h.ctx);
    } finally {
      fs.chmodSync(h.claudeJson, 0o644);
    }
    const errOut = h.stderr.join('\n');
    // Should still list accounts and print a warning
    assert.match(errOut, /could not determine active account/);
    assert.ok(h.stdout.some(l => l.includes('active@example.com')),
      'should still list accounts even when active marker unreadable');
  });
});

describe('handleList — --json', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('active@example.com');
    restore = captureOutput(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('emits a single JSON line on stdout (no banner, no padding)', () => {
    saveAccount('other@example.com', h.claudeJson, h.accDir);
    setAlias('work', 'active@example.com', h.accDir);
    h.stdout.length = 0;
    handleList(h.ctx, { json: true });

    const out = h.stdout.join('');
    // Single-line JSON array. Must be parseable as-is.
    const parsed = JSON.parse(out.trim()) as Array<{
      email: string;
      alias: string | null;
      aliases: string[];
      active: boolean;
    }>;
    assert.equal(parsed.length, 2);
    const active = parsed.find((p) => p.email === 'active@example.com');
    assert.equal(active?.active, true);
    assert.equal(active?.alias, 'work');
    assert.deepEqual(active?.aliases, ['work']);
    const other = parsed.find((p) => p.email === 'other@example.com');
    assert.equal(other?.active, false);
    assert.equal(other?.alias, null);
  });

  it('emits "[]" when no accounts are saved', () => {
    // Replace fixture: empty accounts dir, no active marker.
    fs.rmSync(h.accDir, { recursive: true, force: true });
    fs.mkdirSync(h.accDir, { recursive: true });
    fs.writeFileSync(h.claudeJson, '{}');
    h.stdout.length = 0;
    handleList(h.ctx, { json: true });
    assert.deepEqual(JSON.parse(h.stdout.join('').trim()), []);
  });

  it('does NOT write the legacy "Note: could not determine…" banner to stderr', () => {
    if (process.platform === 'win32') return;
    fs.chmodSync(h.claudeJson, 0o000);
    try {
      handleList(h.ctx, { json: true });
    } finally {
      fs.chmodSync(h.claudeJson, 0o644);
    }
    // JSON mode must not write the "could not determine active account"
    // note that the human path emits — pipelines key on stderr quietness
    // specifically for that ambiguity warning, not for unrelated module
    // warnings (Keychain-disable banner etc.) that fire regardless of mode.
    const joined = h.stderr.join('');
    assert.ok(
      !/could not determine active account/i.test(joined),
      'list-specific stderr note must be suppressed in --json mode',
    );
  });
});
