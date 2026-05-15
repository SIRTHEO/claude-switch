// test/cache-health.test.ts
// Tests for src/cache-health.ts — Phase 15.1
//
// The Claude Code session JSONL format has:
//   { "type": "assistant", "message": { "role": "assistant", "usage": { ... } }, ... }
// usage fields: cache_read_input_tokens, cache_creation_input_tokens, input_tokens

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSessionJsonl,
  summariseCacheHealth,
} from '../src/cache-health.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cache-health-'));
}

function writeTmpJsonl(dir: string, lines: unknown[]): string {
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

function makeAssistantEntry(
  cacheRead: number,
  cacheCreation: number,
  inputTokens: number,
): unknown {
  return {
    type: 'assistant',
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

// ---------------------------------------------------------------------------
// readSessionJsonl
// ---------------------------------------------------------------------------

describe('readSessionJsonl — empty / whitespace input', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns [] for an empty file', () => {
    const p = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(p, '');
    assert.deepStrictEqual(readSessionJsonl(p), []);
  });

  it('returns [] for a file containing only whitespace/newlines', () => {
    const p = path.join(dir, 'ws.jsonl');
    fs.writeFileSync(p, '   \n\n   \n');
    assert.deepStrictEqual(readSessionJsonl(p), []);
  });
});

describe('readSessionJsonl — 1-turn with cache fields', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parses a single assistant entry with cache fields', () => {
    const p = writeTmpJsonl(dir, [makeAssistantEntry(1000, 2000, 500)]);
    const result = readSessionJsonl(p);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.cache_read, 1000);
    assert.strictEqual(result[0]?.cache_creation, 2000);
    assert.strictEqual(result[0]?.input_tokens, 500);
  });

  it('uses 0 as fallback for absent cache fields', () => {
    const entry = {
      type: 'assistant',
      message: { role: 'assistant', usage: { input_tokens: 42 } },
    };
    const p = writeTmpJsonl(dir, [entry]);
    const result = readSessionJsonl(p);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.cache_read, 0);
    assert.strictEqual(result[0]?.cache_creation, 0);
    assert.strictEqual(result[0]?.input_tokens, 42);
  });
});

describe('readSessionJsonl — multi-turn aggregation source', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns one AssistantTurn per assistant entry', () => {
    const p = writeTmpJsonl(dir, [
      makeAssistantEntry(500, 1000, 100),
      makeAssistantEntry(600, 1200, 200),
      makeAssistantEntry(700, 1400, 300),
    ]);
    const result = readSessionJsonl(p);
    assert.strictEqual(result.length, 3);
  });

  it('skips non-assistant entries', () => {
    const p = writeTmpJsonl(dir, [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      makeAssistantEntry(100, 200, 50),
      { type: 'system', message: { role: 'system', content: 'sys' } },
    ]);
    const result = readSessionJsonl(p);
    assert.strictEqual(result.length, 1);
  });
});

describe('readSessionJsonl — malformed lines', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('skips invalid JSON lines without throwing', () => {
    const p = path.join(dir, 'mixed.jsonl');
    const lines = [
      JSON.stringify(makeAssistantEntry(100, 200, 50)),
      'not valid json {{{',
      JSON.stringify(makeAssistantEntry(300, 400, 150)),
    ].join('\n');
    fs.writeFileSync(p, lines);
    const result = readSessionJsonl(p);
    assert.strictEqual(result.length, 2);
  });

  it('skips entries with missing usage object', () => {
    const noUsage = { type: 'assistant', message: { role: 'assistant' } };
    const p = writeTmpJsonl(dir, [noUsage, makeAssistantEntry(100, 200, 50)]);
    const result = readSessionJsonl(p);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.cache_read, 100);
  });

  it('skips entries where usage is not an object', () => {
    const badUsage = {
      type: 'assistant',
      message: { role: 'assistant', usage: 'string-not-object' },
    };
    const p = writeTmpJsonl(dir, [badUsage, makeAssistantEntry(10, 20, 5)]);
    const result = readSessionJsonl(p);
    assert.strictEqual(result.length, 1);
  });
});

// ---------------------------------------------------------------------------
// summariseCacheHealth
// ---------------------------------------------------------------------------

describe('summariseCacheHealth — empty input', () => {
  it('returns zeroed summary for empty turns', () => {
    const s = summariseCacheHealth([]);
    assert.strictEqual(s.turns, 0);
    assert.strictEqual(s.totalCacheRead, 0);
    assert.strictEqual(s.totalCacheCreation, 0);
    assert.strictEqual(s.totalInput, 0);
    assert.strictEqual(s.hitRatio, 0);
    assert.strictEqual(s.flushCount, 0);
    assert.strictEqual(s.effectiveInputTokens, 0);
    assert.strictEqual(s.lastFlushAt, null);
  });
});

describe('summariseCacheHealth — hitRatio bounds', () => {
  it('hitRatio is 0 when denominator is 0', () => {
    const s = summariseCacheHealth([{ cache_read: 0, cache_creation: 0, input_tokens: 0 }]);
    assert.strictEqual(s.hitRatio, 0);
  });

  it('hitRatio stays in [0, 1] for normal data', () => {
    const turns = [
      { cache_read: 5000, cache_creation: 2000, input_tokens: 1000 },
      { cache_read: 8000, cache_creation: 500, input_tokens: 200 },
    ];
    const s = summariseCacheHealth(turns);
    assert.ok(s.hitRatio >= 0 && s.hitRatio <= 1, `hitRatio out of bounds: ${s.hitRatio}`);
  });

  it('hitRatio is cache_read / total tokens', () => {
    // cache_read=1000, cache_creation=0, input=0 → hitRatio = 1000/1000 = 1.0
    const s = summariseCacheHealth([{ cache_read: 1000, cache_creation: 0, input_tokens: 0 }]);
    assert.strictEqual(s.hitRatio, 1.0);
  });
});

