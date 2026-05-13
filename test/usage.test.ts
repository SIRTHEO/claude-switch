import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsageCache, readUsageCacheForAccount, fetchUsageCached, getAccessTokenFromKeychain, parseRetryAfter, readUsageCacheFor, isUsageCacheStale, shouldTriggerUsageRefreshAfterSwitch, triggerBackgroundUsageRefresh, parseUsageHeadersIfPresent, updateUsageCacheFromHeaders } from '../src/usage.js';
import { createHash } from 'node:crypto';

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

// ----- Phase 13.2 — per-account usage cache -----

describe('readUsageCacheForAccount — per-account hashed path', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-perc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Reproduce the path the implementation derives. If the production formula
  // ever changes, this helper is the canary that makes the divergence visible.
  const perAccountPath = (email: string): string => {
    const hash = createHash('sha256').update(email).digest('hex').slice(0, 16);
    return path.join(dir, `.usage-cache.${hash}.json`);
  };

  it('reads the per-account cache file when present', () => {
    const cache = {
      fetchedAt: Date.now(),
      account: 'first@x.com',
      payload: { five_hour: { utilization: 42 }, seven_day: { utilization: 10 } },
    };
    fs.writeFileSync(perAccountPath('first@x.com'), JSON.stringify(cache));
    const got = readUsageCacheForAccount(dir, 'first@x.com');
    assert.deepStrictEqual(got, cache);
  });

  it('returns null for a non-existent account even when another account has a cache', () => {
    fs.writeFileSync(perAccountPath('first@x.com'), JSON.stringify({
      fetchedAt: Date.now(),
      account: 'first@x.com',
      payload: { five_hour: { utilization: 99 }, seven_day: { utilization: 99 } },
    }));
    // Second account has no cache file → never leak the first account's quota.
    assert.strictEqual(readUsageCacheForAccount(dir, 'second@x.com'), null);
  });

  it('falls back to the legacy global cache when (a) per-account missing AND (b) legacy account field matches', () => {
    // Upgrade scenario: user had a cache from pre-13.2 (legacy global file).
    // First read for the matching account should pick it up so we don't
    // force an unnecessary re-fetch the first time after upgrade.
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify({
      fetchedAt: Date.now(),
      account: 'legacy@x.com',
      payload: { five_hour: { utilization: 55 }, seven_day: { utilization: 22 } },
    }));
    const got = readUsageCacheForAccount(dir, 'legacy@x.com');
    assert.ok(got);
    assert.strictEqual(got?.account, 'legacy@x.com');
    assert.strictEqual(got?.payload?.five_hour?.utilization, 55);
  });

  it('does NOT fall back to a legacy cache whose account differs from the request', () => {
    // Critical safety: legacy file belongs to A, but we're asking for B.
    // Returning A's cache for B would leak quota across accounts — must
    // refuse and return null.
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify({
      fetchedAt: Date.now(),
      account: 'a@x.com',
      payload: { five_hour: { utilization: 99 }, seven_day: { utilization: 99 } },
    }));
    assert.strictEqual(readUsageCacheForAccount(dir, 'b@x.com'), null);
  });

  it('prefers the per-account file over the legacy file when both exist', () => {
    // Mid-migration state: per-account has the fresh value, legacy is stale
    // from before the upgrade. Always prefer per-account — that's the post-
    // upgrade write path.
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify({
      fetchedAt: Date.now() - 60_000,
      account: 'pref@x.com',
      payload: { five_hour: { utilization: 10 }, seven_day: { utilization: 5 } },
    }));
    fs.writeFileSync(perAccountPath('pref@x.com'), JSON.stringify({
      fetchedAt: Date.now(),
      account: 'pref@x.com',
      payload: { five_hour: { utilization: 80 }, seven_day: { utilization: 40 } },
    }));
    const got = readUsageCacheForAccount(dir, 'pref@x.com');
    assert.strictEqual(got?.payload?.five_hour?.utilization, 80,
      'per-account file should win over legacy when both present');
  });
});

