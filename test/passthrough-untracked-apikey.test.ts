// test/passthrough-untracked-apikey.test.ts
// Unit tests for the Phase 14.3 transitional warning that fires when
// ~/.claude.json carries an apiKey NOT tracked by claude-switch.
//
// We test the helper function directly (same approach as
// passthrough-prewarm.test.ts) to avoid spawning a real passthrough process.
//
// Privacy: fixture emails use sirtheo.work@example.com / sirtheo.personal@example.com
// as required by CLAUDE.md privacy policy.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  warnUntrackedApiKeyIfNeeded,
  __resetWarnedOnceForTests,
} from '../src/commands/passthrough.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let accountsDir: string;
let claudeJsonPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-warn14-'));
  accountsDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  claudeJsonPath = path.join(tmpDir, '.claude.json');
  // Reset the one-shot guard so each test gets a fresh state.
  __resetWarnedOnceForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Restore NODE_ENV / CLAUDE_SWITCH_TESTING in case a test modified them.
  delete process.env.CLAUDE_SWITCH_TESTING;
  if (process.env.NODE_ENV !== 'test') {
    process.env.NODE_ENV = 'test';
  }
});

/** Write a minimal ~/.claude.json with optional apiKey and email. */
function writeClaudeJson(opts: { apiKey?: string; email?: string }): void {
  const data: Record<string, unknown> = {};
  if (opts.email) data.oauthAccount = { emailAddress: opts.email };
  if (opts.apiKey) data.apiKey = opts.apiKey;
  fs.writeFileSync(claudeJsonPath, JSON.stringify(data));
}

/** Write a minimal account file with optional _apiKey (tracked by claude-switch). */
function writeAccountFile(email: string, opts: { apiKey?: string } = {}): void {
  const data: Record<string, unknown> = { emailAddress: email };
  if (opts.apiKey) data._apiKey = opts.apiKey;
  fs.writeFileSync(
    path.join(accountsDir, `${email}.json`),
    JSON.stringify(data),
    { mode: 0o600 },
  );
}

/** Capture stderr writes produced by the helper during the call. */
function captureStderr(fn: () => void): string {
  let captured = '';
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only monkey-patch
  (process.stderr as any).write = (chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  try {
    fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
    (process.stderr as any).write = original;
  }
  return captured;
}

// ---------------------------------------------------------------------------
// Tests (run with CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 from npm test)
// ---------------------------------------------------------------------------

const EMAIL = 'sirtheo.work@example.com';
const TRACKED_KEY = 'sk-ant-api03-tracked-WXYZ';
const UNTRACKED_KEY = 'sk-ant-api03-untracked-WXYZ';

describe('warnUntrackedApiKeyIfNeeded', () => {
  it('Case A: apiKey tracked in account file + claude.json apiKey → NO banner', () => {
    // Both claude.json and the account file carry the same key — getApiKey
    // returns non-null, so the warning must not fire.
    writeClaudeJson({ email: EMAIL, apiKey: TRACKED_KEY });
    writeAccountFile(EMAIL, { apiKey: TRACKED_KEY });

    const out = captureStderr(() => {
      // Unset test suppression so the guard logic runs (not the NODE_ENV branch).
      const saved = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      warnUntrackedApiKeyIfNeeded(claudeJsonPath, accountsDir);
      if (saved !== undefined) process.env.NODE_ENV = saved;
    });

    assert.equal(out, '', 'Expected no banner when key is tracked');
  });

  it('Case B: apiKey NOT tracked + claude.json apiKey populated → banner emitted', () => {
    // claude.json has an apiKey but claude-switch has no record of it.
    writeClaudeJson({ email: EMAIL, apiKey: UNTRACKED_KEY });
    writeAccountFile(EMAIL); // no _apiKey in account file

    let out = '';
    // Temporarily lift NODE_ENV suppression so the actual logic can run.
    const savedEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    delete process.env.CLAUDE_SWITCH_TESTING;
    try {
      out = captureStderr(() => {
        warnUntrackedApiKeyIfNeeded(claudeJsonPath, accountsDir);
      });
    } finally {
      if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
    }

    assert.ok(out.includes('⚠ claude-switch:'), `Expected banner, got: ${JSON.stringify(out)}`);
    assert.ok(out.includes('NOT tracked'), `Banner missing key phrase, got: ${JSON.stringify(out)}`);
    assert.ok(out.includes('silent API billing'), `Banner missing billing mention, got: ${JSON.stringify(out)}`);
  });

  it('Case C: apiKey untracked + claude.json apiKey NULL → NO banner', () => {
    // claude.json has no apiKey at all — nothing to warn about.
    writeClaudeJson({ email: EMAIL }); // no apiKey field
    writeAccountFile(EMAIL);

    const savedEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    delete process.env.CLAUDE_SWITCH_TESTING;
    let out = '';
    try {
      out = captureStderr(() => {
        warnUntrackedApiKeyIfNeeded(claudeJsonPath, accountsDir);
      });
    } finally {
      if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
    }

    assert.equal(out, '', 'Expected no banner when claude.json has no apiKey');
  });

  it('Case D1: NODE_ENV=test suppresses the banner', () => {
    writeClaudeJson({ email: EMAIL, apiKey: UNTRACKED_KEY });
    writeAccountFile(EMAIL);

    process.env.NODE_ENV = 'test';
    const out = captureStderr(() => {
      warnUntrackedApiKeyIfNeeded(claudeJsonPath, accountsDir);
    });

    assert.equal(out, '', 'Expected no banner when NODE_ENV=test');
  });

  it('Case D2: CLAUDE_SWITCH_TESTING=1 suppresses the banner', () => {
    writeClaudeJson({ email: EMAIL, apiKey: UNTRACKED_KEY });
    writeAccountFile(EMAIL);

    const savedEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    process.env.CLAUDE_SWITCH_TESTING = '1';
    let out = '';
    try {
      out = captureStderr(() => {
        warnUntrackedApiKeyIfNeeded(claudeJsonPath, accountsDir);
      });
    } finally {
      if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
    }

    assert.equal(out, '', 'Expected no banner when CLAUDE_SWITCH_TESTING=1');
  });

  it('one-shot: banner fires only once per process (warnedOnce guard)', () => {
    writeClaudeJson({ email: EMAIL, apiKey: UNTRACKED_KEY });
    writeAccountFile(EMAIL);

    const savedEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    delete process.env.CLAUDE_SWITCH_TESTING;
    let firstOut = '';
    let secondOut = '';
    try {
      firstOut = captureStderr(() => warnUntrackedApiKeyIfNeeded(claudeJsonPath, accountsDir));
      secondOut = captureStderr(() => warnUntrackedApiKeyIfNeeded(claudeJsonPath, accountsDir));
    } finally {
      if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
    }

    assert.ok(firstOut.includes('⚠ claude-switch:'), 'First call should emit banner');
    assert.equal(secondOut, '', 'Second call must be suppressed by one-shot guard');
  });
});
