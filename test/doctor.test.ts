import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, type DoctorInput } from '../src/setup/doctor.js';

const NOW = 1_000_000_000_000;

function base(over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    activeAccount: 'a@x.com',
    snapshots: [],
    usage: [],
    keychainItemPresent: false,
    now: NOW,
    ...over,
  };
}

describe('diagnose', () => {
  it('reports ok with no findings on a healthy store', () => {
    const r = diagnose(base({
      snapshots: [
        { email: 'a@x.com', accountUuid: 'uuid-a', accessToken: 'tok-a', capturedFromAccountUuid: 'uuid-a' },
        { email: 'b@x.com', accountUuid: 'uuid-b', accessToken: 'tok-b', capturedFromAccountUuid: 'uuid-b' },
      ],
    }));
    assert.equal(r.status, 'ok');
    assert.equal(r.findings.length, 0);
    assert.equal(r.activeAccount, 'a@x.com');
  });

  it('flags a token collision (two snapshots share an accessToken) as error', () => {
    const r = diagnose(base({
      snapshots: [
        { email: 'a@x.com', accountUuid: 'uuid-a', accessToken: 'SHARED' },
        { email: 'b@x.com', accountUuid: 'uuid-b', accessToken: 'SHARED' },
      ],
    }));
    assert.equal(r.status, 'error');
    const f = r.findings.find(x => x.code === 'snapshot-token-collision');
    assert.ok(f);
    assert.equal(f.severity, 'error');
    assert.equal(f.fixable, true);
    // both emails named, sorted
    assert.match(f.message, /a@x\.com, b@x\.com/);
  });

  it('does NOT flag a collision when tokens differ', () => {
    const r = diagnose(base({
      snapshots: [
        { email: 'a@x.com', accessToken: 'tok-a' },
        { email: 'b@x.com', accessToken: 'tok-b' },
      ],
    }));
    assert.equal(r.findings.filter(f => f.code === 'snapshot-token-collision').length, 0);
  });

  it('ignores snapshots without a token in the collision check', () => {
    const r = diagnose(base({
      snapshots: [
        { email: 'a@x.com' }, // no token
        { email: 'b@x.com' }, // no token
      ],
    }));
    assert.equal(r.findings.length, 0);
  });

  it('flags a provenance mismatch as error', () => {
    const r = diagnose(base({
      snapshots: [
        { email: 'b@x.com', accountUuid: 'uuid-b', accessToken: 'tok-b', capturedFromAccountUuid: 'uuid-WRONG' },
      ],
    }));
    const f = r.findings.find(x => x.code === 'snapshot-provenance-mismatch');
    assert.ok(f);
    assert.equal(f.severity, 'error');
    assert.equal(f.fixable, true);
  });

  it('does NOT flag provenance when capturedFrom matches accountUuid', () => {
    const r = diagnose(base({
      snapshots: [
        { email: 'b@x.com', accountUuid: 'uuid-b', accessToken: 'tok-b', capturedFromAccountUuid: 'uuid-b' },
      ],
    }));
    assert.equal(r.findings.filter(f => f.code === 'snapshot-provenance-mismatch').length, 0);
  });

  it('flags a rate-limited usage cache as warn (self-healing)', () => {
    const r = diagnose(base({
      usage: [{ email: 'a@x.com', rateLimitedUntil: NOW + 5 * 60_000 }],
    }));
    const f = r.findings.find(x => x.code === 'usage-rate-limited');
    assert.ok(f);
    assert.equal(f.severity, 'warn');
    assert.equal(f.fixable, true);
    assert.match(f.message, /~5m/);
    assert.equal(r.status, 'warn');
  });

  it('does NOT flag a usage cache whose rate-limit has expired', () => {
    const r = diagnose(base({
      usage: [{ email: 'a@x.com', rateLimitedUntil: NOW - 1 }],
    }));
    assert.equal(r.findings.filter(f => f.code === 'usage-rate-limited').length, 0);
  });

  it('flags a present Keychain item as warn, not fixable (reconcile handles it)', () => {
    const r = diagnose(base({ keychainItemPresent: true }));
    const f = r.findings.find(x => x.code === 'keychain-item-present');
    assert.ok(f);
    assert.equal(f.severity, 'warn');
    assert.equal(f.fixable, false);
    assert.equal(r.keychainItemPresent, true);
  });

  it('status reflects the WORST finding (error beats warn)', () => {
    const r = diagnose(base({
      snapshots: [
        { email: 'a@x.com', accessToken: 'SHARED' },
        { email: 'b@x.com', accessToken: 'SHARED' },
      ],
      usage: [{ email: 'a@x.com', rateLimitedUntil: NOW + 60_000 }],
      keychainItemPresent: true,
    }));
    assert.equal(r.status, 'error'); // collision (error) wins over the two warns
    assert.ok(r.findings.length >= 3);
  });
});
