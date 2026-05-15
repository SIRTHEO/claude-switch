// test/ui/run-app-harness.ts
// Factory for the run-app orchestrator test harness.
//
// Provides the minimal fixture surface needed to exercise src/ui/run-app.ts
// _internal handlers in isolation — without touching a real TTY, real
// Keychain, or real claude binary.
//
// Design decisions:
//   - accountsDir + claudeJsonPath are created fresh per test via makeRunAppHarness()
//   - claudeBinFake is a tiny shell script (exit 0) so spawn paths short-circuit
//     without side effects. Node-based mock (test/fixtures/claude-mock.mjs) is
//     heavier and inspects CLAUDE_CONFIG_DIR; the shell stub is sufficient here.
//   - inkRender wraps ink-testing-library's render(), tracks active instances, and
//     unmounts them all on cleanup() to prevent Ink internal timer leaks (Phase 18.1).
//   - cleanup() handles: all mounted instances → tmp dirs → HOME restore.
//
// Privacy: never embed real emails; use sirtheo.work@example.com in fixtures.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReactElement } from 'react';
import { render } from 'ink-testing-library';

// ---------------------------------------------------------------------------
// Structural type for ink-testing-library Instance (not exported by the lib).
// Keep in sync with ink-keystroke-helper.ts definition.
// ---------------------------------------------------------------------------
interface InkInstance {
  stdin: { write(data: string): void };
  unmount?: () => void;
  lastFrame?: () => string | undefined;
  frames?: string[];
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Options accepted by makeRunAppHarness. */
export interface RunAppHarnessOptions {
  /** Email written as the active oauthAccount in claudeJsonPath. Default: sirtheo.work@example.com */
  activeEmail?: string;
}

/** Harness returned by makeRunAppHarness(). */
export interface RunAppHarness {
  /** Absolute path to the temporary accounts directory. */
  accountsDir: string;
  /** Absolute path to the temporary claude.json file. */
  claudeJsonPath: string;
  /** Absolute path to the fake claude shell script (exit 0, chmod 755). */
  claudeBinFake: string;
  /** Root tmp dir (parent of accountsDir and claudeJsonPath). */
  tmpDir: string;
  /**
   * Render a React element using ink-testing-library, tracking the returned
   * instance for automatic unmount on cleanup().
   */
  inkRender(tree: ReactElement): InkInstance;
  /**
   * Cleanup: unmount all tracked Ink instances, remove tmp dirs, restore HOME.
   * Safe to call multiple times (idempotent).
   */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh RunAppHarness with isolated tmp dirs and a fake claude
 * binary. Call harness.cleanup() in afterEach() to avoid timer / disk leaks.
 *
 * @example
 * ```ts
 * let h: RunAppHarness;
 * beforeEach(() => { h = makeRunAppHarness(); });
 * afterEach(() => h.cleanup());
 * ```
 */
export function makeRunAppHarness(opts: RunAppHarnessOptions = {}): RunAppHarness {
  const activeEmail = opts.activeEmail ?? 'sirtheo.work@example.com';

  // ── Tmp dirs ──────────────────────────────────────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-runapp-harness-'));
  const accountsDir = path.join(tmpDir, 'accounts');
  const claudeJsonPath = path.join(tmpDir, '.claude.json');

  fs.mkdirSync(accountsDir, { recursive: true });

  // Minimal claude.json with an active account
  fs.writeFileSync(
    claudeJsonPath,
    JSON.stringify({ oauthAccount: { emailAddress: activeEmail } }),
  );

  // ── Fake claude binary ────────────────────────────────────────────────────
  // A minimal POSIX shell script that exits 0 immediately.
  // Sufficient to make paths that findClaudeBinary() + spawnSync() use
  // short-circuit without producing observable side effects.
  const claudeBinFake = path.join(tmpDir, 'claude-fake');
  fs.writeFileSync(claudeBinFake, '#!/usr/bin/env sh\nexit 0\n');
  fs.chmodSync(claudeBinFake, 0o755);

  // ── HOME override ─────────────────────────────────────────────────────────
  // Some domain modules read from os.homedir() / HOME to locate prefs.
  // Redirect to tmpDir so the test is hermetic.
  const prevHome = process.env.HOME;
  process.env.HOME = tmpDir;

  // ── Ink instance tracking ─────────────────────────────────────────────────
  const activeInstances: InkInstance[] = [];

  let cleaned = false;

  // ── inkRender wrapper ─────────────────────────────────────────────────────
  function inkRender(tree: ReactElement): InkInstance {
    // ink-testing-library render() returns an object with at minimum
    // { stdin, unmount, lastFrame, frames }. Cast via unknown since the
    // lib's .d.ts doesn't export the Instance type.
    const instance = render(tree) as unknown as InkInstance;
    activeInstances.push(instance);
    return instance;
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;

    // Unmount all tracked Ink instances to stop internal timers.
    for (const inst of activeInstances) {
      try { inst.unmount?.(); } catch { /* best effort */ }
    }
    activeInstances.length = 0;

    // Restore HOME before removing tmpDir (some OSes lock open dirs).
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }

    // Remove tmp tree.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    accountsDir,
    claudeJsonPath,
    claudeBinFake,
    tmpDir,
    inkRender,
    cleanup,
  };
}
