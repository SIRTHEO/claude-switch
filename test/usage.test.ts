import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsageCache, fetchUsageCached, getAccessTokenFromKeychain, parseRetryAfter, readUsageCacheFor, isUsageCacheStale, triggerBackgroundUsageRefresh } from '../src/usage.js';

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

  it('does not return a pre-account-aware cache when caller specifies an account', async () => {
    // Cache without `account` field — could belong to anyone. Still fresh
    // and within rate-limit, but caller is asking about a specific account,
    // so we must not return numbers that might belong to a different one.
    const cache = {
      fetchedAt: Date.now() - 60_000,
      payload: { five_hour: { utilization: 99 }, seven_day: { utilization: 99 } },
      rateLimitedUntil: Date.now() + 5 * 60 * 1000,
    };
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
    // Passing an account triggers the cross-account safety: we should not
    // return the cache since we can't prove it belongs to this account.
    // We use rateLimitedUntil to short-circuit before any real fetch.
    const result = await fetchUsageCached(dir, 'invalid-token', { account: 'me@x.com' });
    // Different result: payload is stripped because cache.account didn't match
    assert.notDeepStrictEqual(result, cache);
    assert.strictEqual(result.payload, undefined);
  });
});

describe('parseRetryAfter', () => {
  it('parses a numeric value as seconds', () => {
    assert.strictEqual(parseRetryAfter('120'), 120);
  });

  it('treats "0" as 0 (retry now), NOT as the 300s default', () => {
    assert.strictEqual(parseRetryAfter('0'), 0);
  });

  it('defaults to 300s when header is missing', () => {
    assert.strictEqual(parseRetryAfter(undefined), 300);
  });

  it('defaults to 300s when header is unparseable', () => {
    assert.strictEqual(parseRetryAfter('garbage'), 300);
  });

  it('defaults to 300s on negative values', () => {
    assert.strictEqual(parseRetryAfter('-5'), 300);
  });

  it('takes the first value when given an array', () => {
    assert.strictEqual(parseRetryAfter(['90', '60']), 90);
  });
});

describe('getAccessTokenFromKeychain — Linux/Windows fallback', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-token-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads accessToken from claude.json on non-darwin platforms', { skip: process.platform === 'darwin' }, () => {
    const claudeJson = path.join(dir, 'claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'me@x.com', accessToken: 'sk-test-123' },
    }));
    assert.strictEqual(getAccessTokenFromKeychain(claudeJson), 'sk-test-123');
  });

  it('returns null on non-darwin when claude.json is missing', { skip: process.platform === 'darwin' }, () => {
    assert.strictEqual(getAccessTokenFromKeychain(path.join(dir, 'nope.json')), null);
  });

  it('returns null on non-darwin when claude.json has no accessToken', { skip: process.platform === 'darwin' }, () => {
    const claudeJson = path.join(dir, 'claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }));
    assert.strictEqual(getAccessTokenFromKeychain(claudeJson), null);
  });
});

describe('readUsageCacheFor — strict per-account safety', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-for-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const writeCache = (cache: object): void => {
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
  };

  it('returns the cache when account matches', () => {
    const cache = {
      fetchedAt: Date.now(),
      account: 'me@x.com',
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
    };
    writeCache(cache);
    assert.deepStrictEqual(readUsageCacheFor(dir, 'me@x.com'), cache);
  });

  it('returns null when cache is for a different account', () => {
    writeCache({
      fetchedAt: Date.now(),
      account: 'someone-else@x.com',
      payload: { five_hour: { utilization: 99 }, seven_day: { utilization: 99 } },
    });
    // Critical safety guarantee: never leak A's quota numbers to B.
    assert.strictEqual(readUsageCacheFor(dir, 'me@x.com'), null);
  });

  it('returns null for a pre-account-aware cache (no account field)', () => {
    // Old cache format from before per-account isolation. We can't tell who
    // it belongs to, so refuse to display it.
    writeCache({
      fetchedAt: Date.now(),
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
    });
    assert.strictEqual(readUsageCacheFor(dir, 'me@x.com'), null);
  });

  it('returns null when no cache file exists', () => {
    assert.strictEqual(readUsageCacheFor(dir, 'me@x.com'), null);
  });
});

