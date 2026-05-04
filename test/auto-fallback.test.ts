import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getAutoFallbackConfig,
  setAutoFallbackConfig,
  maybeAutoDisableFallback,
  maybeAutoEngageFallback,
} from '../src/auto-fallback.js';
import { setFallbackEnabled, isFallbackEnabled } from '../src/fallback.js';

describe('auto-fallback config', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-auto-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const DEFAULT_CONFIG = {
    enabled: false,
    threshold: 80,
    engageEnabled: false,
    engageThreshold: 95,
  } as const;

  it('returns default config when missing', () => {
    assert.deepStrictEqual(getAutoFallbackConfig(dir), DEFAULT_CONFIG);
  });

  it('returns default on malformed JSON', () => {
    fs.writeFileSync(path.join(dir, '.auto-fallback.json'), 'garbage');
    assert.deepStrictEqual(getAutoFallbackConfig(dir), DEFAULT_CONFIG);
  });

  it('clamps low out-of-range thresholds via setAutoFallbackConfig', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 0 });
    assert.strictEqual(getAutoFallbackConfig(dir).threshold, 1);
    setAutoFallbackConfig(dir, { threshold: -5 });
    assert.strictEqual(getAutoFallbackConfig(dir).threshold, 1);
  });

  it('clamps high out-of-range thresholds when read from disk', () => {
    // Combined check: range clamp [1,100] AND the read-time invariant
    // engageThreshold > threshold. With threshold clamped to 100, the
    // invariant lifts engageThreshold to min(100, 100+1) = 100; the
    // resulting auto-engage effectively never fires, which is the safe
    // degenerate behaviour for a misconfigured file.
    fs.writeFileSync(
      path.join(dir, '.auto-fallback.json'),
      JSON.stringify({ enabled: true, threshold: 999, engageEnabled: false, engageThreshold: -3 }),
    );
    const cfg = getAutoFallbackConfig(dir);
    assert.strictEqual(cfg.threshold, 100);
    assert.strictEqual(cfg.engageThreshold, 100);
  });

  it('honors a healthy engageThreshold from disk without bumping it', () => {
    // Direct test that the invariant clamp does NOT mutate well-formed
    // configs: range-clamp brings -3 → 1 and 50 stays 50, then 50 > 1
    // already so no further bump is needed.
    fs.writeFileSync(
      path.join(dir, '.auto-fallback.json'),
      JSON.stringify({ threshold: -3, engageThreshold: 50 }),
    );
    const cfg = getAutoFallbackConfig(dir);
    assert.strictEqual(cfg.threshold, 1);
    assert.strictEqual(cfg.engageThreshold, 50);
  });

  it('rejects updates that violate engageThreshold > threshold invariant', () => {
    setAutoFallbackConfig(dir, { threshold: 80, engageThreshold: 95 });
    assert.throws(
      () => setAutoFallbackConfig(dir, { threshold: 95 }),
      /engageThreshold .* must be strictly greater/,
    );
  });

  it('preserves the unset half of a partial update', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 60 });
    setAutoFallbackConfig(dir, { threshold: 50 });
    assert.deepStrictEqual(getAutoFallbackConfig(dir), {
      enabled: true,
      threshold: 50,
      engageEnabled: false,
      engageThreshold: 95,
    });
    setAutoFallbackConfig(dir, { enabled: false });
    assert.deepStrictEqual(getAutoFallbackConfig(dir), {
      enabled: false,
      threshold: 50,
      engageEnabled: false,
      engageThreshold: 95,
    });
  });

  it('clamps engageThreshold above threshold when reading legacy configs', () => {
    // Pre-2.7.x file shape: only `enabled` + `threshold`, no engage fields.
    // Default engageThreshold (95) would violate invariant if user had
    // threshold:99 before upgrade.
    fs.writeFileSync(
      path.join(dir, '.auto-fallback.json'),
      JSON.stringify({ enabled: true, threshold: 99 }),
    );
    const cfg = getAutoFallbackConfig(dir);
    assert.strictEqual(cfg.threshold, 99);
    assert.ok(cfg.engageThreshold > cfg.threshold,
      `expected engageThreshold > threshold, got ${cfg.engageThreshold} <= ${cfg.threshold}`);
    assert.strictEqual(cfg.engageThreshold, 100);
  });

  it('persists engage* fields independently', () => {
    setAutoFallbackConfig(dir, { engageEnabled: true, engageThreshold: 90 });
    const cfg = getAutoFallbackConfig(dir);
    assert.strictEqual(cfg.engageEnabled, true);
    assert.strictEqual(cfg.engageThreshold, 90);
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.threshold, 80);
  });

  it('writes config file with mode 0600 on unix', { skip: process.platform === 'win32' }, () => {
    setAutoFallbackConfig(dir, { enabled: true });
    const stat = fs.statSync(path.join(dir, '.auto-fallback.json'));
    assert.strictEqual(stat.mode & 0o777, 0o600);
  });
});

