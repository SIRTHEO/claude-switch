// test/commands-handlers.test.ts
// Coverage push for the thin CLI command handlers in `src/commands/`.
// Pre-Phase 11 these were sitting at 7-22% line coverage — handlers
// are mostly "read context, call domain, format output" so they
// looked low-leverage to test. The reality is they are the boundary
// between the CLI surface and the domain, and a regression here
// (wrong output, wrong exit code, accidentally calling the wrong
// domain function) is exactly what users notice first.
//
// Style: spy on `console.log` rather than refactor the handlers to
// take an injected writer. The handlers are small, the spy is
// well-contained, and the alternative would have been a refactor
// with broader blast radius.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleHelp } from '../src/commands/help.js';
import {
  handleFallback,
  handleFallbackAuto,
  handleFallbackAutoEngage,
} from '../src/commands/fallback.js';
import { handleStatus } from '../src/commands/status.js';
import {
  handleAliasSet,
  handleAliasList,
  handleAliasRemove,
} from '../src/commands/alias.js';
import { setApiKey } from '../src/apikey.js';
import { setFallbackEnabled } from '../src/fallback.js';
import { save as saveAccount } from '../src/accounts.js';
import type { CommandContext } from '../src/commands/context.js';
import { ExitError } from '../src/errors.js';

// ────────────────────────────────────────────────────────────────────
// Test scaffolding
// ────────────────────────────────────────────────────────────────────

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
  ctx: CommandContext;
  stdout: string[];
}

function setup(activeEmail?: string): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cmd-'));
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

// ────────────────────────────────────────────────────────────────────
// handleHelp
// ────────────────────────────────────────────────────────────────────

describe('handleHelp', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup();
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('prints exactly one help block to stdout', () => {
    handleHelp();
    assert.equal(h.stdout.length, 1, 'expected exactly one console.log call');
  });

  it('lists every top-level subcommand the user is expected to know', () => {
    handleHelp();
    const help = h.stdout[0]!;
    for (const cmd of ['add', 'list', 'remove', 'status', 'alias', 'apikey',
                       'fallback', 'usage', 'statusline', 'profile', 'update',
                       'setup', 'help']) {
      assert.match(help, new RegExp(`claude switch ${cmd}`),
        `help text must mention 'claude switch ${cmd}'`);
    }
  });

  it('explicitly documents pass-through behaviour', () => {
    handleHelp();
    assert.match(h.stdout[0]!, /pass(ed)? through/i);
  });
});

// ────────────────────────────────────────────────────────────────────
// handleFallback (manual on/off + status)
// ────────────────────────────────────────────────────────────────────

describe('handleFallback', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@b.com');
    setApiKey('a@b.com', 'sk-ant-api03-test-key', h.accDir);
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('status → reports the current fallback state and key presence', () => {
    handleFallback(h.ctx, 'status');
    const out = h.stdout.join('\n');
    assert.match(out, /Fallback:\s+off/);
    assert.match(out, /a@b\.com:\s+has API key/);
  });

  it('on → flips the flag, reports the API-key approval prompt', () => {
    handleFallback(h.ctx, 'on');
    assert.equal(setFallbackEnabledIsOnDisk(h.accDir), true);
    const out = h.stdout.join('\n');
    assert.match(out, /Fallback:\s+on/);
    assert.match(out, /Use this API key/);
  });

  it('off → flips the flag back', () => {
    setFallbackEnabled(h.accDir, true);
    h.stdout.length = 0;
    handleFallback(h.ctx, 'off');
    assert.equal(setFallbackEnabledIsOnDisk(h.accDir), false);
    assert.match(h.stdout.join('\n'), /Fallback:\s+off/);
  });

  it('on with no API key → emits the "no key saved" note instead of approval', () => {
    // Replace the test account with one that has NO key.
    fs.unlinkSync(path.join(h.accDir, 'a@b.com.json'));
    fs.writeFileSync(h.claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'naked@x.com' },
    }));
    saveAccount('naked@x.com', h.claudeJson, h.accDir);
    h.stdout.length = 0;
    handleFallback(h.ctx, 'on');
    const out = h.stdout.join('\n');
    assert.match(out, /no saved API key/);
    assert.doesNotMatch(out, /Use this API key/);
  });

  it('status with on-and-no-key → surfaces the warning', () => {
    setFallbackEnabled(h.accDir, true);
    fs.unlinkSync(path.join(h.accDir, 'a@b.com.json'));
    fs.writeFileSync(h.claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'naked@x.com' },
    }));
    saveAccount('naked@x.com', h.claudeJson, h.accDir);
    h.stdout.length = 0;
    handleFallback(h.ctx, 'status');
    assert.match(h.stdout.join('\n'), /Warning: fallback is on but/);
  });
});