describe('shouldTriggerUsageRefreshAfterSwitch — Phase 13.3 predicate', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-trigger-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const perAccountPath = (email: string): string => {
    const hash = createHash('sha256').update(email).digest('hex').slice(0, 16);
    return path.join(dir, `.usage-cache.${hash}.json`);
  };

  it('returns true when no cache exists for the target account', () => {
    assert.strictEqual(shouldTriggerUsageRefreshAfterSwitch(dir, 'cold@x.com'), true);
  });

  it('returns false when the target account has a fresh cache', () => {
    fs.writeFileSync(perAccountPath('warm@x.com'), JSON.stringify({
      fetchedAt: Date.now(),
      account: 'warm@x.com',
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
    }));
    assert.strictEqual(shouldTriggerUsageRefreshAfterSwitch(dir, 'warm@x.com'), false);
  });

  it('returns true when the target account has a stale cache (>10 min old)', () => {
    fs.writeFileSync(perAccountPath('stale@x.com'), JSON.stringify({
      fetchedAt: Date.now() - 16 * 60 * 1000,
      account: 'stale@x.com',
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
    }));
    assert.strictEqual(shouldTriggerUsageRefreshAfterSwitch(dir, 'stale@x.com'), true);
  });

  it('returns true for account B when only account A has a fresh cache (A→B→A scenario)', () => {
    // Switch A→B: A's per-account cache exists, B's does not. After switch
    // to B, predicate must report stale (B has no cache yet) so the caller
    // triggers a background refresh. Crucially the predicate does NOT
    // consult A's cache for B's freshness.
    fs.writeFileSync(perAccountPath('a@x.com'), JSON.stringify({
      fetchedAt: Date.now(),
      account: 'a@x.com',
      payload: { five_hour: { utilization: 30 }, seven_day: { utilization: 10 } },
    }));
    assert.strictEqual(shouldTriggerUsageRefreshAfterSwitch(dir, 'b@x.com'), true);
  });
});

// ----- Phase 13.4 — realtime push from response headers -----

describe('parseUsageHeadersIfPresent', () => {
  it('returns null when neither header is present', () => {
    assert.strictEqual(parseUsageHeadersIfPresent({}), null);
    assert.strictEqual(parseUsageHeadersIfPresent({ 'content-type': 'application/json' }), null);
  });

  it('parses five-hour percent header (canonical name)', () => {
    const got = parseUsageHeadersIfPresent({
      'anthropic-ratelimit-five-hour-percent-used': '42',
    });
    assert.deepStrictEqual(got, { fiveHourPct: 42, sevenDayPct: undefined });
  });

  it('parses seven-day percent header (canonical name)', () => {
    const got = parseUsageHeadersIfPresent({
      'anthropic-ratelimit-seven-day-percent-used': '15.5',
    });
    assert.deepStrictEqual(got, { fiveHourPct: undefined, sevenDayPct: 15.5 });
  });

  it('parses both headers together', () => {
    const got = parseUsageHeadersIfPresent({
      'anthropic-ratelimit-five-hour-percent-used': '80',
      'anthropic-ratelimit-seven-day-percent-used': '35',
    });
    assert.deepStrictEqual(got, { fiveHourPct: 80, sevenDayPct: 35 });
  });

  it('accepts the priority-* alias header names', () => {
    // Defensive: header naming convention might evolve. We probe multiple
    // candidates so a rename doesn't silently kill the feature.
    const got = parseUsageHeadersIfPresent({
      'anthropic-priority-five-hour-percent-used': '12',
      'anthropic-priority-seven-day-percent-used': '7',
    });
    assert.deepStrictEqual(got, { fiveHourPct: 12, sevenDayPct: 7 });
  });

  it('strips trailing % sign', () => {
    const got = parseUsageHeadersIfPresent({
      'anthropic-ratelimit-five-hour-percent-used': '67%',
    });
    assert.strictEqual(got?.fiveHourPct, 67);
  });

  it('rejects out-of-range and non-numeric values', () => {
    assert.strictEqual(parseUsageHeadersIfPresent({
      'anthropic-ratelimit-five-hour-percent-used': '150',
    }), null);
    assert.strictEqual(parseUsageHeadersIfPresent({
      'anthropic-ratelimit-five-hour-percent-used': 'not-a-number',
    }), null);
    assert.strictEqual(parseUsageHeadersIfPresent({
      'anthropic-ratelimit-five-hour-percent-used': '-5',
    }), null);
  });

  it('handles array-valued headers (Node passes them this way for repeats)', () => {
    const got = parseUsageHeadersIfPresent({
      'anthropic-ratelimit-five-hour-percent-used': ['42', '50'],
    });
    // First value wins — Node delivers headers in order.
    assert.strictEqual(got?.fiveHourPct, 42);
  });
});