describe('maybeAutoDisableFallback', () => {
  let dir: string;
  let claudeJson: string;
  const writeUsage = (cache: object): void => {
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
  };
  const writeAccount = (email: string): void => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-auto-disable-'));
    claudeJson = path.join(dir, 'claude.json');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('does nothing when smart-switch is off', () => {
    setFallbackEnabled(dir, true);
    writeAccount('me@x.com');
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 1 }, seven_day: { utilization: 1 },
    }});
    const result = maybeAutoDisableFallback(dir, claudeJson);
    assert.strictEqual(result.disabled, false);
    assert.strictEqual(isFallbackEnabled(dir), true);
  });

  it('does nothing when fallback is already off', () => {
    setAutoFallbackConfig(dir, { enabled: true });
    writeAccount('me@x.com');
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 1 }, seven_day: { utilization: 1 },
    }});
    const result = maybeAutoDisableFallback(dir, claudeJson);
    assert.strictEqual(result.disabled, false);
  });

  it('disables fallback when both 5h and 7d are below threshold', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 80 });
    setFallbackEnabled(dir, true);
    writeAccount('me@x.com');
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 30 }, seven_day: { utilization: 50 },
    }});
    const result = maybeAutoDisableFallback(dir, claudeJson);
    assert.strictEqual(result.disabled, true);
    assert.strictEqual(result.fivePct, 30);
    assert.strictEqual(result.sevenPct, 50);
    assert.strictEqual(isFallbackEnabled(dir), false);
  });

  it('does not disable when 5h is below but 7d is above threshold', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 80 });
    setFallbackEnabled(dir, true);
    writeAccount('me@x.com');
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 10 }, seven_day: { utilization: 95 },
    }});
    const result = maybeAutoDisableFallback(dir, claudeJson);
    assert.strictEqual(result.disabled, false);
    assert.strictEqual(isFallbackEnabled(dir), true);
  });

  it('does NOT disable when 7d is missing — wait for a complete cache', () => {
    // If 7d is absent we can't guarantee the user won't immediately hit
    // the weekly cap, so we hold fallback ON until both windows are known.
    setAutoFallbackConfig(dir, { enabled: true, threshold: 80 });
    setFallbackEnabled(dir, true);
    writeAccount('me@x.com');
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 10 },
    }});
    const result = maybeAutoDisableFallback(dir, claudeJson);
    assert.strictEqual(result.disabled, false);
    assert.strictEqual(isFallbackEnabled(dir), true);
  });

  it('does not disable when in a 429 backoff window', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 80 });
    setFallbackEnabled(dir, true);
    writeAccount('me@x.com');
    writeUsage({
      fetchedAt: Date.now(),
      account: 'me@x.com',
      rateLimitedUntil: Date.now() + 60_000,
      payload: { five_hour: { utilization: 1 }, seven_day: { utilization: 1 } },
    });
    const result = maybeAutoDisableFallback(dir, claudeJson);
    assert.strictEqual(result.disabled, false);
  });

  it('does not disable when cache is for a different account', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 80 });
    setFallbackEnabled(dir, true);
    writeAccount('me@x.com');
    writeUsage({ fetchedAt: Date.now(), account: 'someone-else@x.com', payload: {
      five_hour: { utilization: 1 }, seven_day: { utilization: 1 },
    }});
    const result = maybeAutoDisableFallback(dir, claudeJson);
    assert.strictEqual(result.disabled, false);
  });

  it('boundary: exactly at threshold does NOT trigger (strict <)', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 80 });
    setFallbackEnabled(dir, true);
    writeAccount('me@x.com');
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 80 }, seven_day: { utilization: 50 },
    }});
    const result = maybeAutoDisableFallback(dir, claudeJson);
    assert.strictEqual(result.disabled, false);
  });
});

