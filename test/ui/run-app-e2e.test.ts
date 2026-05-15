// test/ui/run-app-e2e.test.ts
// Phase 19.3 — E2E interactive tests for src/ui/run-app.ts.
//
// Tests the full runApp() lifecycle (alt-buffer wiring, SIGINT/SIGTERM
// handling) in-process without spawning a subprocess or requiring a real
// TTY. Spawning would require node-pty (excluded by task constraint) or
// /dev/tty (unavailable in this CI/sandbox environment).
//
// Two test groups:
//   A — Happy-path: _runDispatchLoop with renderHome stub that dispatches
//       a side-effecting action before returning {action: 'exit'}. The
//       dispatch loop resolves without throw → "exit 0" semantics.
//   B — SIGINT: _internal.makeSigintHandler factory; stub process.exit to
//       capture the exit code, verify restoreBuffer was called, verify
//       exit code = 130.
//
// Privacy: no real emails; fixtures use sirtheo.work@example.com.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _runDispatchLoop, _internal } from '../../src/ui/run-app.js';
import { setApiKey } from '../../src/apikey.js';
import { save as saveAccount } from '../../src/accounts.js';
import type { HomeExit } from '../../src/ui/screens/home.js';

// ---------------------------------------------------------------------------
// Minimal harness (mirrors run-app-harness.ts without the ink render wrapper)
// ---------------------------------------------------------------------------

interface Harness {
  tmpDir: string;
  claudeJsonPath: string;
  accountsDir: string;
  email: string;
  cleanup(): void;
}

function makeHarness(email = 'sirtheo.work@example.com'): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-e2e-ipc-'));
  const claudeJsonPath = path.join(tmpDir, '.claude.json');
  const accountsDir = path.join(tmpDir, 'accounts');

  fs.mkdirSync(accountsDir, { recursive: true });
  fs.writeFileSync(
    claudeJsonPath,
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );

  return {
    tmpDir,
    claudeJsonPath,
    accountsDir,
    email,
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Happy-path: _runDispatchLoop resolves cleanly (exit 0 semantics)
// ---------------------------------------------------------------------------

describe('E2E interactive — happy-path (in-process)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it('dispatches fallback-toggle then exits → resolves without throw', async () => {
    // Seed account + API key so handleFallbackToggle can enable without prompting.
    saveAccount(h.email, h.claudeJsonPath, h.accountsDir);
    setApiKey(h.email, 'sk-ant-api03-e2e-test', h.accountsDir);

    let callCount = 0;

    // Simulate: user presses the fallback-toggle key (one action), then 'q'
    // to quit. In the real home screen 'q' resolves to {action: 'exit'}.
    const renderStub = async (): Promise<HomeExit> => {
      callCount++;
      if (callCount === 1) {
        return { action: 'fallback-toggle' };
      }
      return { action: 'exit' };
    };

    // Must resolve without throwing. If it throws, the test fails.
    await _runDispatchLoop(h.claudeJsonPath, h.accountsDir, renderStub);

    assert.equal(callCount, 2,
      'renderStub must be called twice: once for the action, once for exit');
  });

  it('dispatches switched action then exits → resolves without throw', async () => {
    let callCount = 0;

    // Simulate: user picks the same account (no-op switch), then quits.
    const renderStub = async (): Promise<HomeExit> => {
      callCount++;
      if (callCount === 1) {
        return {
          action: 'switched',
          payload: {
            switchedFrom: h.email,
            switchedTo: h.email,
            autoLaunch: false,
            defaultIsolated: false,
          },
        };
      }
      return { action: 'exit' };
    };

    await _runDispatchLoop(h.claudeJsonPath, h.accountsDir, renderStub);

    assert.equal(callCount, 2,
      'renderStub must be called twice: once for switched, once for exit');
  });
});

// ---------------------------------------------------------------------------
// SIGINT: makeSigintHandler calls restoreBuffer + exits with code 130
// ---------------------------------------------------------------------------

describe('E2E interactive — SIGINT (in-process)', () => {
  let h: Harness;
  // Captured exit code from the stubbed process.exit.
  let capturedExitCode: number | undefined;
  // Real process.exit, restored in afterEach.
  let realProcessExit: (code?: number) => never;

  beforeEach(() => {
    h = makeHarness();
    capturedExitCode = undefined;
    realProcessExit = process.exit as unknown as (code?: number) => never;
    // Stub process.exit: capture code and throw so it doesn't actually exit.
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit =
      ((code?: number): never => {
        capturedExitCode = code;
        throw new Error(`__stubbed_exit_${code}__`);
      }) as (code?: number) => never;
  });

  afterEach(() => {
    // Always restore process.exit before cleanup.
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit =
      realProcessExit as (code?: number) => never;
    h.cleanup();
  });

  it('SIGINT handler calls restoreBuffer then exits with code 130', () => {
    let restoreBufferCallCount = 0;
    const restoreBuffer = (): void => { restoreBufferCallCount++; };

    const sigintHandler = _internal.makeSigintHandler(restoreBuffer);

    // Calling the handler should: (1) invoke restoreBuffer, (2) call process.exit(130).
    // process.exit is stubbed to throw so we catch the throw.
    assert.throws(
      () => sigintHandler(),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected an Error from stubbed process.exit');
        assert.match(err.message, /__stubbed_exit_130__/,
          'stubbed exit must carry code 130 in the message');
        return true;
      },
    );

    assert.equal(restoreBufferCallCount, 1,
      'restoreBuffer must be called exactly once by the SIGINT handler');
    assert.equal(capturedExitCode, 130,
      'SIGINT handler must exit with code 130');
  });

  it('SIGTERM handler calls restoreBuffer then exits with code 143', () => {
    let restoreBufferCallCount = 0;
    const restoreBuffer = (): void => { restoreBufferCallCount++; };

    const sigtermHandler = _internal.makeSigtermHandler(restoreBuffer);

    assert.throws(
      () => sigtermHandler(),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected an Error from stubbed process.exit');
        assert.match(err.message, /__stubbed_exit_143__/,
          'stubbed exit must carry code 143 in the message');
        return true;
      },
    );

    assert.equal(restoreBufferCallCount, 1,
      'restoreBuffer must be called exactly once by the SIGTERM handler');
    assert.equal(capturedExitCode, 143,
      'SIGTERM handler must exit with code 143');
  });

  it('SIGINT via process.emit invokes the registered handler', () => {
    // Verify the factory produces a handler compatible with process.on('SIGINT').
    // Register it, emit SIGINT, confirm it ran, then remove it.
    let restoreBufferCallCount = 0;
    const restoreBuffer = (): void => { restoreBufferCallCount++; };

    const handler = _internal.makeSigintHandler(restoreBuffer);
    process.on('SIGINT', handler);

    try {
      assert.throws(
        () => process.emit('SIGINT'),
        (err: unknown) => {
          assert.ok(err instanceof Error, 'expected Error from stubbed exit');
          assert.match(err.message, /__stubbed_exit_130__/);
          return true;
        },
      );
    } finally {
      // Always remove the listener to avoid polluting subsequent tests.
      process.removeListener('SIGINT', handler);
    }

    assert.equal(restoreBufferCallCount, 1,
      'restoreBuffer must be called when SIGINT is emitted');
    assert.equal(capturedExitCode, 130,
      'exit code must be 130 after SIGINT');
  });
});
