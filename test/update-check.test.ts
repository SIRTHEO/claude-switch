import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isNewer, detectInstallCommand } from '../src/update-check.js';

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
