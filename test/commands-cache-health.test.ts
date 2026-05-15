// test/commands-cache-health.test.ts
// Tests for src/commands/cache-health.ts
//
// Validates: text output, JSON output, --session bypass, no-session exit-1.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleCacheHealth } from '../src/commands/cache-health.js';
import { ExitError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cmd-cache-health-'));
}

function makeAssistantEntry(
  cacheRead: number,
  cacheCreation: number,
  inputTokens: number,
  timestamp?: string,
): unknown {
  return {
    type: 'assistant',
    ...(timestamp !== undefined ? { timestamp } : {}),
    message: {
      role: 'assistant',
      usage: {
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        input_tokens: inputTokens,
      },
    },
  };
}

function writeTmpJsonl(dir: string, lines: unknown[], filename = 'session.jsonl'): string {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

/** Capture console.log calls within a function, return collected lines. */
function captureOutput(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests: text output via --session
// ---------------------------------------------------------------------------

describe('handleCacheHealth — text output (--session)', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('produces text output containing "turns: N" for a session with 3 turns', () => {
    const jsonlPath = writeTmpJsonl(dir, [
      makeAssistantEntry(0, 20000, 500),    // turn 0 — initial
      makeAssistantEntry(8000, 200, 100),   // turn 1 — cache hit
      makeAssistantEntry(9000, 100, 50),    // turn 2 — cache hit
    ]);

    const out = captureOutput(() => {
      handleCacheHealth({ sessionPath: jsonlPath, json: false });
    });

    assert.ok(out.includes('3'), `expected "3" turns in output, got:\n${out}`);
    assert.ok(out.includes('Turns:'), `expected "Turns:" label in output, got:\n${out}`);
  });

  it('shows "No cache flushes detected" when no flushes are present', () => {
    const jsonlPath = writeTmpJsonl(dir, [
      makeAssistantEntry(0, 20000, 500),   // turn 0 — initial
      makeAssistantEntry(8000, 200, 100),  // turn 1 — cache hit
    ]);

    const out = captureOutput(() => {
      handleCacheHealth({ sessionPath: jsonlPath, json: false });
    });

    assert.ok(out.includes('No cache flushes'), `expected "No cache flushes" in output, got:\n${out}`);
  });

  it('lists flush events when present', () => {
    const jsonlPath = writeTmpJsonl(dir, [
      makeAssistantEntry(0, 20000, 500),    // turn 0 — initial
      makeAssistantEntry(100, 8000, 200),   // turn 1 — FLUSH
    ]);

    const out = captureOutput(() => {
      handleCacheHealth({ sessionPath: jsonlPath, json: false });
    });

    assert.ok(out.includes('turn 1'), `expected "turn 1" in output, got:\n${out}`);
    assert.ok(out.includes('line'), `expected "line" in output, got:\n${out}`);
  });

  it('shows hit ratio as percentage', () => {
    const jsonlPath = writeTmpJsonl(dir, [
      makeAssistantEntry(0, 10000, 0),    // turn 0 — initial creation
      makeAssistantEntry(9000, 0, 0),     // turn 1 — full cache hit
    ]);

    const out = captureOutput(() => {
      handleCacheHealth({ sessionPath: jsonlPath, json: false });
    });

    assert.ok(out.includes('%'), `expected "%" in output, got:\n${out}`);
    assert.ok(out.includes('Hit ratio:'), `expected "Hit ratio:" in output, got:\n${out}`);
  });
});

// ---------------------------------------------------------------------------
// Tests: JSON output via --session --json
// ---------------------------------------------------------------------------

describe('handleCacheHealth — JSON output (--session --json)', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('produces parsable JSON with required fields', () => {
    const jsonlPath = writeTmpJsonl(dir, [
      makeAssistantEntry(0, 20000, 500),
      makeAssistantEntry(8000, 200, 100),
    ]);

    let jsonOut = '';
    const orig = console.log;
    console.log = (...args: unknown[]) => { jsonOut += args.map(String).join(' ') + '\n'; };
    try {
      handleCacheHealth({ sessionPath: jsonlPath, json: true });
    } finally {
      console.log = orig;
    }

    let parsed: unknown;
    assert.doesNotThrow(() => { parsed = JSON.parse(jsonOut); }, 'output must be valid JSON');

    const obj = parsed as Record<string, unknown>;
    assert.ok('summary' in obj, 'JSON must have "summary" field');
    assert.ok('sessionPath' in obj, 'JSON must have "sessionPath" field');
    assert.ok('flushes' in obj, 'JSON must have "flushes" field');
    assert.ok(Array.isArray(obj['flushes']), '"flushes" must be an array');

    const summary = obj['summary'] as Record<string, unknown>;
    assert.ok(typeof summary['turns'] === 'number', '"summary.turns" must be a number');
    assert.ok(typeof summary['hitRatio'] === 'number', '"summary.hitRatio" must be a number');
    assert.ok(typeof summary['flushCount'] === 'number', '"summary.flushCount" must be a number');
    assert.ok(typeof summary['effectiveInputTokens'] === 'number', '"summary.effectiveInputTokens" must be a number');
  });

  it('includes flush events with turn, line, timestamp in JSON output', () => {
    const ts = '2026-05-15T10:00:00.000Z';
    const jsonlPath = writeTmpJsonl(dir, [
      makeAssistantEntry(0, 20000, 500),           // turn 0
      makeAssistantEntry(100, 8000, 200, ts),      // turn 1 — FLUSH with timestamp
    ]);

    let jsonOut = '';
    const orig = console.log;
    console.log = (...args: unknown[]) => { jsonOut += args.map(String).join(' ') + '\n'; };
    try {
      handleCacheHealth({ sessionPath: jsonlPath, json: true });
    } finally {
      console.log = orig;
    }

    const obj = JSON.parse(jsonOut) as Record<string, unknown>;
    const flushes = obj['flushes'] as Array<Record<string, unknown>>;
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0]?.['turn'], 1);
    assert.ok(typeof flushes[0]?.['line'] === 'number');
    assert.strictEqual(flushes[0]?.['timestamp'], ts);
  });
});

