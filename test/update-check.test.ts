import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isNewer } from '../src/update-check.js';

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
    assert.strictEqual(isNewer('2.3.0-rc.1', '2.3.0'), false); // same base — not newer
    assert.strictEqual(isNewer('2.3.0-rc.1', '2.4.0'), true);
  });

  it('treats missing patch component as 0', () => {
    assert.strictEqual(isNewer('2.3', '2.3.1'), true);
    assert.strictEqual(isNewer('2.3.0', '2.3'), false);
  });
});
