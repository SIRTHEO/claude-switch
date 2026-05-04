// test/notify.test.ts
// Verifies the helper module exists and exposes the four functions the
// 5.2 main-menu split is planned to consume. The actual rendering is
// owned by @clack/prompts and is not asserted here — the 5.4 contract
// is the API shape, not the visual output.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { notifyError, notifyOk, notifyInfo, notifyWarn } from '../src/ui/notify.js';

describe('notify helpers — API surface (5.4)', () => {
  it('exports notifyError as a function', () => {
    assert.strictEqual(typeof notifyError, 'function');
  });

  it('exports notifyOk as a function', () => {
    assert.strictEqual(typeof notifyOk, 'function');
  });

  it('exports notifyInfo as a function', () => {
    assert.strictEqual(typeof notifyInfo, 'function');
  });

  it('exports notifyWarn as a function', () => {
    assert.strictEqual(typeof notifyWarn, 'function');
  });

  // Smoke tests: verify the helpers don't throw on plausible inputs.
  // We intercept stdout/stderr so the test output isn't polluted by
  // p.note rendering.
  const muted = (fn: () => void): void => {
    const realStdout = process.stdout.write.bind(process.stdout);
    const realStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((): boolean => true) as typeof process.stdout.write;
    process.stderr.write = ((): boolean => true) as typeof process.stderr.write;
    try { fn(); }
    finally {
      process.stdout.write = realStdout;
      process.stderr.write = realStderr;
    }
  };

  it('notifyError accepts message + optional hint + title', () => {
    muted(() => {
      notifyError('Something broke');
      notifyError('Something broke', { hint: 'Run: claude switch setup' });
      notifyError('Something broke', { title: 'Setup needed' });
      notifyError('Something broke', { title: 'Setup needed', hint: 'Run: claude switch setup' });
    });
  });

  it('notifyOk accepts a single message string', () => {
    muted(() => notifyOk('API key removed.'));
  });

  it('notifyInfo accepts message + optional title', () => {
    muted(() => {
      notifyInfo('current account: a@x.com');
      notifyInfo('current account: a@x.com', 'Account');
    });
  });

  it('notifyWarn accepts message + optional hint + title', () => {
    muted(() => {
      notifyWarn('No saved credentials');
      notifyWarn('No saved credentials', { hint: 'Run: claude switch add' });
      notifyWarn('No saved credentials', { title: 'Tokens may be wrong' });
    });
  });
});
