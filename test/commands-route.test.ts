// test/commands-route.test.ts
// Coverage for `src/commands/route.ts` — handleRouteAdd, handleRouteList,
// handleRouteRemove, handleRouteTest.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  handleRouteAdd,
  handleRouteList,
  handleRouteRemove,
  handleRouteTest,
} from '../src/commands/route.js';
import { save as saveAccount } from '../src/accounts/accounts.js';
import { setAlias } from '../src/switching/aliases.js';
import { ExitError } from '../src/platform/errors.js';
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
}

function setup(activeEmail?: string): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-route-'));
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
  return { tmpDir, claudeJson, accDir, ctx, stdout: [] };
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

function captureStdout(h: Harness): () => void {
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    h.stdout.push(args.map(String).join(' '));
  };
  return () => { console.log = origLog; };
}

// ---------------------------------------------------------------------------
// handleRouteAdd
// ---------------------------------------------------------------------------

describe('handleRouteAdd', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@example.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('throws ExitError when pattern is missing', () => {
    assert.throws(() => handleRouteAdd(h.ctx, undefined, 'a@example.com'), ExitError);
  });

  it('throws ExitError when target is missing', () => {
    assert.throws(() => handleRouteAdd(h.ctx, '*.work.io', undefined), ExitError);
  });

  it('throws ExitError when pattern starts with --', () => {
    assert.throws(() => handleRouteAdd(h.ctx, '--invalid', 'a@example.com'), ExitError);
  });

  it('throws ExitError when email is not a saved account', () => {
    assert.throws(
      () => handleRouteAdd(h.ctx, '*.test.io', 'notexist@example.com'),
      ExitError,
    );
  });

  it('throws ExitError when alias does not resolve to a known account', () => {
    assert.throws(
      () => handleRouteAdd(h.ctx, '*.test.io', 'ghost-alias'),
      ExitError,
    );
  });

  it('adds a rule by email and confirms', () => {
    handleRouteAdd(h.ctx, '*.work.io', 'a@example.com');
    const out = h.stdout.join('\n');
    assert.match(out, /Added rule/);
    assert.match(out, /\*\.work\.io/);
    assert.match(out, /a@example\.com/);
  });

  it('adds a rule by alias and confirms', () => {
    setAlias('work', 'a@example.com', h.accDir);
    h.stdout.length = 0;
    handleRouteAdd(h.ctx, '*.corp.io', 'work');
    const out = h.stdout.join('\n');
    assert.match(out, /Added rule/);
    assert.match(out, /alias work/);
  });

  it('throws ExitError when a duplicate pattern is added', () => {
    handleRouteAdd(h.ctx, '*.work.io', 'a@example.com');
    h.stdout.length = 0;
    assert.throws(
      () => handleRouteAdd(h.ctx, '*.work.io', 'a@example.com'),
      ExitError,
    );
  });

  it('throws ExitError when email has unsafe characters', () => {
    // inject an email-looking string with a path traversal character
    assert.throws(
      () => handleRouteAdd(h.ctx, '*.test.io', '../evil@example.com'),
      ExitError,
    );
  });
});

// ---------------------------------------------------------------------------
// handleRouteList
// ---------------------------------------------------------------------------

describe('handleRouteList', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@example.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('prints empty-state message when no rules exist', () => {
    handleRouteList(h.ctx);
    assert.match(h.stdout.join('\n'), /No global routing rules/);
  });

  it('lists rules after one has been added', () => {
    handleRouteAdd(h.ctx, '*.corp.io', 'a@example.com');
    h.stdout.length = 0;
    handleRouteList(h.ctx);
    const out = h.stdout.join('\n');
    assert.match(out, /\*\.corp\.io/);
    assert.match(out, /a@example\.com/);
  });

  it('mentions per-repo overrides in the footer', () => {
    handleRouteAdd(h.ctx, '*.corp.io', 'a@example.com');
    h.stdout.length = 0;
    handleRouteList(h.ctx);
    assert.match(h.stdout.join('\n'), /\.claude-switch/);
  });
});

// ---------------------------------------------------------------------------
// handleRouteRemove
// ---------------------------------------------------------------------------

describe('handleRouteRemove', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@example.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('throws ExitError when pattern is missing', () => {
    assert.throws(() => handleRouteRemove(h.ctx, undefined), ExitError);
  });

  it('throws ExitError when the pattern does not exist', () => {
    assert.throws(() => handleRouteRemove(h.ctx, '*.nonexistent.io'), ExitError);
  });

  it('removes an existing rule and confirms', () => {
    handleRouteAdd(h.ctx, '*.corp.io', 'a@example.com');
    h.stdout.length = 0;
    handleRouteRemove(h.ctx, '*.corp.io');
    const out = h.stdout.join('\n');
    assert.match(out, /Removed rule/);
    assert.match(out, /\*\.corp\.io/);
  });

  it('does not affect other rules when removing one', () => {
    saveAccount('b@example.com', h.claudeJson, h.accDir);
    handleRouteAdd(h.ctx, '*.corp.io', 'a@example.com');
    handleRouteAdd(h.ctx, '*.org.io', 'a@example.com');
    h.stdout.length = 0;
    handleRouteRemove(h.ctx, '*.corp.io');
    // List remaining rules
    h.stdout.length = 0;
    handleRouteList(h.ctx);
    const out = h.stdout.join('\n');
    assert.match(out, /\*\.org\.io/);
    assert.ok(!out.includes('*.corp.io'), '*.corp.io should have been removed');
  });
});

// ---------------------------------------------------------------------------
// handleRouteTest
// ---------------------------------------------------------------------------

describe('handleRouteTest', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@example.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('reports no routing opinion when no rules are configured', () => {
    handleRouteTest(h.ctx, '/tmp');
    const out = h.stdout.join('\n');
    assert.match(out, /no routing opinion/);
  });

  it('reports a decision when a matching rule exists', () => {
    handleRouteAdd(h.ctx, '/tmp*', 'a@example.com');
    h.stdout.length = 0;
    handleRouteTest(h.ctx, '/tmp');
    const out = h.stdout.join('\n');
    assert.match(out, /decision/);
  });

  it('uses cwd when no path argument given', () => {
    handleRouteTest(h.ctx, undefined);
    const out = h.stdout.join('\n');
    assert.match(out, /cwd:/);
  });

  it('shows active and saved accounts in output', () => {
    handleRouteTest(h.ctx, '/tmp');
    const out = h.stdout.join('\n');
    assert.match(out, /active:/);
    assert.match(out, /saved:/);
  });
});
