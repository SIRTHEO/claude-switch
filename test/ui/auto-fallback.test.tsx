// test/ui/auto-fallback.test.tsx
// Keystroke-driven coverage on the AutoFallbackScreen.
//
// The screen edits the global auto-fallback config (`enabled`,
// `threshold`, `engageEnabled`, `engageThreshold`) — the same config
// the passthrough auto-engage / auto-revert paths read at runtime.
// A regression here doesn't crash anything visible, it just silently
// flips when the user least expects it. Hence the screen-level test.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import { AutoFallbackScreen } from '../../src/ui/screens/auto-fallback.js';
import { getAutoFallbackConfig } from '../../src/auto-fallback.js';

interface Harness {
  tmpDir: string;
  accDir: string;
}

function setup(): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-af-'));
  const accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  return { tmpDir, accDir };
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

describe('AutoFallbackScreen — render', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('renders an initial frame with the config sections visible', async () => {
    const { lastFrame } = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    // The screen must surface the two top-level concerns: auto-revert
    // and auto-engage. Negotiable down the road, but the test pins
    // the "user can find both knobs from the entry frame" contract.
    assert.match(frame, /auto.?revert|revert/i);
    assert.match(frame, /auto.?engage|engage/i);
  });

  it('arrow-down moves the menu cursor visibly between items', async () => {
    // Bare ESC bytes are ambiguous in ink-testing-library's stdin (start
    // of a CSI escape sequence), so the screen's `finish()` keypress
    // path can't be reliably driven from this harness — covered by
    // manual smoke + the runAutoFallbackScreen wrapper test. We do
    // assert here that the cursor responds to navigation keys, which
    // is what the menu loop ultimately depends on.
    const ARROW_DOWN = `${String.fromCharCode(27)}[B`;
    const { stdin, lastFrame } = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const before = lastFrame() ?? '';
    stdin.write(ARROW_DOWN);
    await tick();
    const after = lastFrame() ?? '';
    assert.notEqual(before, after,
      `expected the cursor marker to move after ARROW_DOWN — got the same frame:\n${before}`);
  });
});

describe('AutoFallbackScreen — config writes', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('starts with the default config when no file exists', () => {
    const cfg = getAutoFallbackConfig(h.accDir);
    // Defaults aren't formally pinned at the type level; just assert
    // the shape is well-formed so a regression that returns null/undef
    // from getAutoFallbackConfig fails this loudly.
    assert.equal(typeof cfg.enabled, 'boolean');
    assert.equal(typeof cfg.threshold, 'number');
    assert.equal(typeof cfg.engageEnabled, 'boolean');
    assert.equal(typeof cfg.engageThreshold, 'number');
  });

  it('reads the current config on mount and surfaces it in the rendered frame', async () => {
    const { lastFrame } = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const cfg = getAutoFallbackConfig(h.accDir);
    const frame = lastFrame() ?? '';
    // Either threshold appearing is enough — the screen formats them
    // a few different ways depending on enabled-state, so we don't
    // pin the exact rendering.
    assert.ok(
      frame.includes(`${cfg.threshold}`) || frame.includes(`${cfg.engageThreshold}`)
        || frame.includes('OFF'),
      `expected current config to render — got:\n${frame}`,
    );
  });
});