describe('summariseCacheHealth — pricing math', () => {
  it('computes effectiveInputTokens correctly: read=1000 cr=2000 input=500 → 3100', () => {
    // cache_read × 0.1 + cache_creation × 1.25 + input × 1.0
    // 1000×0.1 + 2000×1.25 + 500×1.0 = 100 + 2500 + 500 = 3100
    const s = summariseCacheHealth([{ cache_read: 1000, cache_creation: 2000, input_tokens: 500 }]);
    assert.strictEqual(s.effectiveInputTokens, 3100);
  });

  it('aggregates effectiveInputTokens across multiple turns', () => {
    // turn1: 1000×0.1 + 2000×1.25 + 500×1.0 = 3100
    // turn2: 2000×0.1 + 0×1.25 + 1000×1.0 = 200 + 1000 = 1200
    // total = 4300
    const turns = [
      { cache_read: 1000, cache_creation: 2000, input_tokens: 500 },
      { cache_read: 2000, cache_creation: 0, input_tokens: 1000 },
    ];
    const s = summariseCacheHealth(turns);
    assert.strictEqual(s.effectiveInputTokens, 4300);
  });
});

describe('summariseCacheHealth — flush detection', () => {
  it('does NOT flag turn_index 0 as a flush (initial cache creation is expected)', () => {
    // First turn with high cache_creation + low cache_read → no flush
    const turns = [
      { cache_read: 0, cache_creation: 10000, input_tokens: 500 },   // turn 0 — excluded by heuristic
      { cache_read: 5000, cache_creation: 100, input_tokens: 200 },   // turn 1 — normal hit
    ];
    const s = summariseCacheHealth(turns);
    assert.strictEqual(s.flushCount, 0);
    assert.strictEqual(s.lastFlushAt, null);
  });

  it('detects flush at turn_index > 0 when cache_creation > 5000 && cache_read < 1000', () => {
    const turns = [
      { cache_read: 0, cache_creation: 20000, input_tokens: 500 },   // turn 0 — initial, excluded
      { cache_read: 8000, cache_creation: 200, input_tokens: 100 },   // turn 1 — normal hit
      { cache_read: 100, cache_creation: 8000, input_tokens: 200 },   // turn 2 — FLUSH
    ];
    const s = summariseCacheHealth(turns);
    assert.strictEqual(s.flushCount, 1);
    assert.strictEqual(s.lastFlushAt, 2);
  });

  it('counts multiple flushes', () => {
    const turns = [
      { cache_read: 0, cache_creation: 20000, input_tokens: 500 },   // turn 0 — initial
      { cache_read: 100, cache_creation: 6000, input_tokens: 200 },   // turn 1 — flush
      { cache_read: 7000, cache_creation: 100, input_tokens: 100 },   // turn 2 — hit
      { cache_read: 500, cache_creation: 9000, input_tokens: 300 },   // turn 3 — flush
    ];
    const s = summariseCacheHealth(turns);
    assert.strictEqual(s.flushCount, 2);
    assert.strictEqual(s.lastFlushAt, 3);
  });

  it('does not detect flush when cache_creation <= 5000', () => {
    const turns = [
      { cache_read: 0, cache_creation: 10000, input_tokens: 100 },   // turn 0 — initial
      { cache_read: 500, cache_creation: 5000, input_tokens: 100 },   // turn 1 — at threshold, not flush
    ];
    const s = summariseCacheHealth(turns);
    assert.strictEqual(s.flushCount, 0);
  });

  it('does not detect flush when cache_read >= 1000', () => {
    const turns = [
      { cache_read: 0, cache_creation: 10000, input_tokens: 100 },   // turn 0 — initial
      { cache_read: 1000, cache_creation: 8000, input_tokens: 100 }, // turn 1 — cache_read ok, not flush
    ];
    const s = summariseCacheHealth(turns);
    assert.strictEqual(s.flushCount, 0);
  });
});

describe('summariseCacheHealth — multi-turn aggregation', () => {
  it('aggregates totals correctly', () => {
    const turns = [
      { cache_read: 1000, cache_creation: 500, input_tokens: 100 },
      { cache_read: 2000, cache_creation: 1000, input_tokens: 200 },
      { cache_read: 3000, cache_creation: 1500, input_tokens: 300 },
    ];
    const s = summariseCacheHealth(turns);
    assert.strictEqual(s.turns, 3);
    assert.strictEqual(s.totalCacheRead, 6000);
    assert.strictEqual(s.totalCacheCreation, 3000);
    assert.strictEqual(s.totalInput, 600);
  });

  it('computes hitRatio as cacheRead / (cacheRead + cacheCreation + input)', () => {
    // read=6000, creation=3000, input=600 → total=9600
    // hitRatio = 6000/9600 ≈ 0.625
    const turns = [
      { cache_read: 1000, cache_creation: 500, input_tokens: 100 },
      { cache_read: 2000, cache_creation: 1000, input_tokens: 200 },
      { cache_read: 3000, cache_creation: 1500, input_tokens: 300 },
    ];
    const s = summariseCacheHealth(turns);
    const expected = 6000 / 9600;
    assert.ok(
      Math.abs(s.hitRatio - expected) < 1e-9,
      `hitRatio expected ${expected}, got ${s.hitRatio}`,
    );
  });
});