// ---------------------------------------------------------------------------
// Tests: no session → exit 1
// ---------------------------------------------------------------------------

describe('handleCacheHealth — no session exits with code 1', () => {
  let dir: string;
  let origEnv: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    dir = makeTmpDir();
    origEnv = process.env.CLAUDE_PROJECTS_DIR;
    origCwd = process.cwd();
    // Point CLAUDE_PROJECTS_DIR to an empty tmp dir so no session can be found.
    process.env.CLAUDE_PROJECTS_DIR = dir;
    // Change to a directory with no session files.
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origEnv === undefined) {
      delete process.env.CLAUDE_PROJECTS_DIR;
    } else {
      process.env.CLAUDE_PROJECTS_DIR = origEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws ExitError with code 1 when no session is found', () => {
    assert.throws(
      () => handleCacheHealth({ json: false }),
      (err: unknown) => {
        assert.ok(err instanceof ExitError, 'must throw ExitError');
        assert.strictEqual(err.code, 1, `expected exit code 1, got ${err.code}`);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: --session with missing file → exit 1
// ---------------------------------------------------------------------------

describe('handleCacheHealth — --session with missing file exits with code 1', () => {
  it('throws ExitError when the specified JSONL file does not exist', () => {
    assert.throws(
      () => handleCacheHealth({ sessionPath: '/nonexistent/session.jsonl', json: false }),
      (err: unknown) => {
        assert.ok(err instanceof ExitError, 'must throw ExitError');
        assert.strictEqual(err.code, 1);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: --session bypasses active-session lookup
// ---------------------------------------------------------------------------

describe('handleCacheHealth — --session bypasses lookup', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads the specified path even when CLAUDE_PROJECTS_DIR has no sessions', () => {
    // Write a valid session file in a standalone directory (not under ~/.claude/projects).
    const jsonlPath = writeTmpJsonl(dir, [
      makeAssistantEntry(0, 10000, 200),
      makeAssistantEntry(5000, 100, 50),
    ]);

    // Point CLAUDE_PROJECTS_DIR somewhere empty — lookup would return null.
    const emptyProjectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-projects-'));
    process.env.CLAUDE_PROJECTS_DIR = emptyProjectsDir;

    let out = '';
    const orig = console.log;
    console.log = (...args: unknown[]) => { out += args.map(String).join(' ') + '\n'; };
    try {
      // Should NOT throw despite no active session — because --session bypasses lookup.
      handleCacheHealth({ sessionPath: jsonlPath, json: false });
    } finally {
      console.log = orig;
      delete process.env.CLAUDE_PROJECTS_DIR;
      fs.rmSync(emptyProjectsDir, { recursive: true, force: true });
    }

    assert.ok(out.includes('Turns:'), `expected output with turns, got:\n${out}`);
    assert.ok(out.includes('2'), `expected 2 turns, got:\n${out}`);
  });
});

// ---------------------------------------------------------------------------
// Tests: large flush count (≥ 20) uses summary format
// ---------------------------------------------------------------------------

describe('handleCacheHealth — large flush count uses summary format', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('shows "N flushes total, first at line X, last at line Y" for ≥20 flushes', () => {
    // Build 21 flushes: turn 0 initial, then 21 flush turns.
    const entries: unknown[] = [makeAssistantEntry(0, 20000, 500)]; // turn 0
    for (let i = 0; i < 21; i++) {
      entries.push(makeAssistantEntry(100, 8000, 200)); // flush turn
    }
    const jsonlPath = writeTmpJsonl(dir, entries);

    const out = captureOutput(() => {
      handleCacheHealth({ sessionPath: jsonlPath, json: false });
    });

    assert.ok(
      out.includes('flushes total'),
      `expected "flushes total" summary format, got:\n${out}`,
    );
    assert.ok(out.includes('first at line'), `expected "first at line" in output, got:\n${out}`);
    assert.ok(out.includes('last at line'), `expected "last at line" in output, got:\n${out}`);
  });
});