describe('isUsageCacheStale', () => {
  const fresh = Date.now();
  const oldOver15min = Date.now() - 16 * 60 * 1000;

  it('returns true when cache is null', () => {
    assert.strictEqual(isUsageCacheStale(null), true);
  });

  it('returns true when cache has no payload', () => {
    assert.strictEqual(
      isUsageCacheStale({ fetchedAt: fresh, account: 'me@x.com' }),
      true,
    );
  });

  it('returns false while a rate-limit back-off is still in effect', () => {
    // Even an old/missing-payload cache must not be flagged stale during
    // a 429 window — refreshing into a 429 only extends the back-off.
    assert.strictEqual(
      isUsageCacheStale({
        fetchedAt: oldOver15min,
        account: 'me@x.com',
        rateLimitedUntil: Date.now() + 60_000,
      }),
      false,
    );
  });

  it('returns true when cache belongs to a different account', () => {
    assert.strictEqual(
      isUsageCacheStale({
        fetchedAt: fresh,
        account: 'someone-else@x.com',
        payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
      }, 'me@x.com'),
      true,
    );
  });

  it('returns false when cache is fresh and account matches', () => {
    assert.strictEqual(
      isUsageCacheStale({
        fetchedAt: fresh,
        account: 'me@x.com',
        payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
      }, 'me@x.com'),
      false,
    );
  });

  it('returns true when cache is older than the statusline refresh threshold', () => {
    assert.strictEqual(
      isUsageCacheStale({
        fetchedAt: oldOver15min,
        account: 'me@x.com',
        payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
      }, 'me@x.com'),
      true,
    );
  });
});

describe('fetchUsageCached — additional edge cases', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-edge-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('rate-limit short-circuit beats a same-account cache mismatch with caller account', async () => {
    // Cache has account=me@x.com, rate-limited; caller asks for me@x.com.
    // The 199 branch (rateLimitedUntil + sameAccount) returns immediately.
    const cache = {
      fetchedAt: Date.now() - 60_000,
      account: 'me@x.com',
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 5 } },
      rateLimitedUntil: Date.now() + 60_000,
    };
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
    const result = await fetchUsageCached(dir, 'invalid-token', { account: 'me@x.com' });
    assert.deepStrictEqual(result, cache);
  });

  it('does NOT short-circuit on rate-limit when account mismatches', async () => {
    // Different account → must refetch with the new account context, even
    // though the cache is rate-limited. We pass an obviously-invalid token,
    // so the network attempt fails and we land in the !ok && !rateLimited
    // branch which preserves fetchedAt only when sameAccount.
    const cache = {
      fetchedAt: Date.now() - 60_000,
      account: 'other@x.com',
      payload: { five_hour: { utilization: 99 }, seven_day: { utilization: 99 } },
      rateLimitedUntil: Date.now() + 60_000,
    };
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
    const result = await fetchUsageCached(dir, 'invalid-token', { account: 'me@x.com' });
    // Different account → cache.payload must be dropped on refetch.
    assert.strictEqual(result.payload, undefined);
    assert.strictEqual(result.account, 'me@x.com');
  });
});

describe('triggerBackgroundUsageRefresh', () => {
  it('does not throw and returns synchronously', () => {
    // We can't easily verify the spawned process actually runs (it would
    // call back into the CLI), but we can verify the wrapper doesn't crash
    // and returns void without awaiting anything. The spawn is detached
    // and unref'd, so the test process can exit normally.
    let returned = false;
    try {
      triggerBackgroundUsageRefresh();
      returned = true;
    } catch {
      // The function swallows errors internally — should never throw.
    }
    assert.strictEqual(returned, true);
  });
});
