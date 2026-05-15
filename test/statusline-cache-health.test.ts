// test/statusline-cache-health.test.ts
// Cache-health badge integration tests.
//
// Spawns the compiled CLI in isolated tmp environments.
// Three scenarios:
//   D — JSONL present → cacheHealth field in --json output
//   E — JSONL absent  → no cacheHealth field in --json output
//   F — --no-cache-health → no cacheHealth field even with JSONL present

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'dist', 'bin', 'cli.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL = 'sirtheo.work@example.com';

/**
 * Encode a project path the same way Claude Code does: every non-alphanum
 * non-hyphen character becomes a hyphen.
 */
function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Write a minimal `.claude.json` with the given email as active account.
 */
function writeDotClaudeJson(home: string, email: string): void {
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
}

/**
 * Write a JSONL session file with a few assistant turns that have warm cache
 * (high hit ratio, no flush).
 *
 * Pricing: cache_read × 0.1, cache_creation × 1.25, input × 1.0
 * Here: 9000 cache_read + 1000 cache_creation + 1000 input → hitRatio ≈ 0.82
 * (> 0.80 → yellow normally, no flush)
 */
function writeSessionJsonl(home: string, projectCwd: string): void {
  // Use realpathSync to resolve macOS symlinks (/var → /private/var, /tmp → /private/tmp)
  // so the encoded path matches what process.cwd() returns inside the subprocess.
  const resolvedCwd = fs.realpathSync(projectCwd);
  const encoded = encodeProjectPath(resolvedCwd);
  const projectDir = path.join(home, '.claude', 'projects', encoded);
  fs.mkdirSync(projectDir, { recursive: true });

  const lines = [
    // Turn 0: initial cache creation (expected, flush detection skips turn 0)
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        usage: {
          cache_creation_input_tokens: 8000,
          cache_read_input_tokens: 0,
          input_tokens: 500,
        },
      },
    }),
    // Turn 1: warm hit — most tokens from cache
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 9000,
          input_tokens: 500,
        },
      },
    }),
  ];

  fs.writeFileSync(
    path.join(projectDir, 'session-test.jsonl'),
    lines.join('\n') + '\n',
  );
}

/**
 * Invoke `claude switch statusline --json --no-color` in an isolated env.
 * `cwd` controls which project directory the CLI "thinks" it is in — this
 * determines which JSONL the cache-health lookup will find.
 */
