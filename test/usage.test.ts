import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsageCache, fetchUsageCached } from '../src/usage.js';

describe('readUsageCache', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when no cache file exists', () => {
    assert.strictEqual(readUsageCache(dir), null);
  });

  it('returns null on malformed JSON', () => {
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), 'not json');
    assert.strictEqual(readUsageCache(dir), null);
  });

  it('returns null when fetchedAt is missing', () => {
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify({ payload: {} }));
    assert.strictEqual(readUsageCache(dir), null);
  });

  it('returns the parsed cache when shape is valid', () => {
    const cache = {
      fetchedAt: 1700000000000,
      payload: {
        five_hour: { utilization: 42, resets_at: '2026-01-01T00:00:00Z' },
        seven_day: { utilization: 10 },
      },
    };
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
    const got = readUsageCache(dir);
    assert.deepStrictEqual(got, cache);
  });

  it('returns the cache when only rateLimitedUntil is set', () => {
    const cache = { fetchedAt: 1700000000000, rateLimitedUntil: 1700001000000 };
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
    assert.deepStrictEqual(readUsageCache(dir), cache);
  });
});

describe('fetchUsageCached', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns the cached payload without fetching when fresh and not forced', async () => {
    const cache = {
      fetchedAt: Date.now() - 60_000, // 1 min ago — well within 15min TTL
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 5 } },
    };
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
    // Pass an obviously-bad token: if we reach the network the test fails
    // with a network error rather than returning the cache. The cache is
    // fresh, so no fetch should happen.
    const result = await fetchUsageCached(dir, 'invalid-token');
    assert.deepStrictEqual(result, cache);
  });

  it('returns the cached payload when rateLimitedUntil is in the future', async () => {
    const cache = {
      fetchedAt: Date.now() - 60 * 60 * 1000, // 1 hour ago — past TTL
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 5 } },
      rateLimitedUntil: Date.now() + 5 * 60 * 1000, // still backed off
    };
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
    const result = await fetchUsageCached(dir, 'invalid-token');
    assert.deepStrictEqual(result, cache);
  });
});