describe('updateUsageCacheFromHeaders', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-usage-hdr-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const perAccountPath = (email: string): string => {
    const hash = createHash('sha256').update(email).digest('hex').slice(0, 16);
    return path.join(dir, `.usage-cache.${hash}.json`);
  };

  it('writes a fresh cache entry when both percentages are provided', () => {
    updateUsageCacheFromHeaders(dir, 'new@x.com', 42, 18);
    const cache = readUsageCacheForAccount(dir, 'new@x.com');
    assert.strictEqual(cache?.account, 'new@x.com');
    assert.strictEqual(cache?.payload?.five_hour?.utilization, 42);
    assert.strictEqual(cache?.payload?.seven_day?.utilization, 18);
  });

  it('preserves the prior seven-day value when only five-hour is observed', () => {
    // Pre-condition: cache already has both windows. New observation only
    // includes the 5h header (e.g. proxy intercepted a response that
    // happened to include only that header).
    fs.writeFileSync(perAccountPath('warm@x.com'), JSON.stringify({
      fetchedAt: Date.now() - 60_000,
      account: 'warm@x.com',
      payload: {
        five_hour: { utilization: 30 },
        seven_day: { utilization: 12, resets_at: '2026-05-20T00:00:00Z' },
      },
    }));
    updateUsageCacheFromHeaders(dir, 'warm@x.com', 55, undefined);
    const cache = readUsageCacheForAccount(dir, 'warm@x.com');
    assert.strictEqual(cache?.payload?.five_hour?.utilization, 55, '5h updated');
    assert.strictEqual(cache?.payload?.seven_day?.utilization, 12, '7d preserved from prior cache');
  });

  it('preserves an active rate-limit back-off across header updates', () => {
    // Headers reflect subscription quota. A 429 back-off lives on a
    // separate dimension (request rate) and must survive a header-driven
    // refresh.
    const future = Date.now() + 5 * 60 * 1000;
    fs.writeFileSync(perAccountPath('rl@x.com'), JSON.stringify({
      fetchedAt: Date.now() - 10_000,
      account: 'rl@x.com',
      rateLimitedUntil: future,
      payload: { five_hour: { utilization: 0 }, seven_day: { utilization: 0 } },
    }));
    updateUsageCacheFromHeaders(dir, 'rl@x.com', 88, 22);
    const cache = readUsageCacheForAccount(dir, 'rl@x.com');
    assert.strictEqual(cache?.rateLimitedUntil, future);
  });

  it('is a no-op when both inputs are undefined', () => {
    updateUsageCacheFromHeaders(dir, 'none@x.com', undefined, undefined);
    assert.strictEqual(readUsageCacheForAccount(dir, 'none@x.com'), null,
      'no cache file should be created');
  });

  it('is a no-op when email is empty (defensive — never write a global file)', () => {
    updateUsageCacheFromHeaders(dir, '', 50, 20);
    // No per-account file (we have no email to derive the path from)
    assert.strictEqual(readUsageCacheForAccount(dir, 'placeholder@x.com'), null);
  });
});
