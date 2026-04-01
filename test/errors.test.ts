import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExitError } from '../src/errors.js';

describe('ExitError', () => {
  it('creates with message and default code 1', () => {
    const err = new ExitError('test');
    assert.equal(err.message, 'test');
    assert.equal(err.code, 1);
    assert.equal(err.name, 'ExitError');
    assert.ok(err instanceof Error);
  });

  it('accepts custom exit code', () => {
    const err = new ExitError('test', 2);
    assert.equal(err.code, 2);
  });
});
