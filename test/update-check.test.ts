import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNewer, detectInstallCommand, checkForUpdate, writeUpdateCache } from '../src/update-check.js';
import { setFakeHome, restoreFakeHome } from './_helpers/fake-home.js';

describe('isNewer', () => {
  it('returns true when latest is a higher patch', () => {
    assert.strictEqual(isNewer('2.3.0', '2.3.1'), true);
  });

  it('returns true when latest is a higher minor', () => {
    assert.strictEqual(isNewer('2.3.0', '2.4.0'), true);
  });

  it('returns true when latest is a higher major', () => {
    assert.strictEqual(isNewer('2.3.0', '3.0.0'), true);
  });

  it('returns false when versions are equal', () => {
    assert.strictEqual(isNewer('2.3.0', '2.3.0'), false);
  });

  it('returns false when latest is older', () => {
    assert.strictEqual(isNewer('2.3.0', '2.2.9'), false);
  });

  it('strips leading "v" from both arguments', () => {
    assert.strictEqual(isNewer('v2.3.0', 'v2.4.0'), true);
  });

  it('returns false when latest is a pre-release of a higher version', () => {
    // Stable users should not be auto-bumped to a pre-release.
    assert.strictEqual(isNewer('2.3.0', '2.4.0-rc.1'), false);
    assert.strictEqual(isNewer('2.3.0', '3.0.0-beta'), false);
  });

  it('returns false when latest is a pre-release of the same version', () => {
    assert.strictEqual(isNewer('2.3.0', '2.3.0-beta.1'), false);
  });

  it('returns true when current is a pre-release and latest is the stable release', () => {
    // Per semver: 2.3.0-rc.1 < 2.3.0. Users on a pre-release should be
    // notified when the matching stable lands.
    assert.strictEqual(isNewer('2.3.0-rc.1', '2.3.0'), true);
    assert.strictEqual(isNewer('2.3.0-rc.1', '2.4.0'), true);
  });

  it('does not propose another pre-release of the same base version', () => {
    assert.strictEqual(isNewer('2.3.0-rc.1', '2.3.0-rc.2'), false);
  });

  it('treats missing patch component as 0', () => {
    assert.strictEqual(isNewer('2.3', '2.3.1'), true);
    assert.strictEqual(isNewer('2.3.0', '2.3'), false);
  });
});

describe('checkForUpdate / writeUpdateCache — type guard coverage', () => {
  // The type guards (isCheckCacheShaped, extractVersion) are private, but
  // they're exercised by checkForUpdate which reads the cache file at a fixed
  // path.  We use a temp HOME to isolate from the real cache.
  function withTempHome(fn: (home: string) => void): void {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    const saved = setFakeHome(tmp);
    try {
      fn(tmp);
    } finally {
      restoreFakeHome(saved);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('returns null when no cache file exists (isCheckCacheShaped: null path)', () => {
    withTempHome(() => {
      const result = checkForUpdate('1.0.0');
      assert.strictEqual(result, null);
    });
  });

  it('returns null when cache JSON is malformed (isCheckCacheShaped: invalid JSON)', () => {
    withTempHome((home) => {
      const p = path.join(home, '.claude', 'accounts', '.update-check.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'not-json');
      const result = checkForUpdate('1.0.0');
      assert.strictEqual(result, null);
    });
  });

  it('returns null when cache is missing checkedAt (isCheckCacheShaped: wrong shape)', () => {
    withTempHome((home) => {
      const p = path.join(home, '.claude', 'accounts', '.update-check.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ latestVersion: '9.9.9' }));
      const result = checkForUpdate('1.0.0');
      assert.strictEqual(result, null); // stale cache, no update info returned without valid checkedAt
    });
  });

  it('writeUpdateCache + checkForUpdate round-trip (happy path)', () => {
    withTempHome(() => {
      writeUpdateCache('9.9.9');
      const result = checkForUpdate('1.0.0');
      assert.ok(result !== null, 'expected an update to be detected');
      assert.strictEqual(result.latestVersion, '9.9.9');
    });
  });
});

describe('detectInstallCommand', () => {
  it('returns a non-empty argv for the running process', () => {
    // We can't fully isolate the function (it reads import.meta.url), but
    // we can at least assert the contract: never empty, first arg is a known
    // package manager, package name is the last argument.
    const cmd = detectInstallCommand();
    assert.ok(cmd.length >= 2, 'expected at least cmd + package name');
    assert.match(cmd[0]!, /^(npm|pnpm|yarn|volta)$/);
    assert.strictEqual(cmd[cmd.length - 1], '@sirtheo/claude-switch');
  });
});
