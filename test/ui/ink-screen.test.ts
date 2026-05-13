// test/ui/ink-screen.test.ts
// Unit tests for awaitInkScreen helper.
//
// Tests two invariants:
//   (a) happy path: getResult is called after waitUntilExit resolves, and its
//       return value is the resolved value of the promise.
//   (b) reject path: the helper rejects with the same error, and getResult is
//       NOT called (so stale state is never returned on failure).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { awaitInkScreen } from '../../src/ui/utils/ink-screen.js';

describe('awaitInkScreen', () => {
  it('resolves with getResult return value on successful exit', async () => {
    const instance = {
      waitUntilExit: () => Promise.resolve(),
    };
    const result = await awaitInkScreen(instance, () => 'hello');
    assert.strictEqual(result, 'hello');
  });

  it('calls getResult exactly once on successful exit', async () => {
    const instance = {
      waitUntilExit: () => Promise.resolve(),
    };
    let callCount = 0;
    await awaitInkScreen(instance, () => {
      callCount++;
      return 42;
    });
    assert.strictEqual(callCount, 1);
  });

  it('rejects with the same error when waitUntilExit rejects', async () => {
    const err = new Error('ink internal failure');
    const instance = {
      waitUntilExit: () => Promise.reject(err),
    };
    await assert.rejects(
      () => awaitInkScreen(instance, () => 'should not be called'),
      (thrown: unknown) => thrown === err,
    );
  });

  it('does NOT call getResult when waitUntilExit rejects', async () => {
    const err = new Error('ink rejection');
    const instance = {
      waitUntilExit: () => Promise.reject(err),
    };
    let getResultCalled = false;
    await assert.rejects(
      () =>
        awaitInkScreen(instance, () => {
          getResultCalled = true;
          return 'value';
        }),
      () => true,
    );
    assert.strictEqual(getResultCalled, false);
  });

  it('works with void return type (Promise<void> callsites)', async () => {
    const instance = {
      waitUntilExit: () => Promise.resolve(),
    };
    const result = await awaitInkScreen(instance, () => undefined);
    assert.strictEqual(result, undefined);
  });

  it('propagates the exact result captured by closure mutation', async () => {
    const instance = {
      waitUntilExit: () => Promise.resolve(),
    };
    let capturedResult = 'initial';
    // Simulate the onDone callback pattern: mutation before exit
    const instanceWithSideEffect = {
      waitUntilExit: () => {
        capturedResult = 'updated';
        return Promise.resolve();
      },
    };
    const result = await awaitInkScreen(instanceWithSideEffect, () => capturedResult);
    assert.strictEqual(result, 'updated');
  });
});
