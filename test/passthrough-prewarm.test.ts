// test/passthrough-prewarm.test.ts
// Regression coverage for the "fresh usage before auto-engage" hop in
// `src/commands/passthrough.ts`. Without it, a long claude session
// that hits 100% mid-flight comes back to a stale cache on the next
// re-launch and auto-engage never fires — the user re-runs claude
// expecting the API-key fallback to kick in, hits the same wall, and
// concludes claude-switch is broken.
//
// We can't easily exercise the full passthrough handler from a unit
// test (it spawns claude). So this suite calls the predicates and
// helpers it composes — `isUsageCacheStale`, `fetchUsageCached`'s
// `force` semantics, and `getApiKey` — with stable inputs to lock
// down the contract that drives the pre-warm decision.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isUsageCacheStale,
  readUsageCache,
  type UsageCache,
} from '../src/usage.js';

let tmpDir: string;
let accDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prewarm-'));
  accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCache(payload: Partial<UsageCache>): void {
  const cache: UsageCache = {
    fetchedAt: payload.fetchedAt ?? Date.now(),
    account: payload.account ?? 'a@b.com',
    payload: payload.payload,
    rateLimitedUntil: payload.rateLimitedUntil,
  };
  fs.writeFileSync(path.join(accDir, '.usage-cache.json'), JSON.stringify(cache));
}

describe('isUsageCacheStale — pre-warm gate predicates', () => {
  it('null cache is stale (first-ever call qualifies for pre-warm)', () => {
    assert.equal(isUsageCacheStale(null, 'a@b.com'), true);
  });

  it('cache fetched seconds ago is fresh (skip pre-warm to keep cold-start fast)', () => {
    const cache = readUsageCache(accDir);
    assert.equal(cache, null);
    writeCache({
      fetchedAt: Date.now() - 5_000,
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
    });
    const fresh = readUsageCache(accDir);
    assert.equal(isUsageCacheStale(fresh, 'a@b.com'), false);
  });

  it('cache for a different account is stale (different quotas, refetch needed)', () => {
    writeCache({
      account: 'b@y.com',
      fetchedAt: Date.now(),
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
    });
    const cache = readUsageCache(accDir);
    assert.equal(isUsageCacheStale(cache, 'a@b.com'), true,
      'caller is on a@b.com — quota for b@y.com is irrelevant');
  });

  it('cache older than the statusline freshness window is stale', () => {
    // The freshness window is STATUSLINE_REFRESH_AFTER_MS (5 min,
    // was 10 min before) in src/usage.ts. 11 min ago is comfortably
    // past both values — robust to future ratchets without test churn.
    writeCache({
      fetchedAt: Date.now() - 11 * 60_000,
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
    });
    const cache = readUsageCache(accDir);
    assert.equal(isUsageCacheStale(cache, 'a@b.com'), true);
  });

  it('cache that recorded a rate-limit back-off is NOT stale (refetching makes it worse)', () => {
    writeCache({
      fetchedAt: Date.now() - 10 * 60_000,
      rateLimitedUntil: Date.now() + 5 * 60_000,
      payload: { five_hour: { utilization: 100 }, seven_day: { utilization: 50 } },
    });
    const cache = readUsageCache(accDir);
    assert.equal(isUsageCacheStale(cache, 'a@b.com'), false,
      'inside back-off the cache is the source of truth — no pre-warm');
  });
});

// NOTE: the second half of the contract — that fetchUsageCached with
// force=true actually hits the wire and lands a fresher cache — is
// covered indirectly by `usage.test.ts` (which uses https mocks) and
// by the manual smoke checklist in CONTRIBUTING.md. Re-mocking
// https.request here would duplicate that infra without adding signal.