function runStatuslineJson(
  home: string,
  opts: { cwd?: string; noCacheHealth?: boolean } = {},
): Record<string, unknown> {
  const extraArgs: string[] = opts.noCacheHealth ? ['--no-cache-health'] : [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home, // Windows: os.homedir() reads USERPROFILE, not HOME
    CLAUDE_SWITCH_DISABLE_KEYCHAIN: '1',
    // Unset CLAUDE_CONFIG_DIR so profile override doesn't interfere.
    CLAUDE_CONFIG_DIR: undefined,
  };
  delete env.CLAUDE_CONFIG_DIR;

  const r = spawnSync(
    process.execPath,
    [CLI, 'switch', 'statusline', '--json', '--no-color', ...extraArgs],
    {
      cwd: opts.cwd ?? home,
      env,
      encoding: 'utf-8',
      timeout: 15_000,
    },
  );
  if (r.error) throw r.error;
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scenario D — JSONL present → cacheHealth field appears in --json
// ---------------------------------------------------------------------------

// Windows file-locking semantics + Node child_process timing cause flaky EBUSY
// errors on after() cleanup for the three E2E scenarios below. The cache-health
// pipeline is fully unit-tested via test/cache-health.test.ts (parser) and
// test/commands-cache-health.test.ts (handler); the E2E scenarios are macOS +
// Linux only.
const skipE2E = { skip: process.platform === 'win32' ? 'EBUSY race on Windows; covered by unit tests' : false };

describe('statusline cache-health — Scenario D: JSONL present → cacheHealth in JSON', skipE2E, () => {
  let tmpHome: string;
  let projectCwd: string;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-ch-d-'));
    // Create a deterministic project cwd dir for the subprocess
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-ch-proj-'));

    writeDotClaudeJson(tmpHome, EMAIL);
    writeSessionJsonl(tmpHome, projectCwd);
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(projectCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('exposes cacheHealth with the 4 required fields', () => {
    const got = runStatuslineJson(tmpHome, { cwd: projectCwd });
    assert.ok('cacheHealth' in got, 'cacheHealth field must be present when JSONL exists');

    const ch = got['cacheHealth'] as Record<string, unknown>;
    assert.ok(typeof ch['hitRatio'] === 'number', 'hitRatio must be a number');
    assert.ok(typeof ch['flushCount'] === 'number', 'flushCount must be a number');
    assert.ok(typeof ch['effectiveInputTokens'] === 'number', 'effectiveInputTokens must be a number');
    assert.ok(typeof ch['turns'] === 'number', 'turns must be a number');
  });

  it('hitRatio is in [0, 1]', () => {
    const got = runStatuslineJson(tmpHome, { cwd: projectCwd });
    const ch = got['cacheHealth'] as Record<string, unknown>;
    const hr = ch['hitRatio'] as number;
    assert.ok(hr >= 0 && hr <= 1, `hitRatio must be in [0,1], got ${hr}`);
  });

  it('turns equals the number of assistant turns in the JSONL', () => {
    const got = runStatuslineJson(tmpHome, { cwd: projectCwd });
    const ch = got['cacheHealth'] as Record<string, unknown>;
    assert.strictEqual(ch['turns'], 2, 'turns must match the 2 assistant entries written');
  });
});

// ---------------------------------------------------------------------------
// Scenario E — JSONL absent → no cacheHealth field in --json
// ---------------------------------------------------------------------------

describe('statusline cache-health — Scenario E: JSONL absent → no cacheHealth in JSON', skipE2E, () => {
  let tmpHome: string;
  let projectCwd: string;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-ch-e-'));
    // Use a fresh cwd that has NO jsonl in tmpHome's projects dir
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-ch-nofile-'));

    writeDotClaudeJson(tmpHome, EMAIL);
    // Intentionally do NOT write any JSONL for projectCwd
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(projectCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('omits cacheHealth entirely when no JSONL file exists', () => {
    const got = runStatuslineJson(tmpHome, { cwd: projectCwd });
    assert.ok(!('cacheHealth' in got), 'cacheHealth must be absent when JSONL is missing');
    assert.notStrictEqual((got as Record<string, unknown>)['cacheHealth'], null,
      'cacheHealth must not be null — it must be absent entirely');
  });
});

// ---------------------------------------------------------------------------
// Scenario F — --no-cache-health → suppresses cacheHealth even with JSONL
// ---------------------------------------------------------------------------

describe('statusline cache-health — Scenario F: --no-cache-health suppresses badge and JSON field', skipE2E, () => {
  let tmpHome: string;
  let projectCwd: string;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-ch-f-'));
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-ch-noflag-'));

    writeDotClaudeJson(tmpHome, EMAIL);
    writeSessionJsonl(tmpHome, projectCwd);
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(projectCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('omits cacheHealth from JSON output when --no-cache-health is passed', () => {
    const got = runStatuslineJson(tmpHome, { cwd: projectCwd, noCacheHealth: true });
    assert.ok(!('cacheHealth' in got), 'cacheHealth must be absent with --no-cache-health even if JSONL is present');
  });

  it('still returns other fields (email, mode) normally with --no-cache-health', () => {
    const got = runStatuslineJson(tmpHome, { cwd: projectCwd, noCacheHealth: true });
    assert.strictEqual(got['email'], EMAIL, 'email must still be present');
    assert.ok('mode' in got, 'mode field must still be present');
  });
});