describe('maybeAutoEngageFallback', () => {
  let dir: string;
  let claudeJson: string;
  const writeUsage = (cache: object): void => {
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), JSON.stringify(cache));
  };
  const writeAccount = (email: string): void => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-auto-engage-'));
    claudeJson = path.join(dir, 'claude.json');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('does nothing when auto-engage is off', () => {
    writeAccount('me@x.com');
    fs.writeFileSync(path.join(dir, 'me@x.com.json'), JSON.stringify({ _apiKey: 'sk-test-1' }));
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 99 }, seven_day: { utilization: 50 },
    }});
    const result = maybeAutoEngageFallback(dir, claudeJson);
    assert.strictEqual(result.engaged, false);
    assert.strictEqual(isFallbackEnabled(dir), false);
  });

  it('does nothing when fallback is already on', () => {
    setAutoFallbackConfig(dir, { engageEnabled: true });
    setFallbackEnabled(dir, true);
    writeAccount('me@x.com');
    fs.writeFileSync(path.join(dir, 'me@x.com.json'), JSON.stringify({ _apiKey: 'sk-test-1' }));
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 99 }, seven_day: { utilization: 50 },
    }});
    const result = maybeAutoEngageFallback(dir, claudeJson);
    assert.strictEqual(result.engaged, false);
  });

  it('engages on 5h crossing threshold (single window suffices)', () => {
    setAutoFallbackConfig(dir, { engageEnabled: true, engageThreshold: 95 });
    writeAccount('me@x.com');
    fs.writeFileSync(path.join(dir, 'me@x.com.json'), JSON.stringify({ _apiKey: 'sk-test-1' }));
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 96 }, seven_day: { utilization: 10 },
    }});
    const result = maybeAutoEngageFallback(dir, claudeJson);
    assert.strictEqual(result.engaged, true);
    assert.strictEqual(result.reason, '5h');
    assert.strictEqual(result.fivePct, 96);
    assert.strictEqual(isFallbackEnabled(dir), true);
  });

  it('engages on 7d crossing threshold even if 5h is low', () => {
    setAutoFallbackConfig(dir, { engageEnabled: true, engageThreshold: 95 });
    writeAccount('me@x.com');
    fs.writeFileSync(path.join(dir, 'me@x.com.json'), JSON.stringify({ _apiKey: 'sk-test-1' }));
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 10 }, seven_day: { utilization: 97 },
    }});
    const result = maybeAutoEngageFallback(dir, claudeJson);
    assert.strictEqual(result.engaged, true);
    assert.strictEqual(result.reason, '7d');
    assert.strictEqual(isFallbackEnabled(dir), true);
  });

  it('blocks when active account has no API key', () => {
    setAutoFallbackConfig(dir, { engageEnabled: true, engageThreshold: 95 });
    writeAccount('me@x.com');
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 99 }, seven_day: { utilization: 50 },
    }});
    const result = maybeAutoEngageFallback(dir, claudeJson);
    assert.strictEqual(result.engaged, false);
    assert.match(result.blocked ?? '', /no API key/);
    assert.strictEqual(isFallbackEnabled(dir), false);
  });

  it('does not engage in a 429 backoff window', () => {
    setAutoFallbackConfig(dir, { engageEnabled: true, engageThreshold: 95 });
    writeAccount('me@x.com');
    fs.writeFileSync(path.join(dir, 'me@x.com.json'), JSON.stringify({ _apiKey: 'sk-test-1' }));
    writeUsage({
      fetchedAt: Date.now(),
      account: 'me@x.com',
      rateLimitedUntil: Date.now() + 60_000,
      payload: { five_hour: { utilization: 99 }, seven_day: { utilization: 50 } },
    });
    const result = maybeAutoEngageFallback(dir, claudeJson);
    assert.strictEqual(result.engaged, false);
  });

  it('boundary: exactly at threshold DOES trigger (>=)', () => {
    setAutoFallbackConfig(dir, { engageEnabled: true, engageThreshold: 95 });
    writeAccount('me@x.com');
    fs.writeFileSync(path.join(dir, 'me@x.com.json'), JSON.stringify({ _apiKey: 'sk-test-1' }));
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 95 }, seven_day: { utilization: 10 },
    }});
    const result = maybeAutoEngageFallback(dir, claudeJson);
    assert.strictEqual(result.engaged, true);
    assert.strictEqual(result.reason, '5h');
  });

  it('does not engage when below threshold', () => {
    setAutoFallbackConfig(dir, { engageEnabled: true, engageThreshold: 95 });
    writeAccount('me@x.com');
    fs.writeFileSync(path.join(dir, 'me@x.com.json'), JSON.stringify({ _apiKey: 'sk-test-1' }));
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 90 }, seven_day: { utilization: 80 },
    }});
    const result = maybeAutoEngageFallback(dir, claudeJson);
    assert.strictEqual(result.engaged, false);
    assert.strictEqual(isFallbackEnabled(dir), false);
  });
});