function setFallbackEnabledIsOnDisk(accDir: string): boolean {
  // Mirror src/fallback.ts isFallbackEnabled lookup, kept inline so
  // the test verifies the on-disk side effect rather than
  // re-importing the very function under test.
  try {
    const raw = fs.readFileSync(path.join(accDir, '.claude-switch-state.json'), 'utf-8');
    const state = JSON.parse(raw);
    return state?.fallback?.enabled === true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────
// handleFallbackAuto (auto-revert)
// ────────────────────────────────────────────────────────────────────

describe('handleFallbackAuto', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@b.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('status renders enabled flag + threshold', () => {
    handleFallbackAuto(h.ctx, 'status', undefined);
    const out = h.stdout.join('\n');
    assert.match(out, /Smart-switch:\s+(on|off)/);
    assert.match(out, /Threshold:/);
  });

  it('on with explicit threshold persists both', () => {
    handleFallbackAuto(h.ctx, 'on', 70);
    h.stdout.length = 0;
    handleFallbackAuto(h.ctx, 'status', undefined);
    const out = h.stdout.join('\n');
    assert.match(out, /Smart-switch:\s+on/);
    assert.match(out, /Threshold:\s+70%/);
  });

  it('off disables the smart-switch', () => {
    handleFallbackAuto(h.ctx, 'off', undefined);
    h.stdout.length = 0;
    handleFallbackAuto(h.ctx, 'status', undefined);
    assert.match(h.stdout.join('\n'), /Smart-switch:\s+off/);
  });

  it('status with smart-switch enabled but no active account explains the no-op', () => {
    handleFallbackAuto(h.ctx, 'on', undefined); // ensure enabled
    fs.writeFileSync(h.claudeJson, '{}');
    h.stdout.length = 0;
    handleFallbackAuto(h.ctx, 'status', undefined);
    assert.match(h.stdout.join('\n'), /No active account/);
  });
});

// ────────────────────────────────────────────────────────────────────
// handleFallbackAutoEngage
// ────────────────────────────────────────────────────────────────────

describe('handleFallbackAutoEngage', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@b.com');
    setApiKey('a@b.com', 'sk-ant-api03-test', h.accDir);
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('status reports current engageEnabled + engageThreshold', () => {
    handleFallbackAutoEngage(h.ctx, 'status', undefined);
    const out = h.stdout.join('\n');
    assert.match(out, /Auto-engage:/);
    assert.match(out, /Threshold:/);
  });

  it('on with explicit threshold persists', () => {
    handleFallbackAutoEngage(h.ctx, 'on', 90);
    h.stdout.length = 0;
    handleFallbackAutoEngage(h.ctx, 'status', undefined);
    assert.match(h.stdout.join('\n'), /Threshold:\s+90%/);
  });

  it('off disables auto-engage', () => {
    handleFallbackAutoEngage(h.ctx, 'off', undefined);
    h.stdout.length = 0;
    handleFallbackAutoEngage(h.ctx, 'status', undefined);
    assert.match(h.stdout.join('\n'), /Auto-engage:\s+off/);
  });

  it('rethrows invariant violations as ExitError so the CLI exits cleanly', () => {
    // engageThreshold must be strictly greater than the auto-revert
    // threshold. Trigger the invariant by setting engage below revert.
    handleFallbackAuto(h.ctx, 'on', 80); // revert threshold = 80
    h.stdout.length = 0;
    assert.throws(
      () => handleFallbackAutoEngage(h.ctx, 'on', 50),
      ExitError,
    );
  });

  it('status with no key surfaces the "would-be-blocked" hint', () => {
    fs.unlinkSync(path.join(h.accDir, 'a@b.com.json'));
    fs.writeFileSync(h.claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'naked@x.com' },
    }));
    saveAccount('naked@x.com', h.claudeJson, h.accDir);
    handleFallbackAutoEngage(h.ctx, 'on', undefined); // first enable
    h.stdout.length = 0;
    handleFallbackAutoEngage(h.ctx, 'status', undefined);
    assert.match(h.stdout.join('\n'), /no saved API key/);
  });
});

