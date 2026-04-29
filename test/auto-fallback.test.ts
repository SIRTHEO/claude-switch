import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getAutoFallbackConfig,
  setAutoFallbackConfig,
  maybeAutoDisableFallback,
} from '../src/auto-fallback.js';
import { setFallbackEnabled, isFallbackEnabled } from '../src/fallback.js';

describe('auto-fallback config', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-auto-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns default { enabled: false, threshold: 80 } when missing', () => {
    assert.deepStrictEqual(getAutoFallbackConfig(dir), { enabled: false, threshold: 80 });
  });

  it('returns default on malformed JSON', () => {
    fs.writeFileSync(path.join(dir, '.auto-fallback.json'), 'garbage');
    assert.deepStrictEqual(getAutoFallbackConfig(dir), { enabled: false, threshold: 80 });
  });

  it('clamps out-of-range thresholds to [1, 100]', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 0 });
    assert.strictEqual(getAutoFallbackConfig(dir).threshold, 1);
    setAutoFallbackConfig(dir, { threshold: 999 });
    assert.strictEqual(getAutoFallbackConfig(dir).threshold, 100);
    setAutoFallbackConfig(dir, { threshold: -5 });
    assert.strictEqual(getAutoFallbackConfig(dir).threshold, 1);
  });

  it('preserves the unset half of a partial update', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 60 });
    setAutoFallbackConfig(dir, { threshold: 50 });
    assert.deepStrictEqual(getAutoFallbackConfig(dir), { enabled: true, threshold: 50 });
    setAutoFallbackConfig(dir, { enabled: false });
    assert.deepStrictEqual(getAutoFallbackConfig(dir), { enabled: false, threshold: 50 });
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

  it('disables when 7d is missing and 5h is below threshold', () => {
    setAutoFallbackConfig(dir, { enabled: true, threshold: 80 });
    setFallbackEnabled(dir, true);
    writeAccount('me@x.com');
    writeUsage({ fetchedAt: Date.now(), account: 'me@x.com', payload: {
      five_hour: { utilization: 10 },
    }});
    const result = maybeAutoDisableFallback(dir, claudeJson);
    assert.strictEqual(result.disabled, true);
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