// ────────────────────────────────────────────────────────────────────
// handleStatus
// ────────────────────────────────────────────────────────────────────

describe('handleStatus', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@b.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('reports active account + token state + fallback state', () => {
    handleStatus(h.ctx);
    const out = h.stdout.join('\n');
    assert.match(out, /Active account:\s+a@b\.com/);
    assert.match(out, /Token:/);
    assert.match(out, /Fallback:\s+off/);
  });

  it('shows API key as masked when set, not as raw', () => {
    setApiKey('a@b.com', 'sk-ant-api03-secret-1234', h.accDir);
    h.stdout.length = 0;
    handleStatus(h.ctx);
    const out = h.stdout.join('\n');
    assert.match(out, /API key:.*…/);
    assert.doesNotMatch(out, /secret-1234/);
  });

  it('reports "not set" when no key saved', () => {
    handleStatus(h.ctx);
    assert.match(h.stdout.join('\n'), /API key:\s+not set/);
  });

  it('emits the "no account connected" message when claude.json has no oauthAccount', () => {
    fs.writeFileSync(h.claudeJson, '{}');
    h.stdout.length = 0;
    handleStatus(h.ctx);
    assert.match(h.stdout.join('\n'), /No account connected/);
  });

  it('warns when fallback is on but no API key is saved on the active account', () => {
    setFallbackEnabled(h.accDir, true);
    h.stdout.length = 0;
    handleStatus(h.ctx);
    assert.match(h.stdout.join('\n'), /fallback is on but no API key saved/);
  });
});

// ────────────────────────────────────────────────────────────────────
// handleAliasSet / handleAliasList / handleAliasRemove
// ────────────────────────────────────────────────────────────────────

describe('handleAliasSet', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@b.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('persists a new alias and confirms', () => {
    handleAliasSet(h.ctx, 'work', 'a@b.com');
    assert.match(h.stdout.join('\n'), /work.*a@b\.com|alias.*set/i);
    // Verify the on-disk file actually contains the mapping.
    const aliases = JSON.parse(fs.readFileSync(path.join(h.accDir, 'aliases.json'), 'utf-8'));
    assert.equal(aliases.work, 'a@b.com');
  });

  it('throws ExitError when email is missing', () => {
    assert.throws(
      () => handleAliasSet(h.ctx, 'work', undefined),
      ExitError,
    );
  });
});

describe('handleAliasList', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@b.com');
    fs.writeFileSync(path.join(h.accDir, 'aliases.json'), JSON.stringify({
      work: 'a@b.com',
      personal: 'a@b.com',
    }));
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('lists every saved alias', () => {
    handleAliasList(h.ctx);
    const out = h.stdout.join('\n');
    assert.match(out, /work/);
    assert.match(out, /personal/);
  });

  it('reports the empty state cleanly when no aliases exist', () => {
    fs.unlinkSync(path.join(h.accDir, 'aliases.json'));
    h.stdout.length = 0;
    handleAliasList(h.ctx);
    assert.match(h.stdout.join('\n'), /no aliases|empty|none/i);
  });
});

describe('handleAliasRemove', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@b.com');
    fs.writeFileSync(path.join(h.accDir, 'aliases.json'), JSON.stringify({
      work: 'a@b.com',
    }));
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('removes the alias and confirms', () => {
    handleAliasRemove(h.ctx, 'work');
    const aliases = JSON.parse(fs.readFileSync(path.join(h.accDir, 'aliases.json'), 'utf-8'));
    assert.equal(aliases.work, undefined);
  });

  it('throws ExitError when the alias does not exist', () => {
    assert.throws(
      () => handleAliasRemove(h.ctx, 'ghost'),
      ExitError,
    );
  });

  it('throws ExitError when no name is given', () => {
    assert.throws(
      () => handleAliasRemove(h.ctx, undefined),
      ExitError,
    );
  });
});
