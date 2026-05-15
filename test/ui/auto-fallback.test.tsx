// test/ui/auto-fallback.test.tsx
// Keystroke-driven coverage on the AutoFallbackScreen.
//
// The screen edits the global auto-fallback config (`enabled`,
// `threshold`, `engageEnabled`, `engageThreshold`) — the same config
// the passthrough auto-engage / auto-revert paths read at runtime.
// A regression here doesn't crash anything visible, it just silently
// flips when the user least expects it. Hence the screen-level test.
//
// Uses ink-testing-library + makeKeystrokeHelper (Phase 18.8).
// afterEach calls instance?.unmount() to prevent timer leaks.
//
// Privacy: never uses real email addresses.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import { AutoFallbackScreen } from '../../src/ui/screens/auto-fallback.js';
import { getAutoFallbackConfig, setAutoFallbackConfig } from '../../src/auto-fallback.js';
import { makeKeystrokeHelper } from '../ui/ink-keystroke-helper.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. Render
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — render', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('renders an initial frame with the config sections visible', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    // The screen must surface the two top-level concerns: auto-revert
    // and auto-engage. Negotiable down the road, but the test pins
    // the "user can find both knobs from the entry frame" contract.
    assert.match(frame, /auto.?revert|revert/i);
    assert.match(frame, /auto.?engage|engage/i);
  });

  it('arrow-down moves the menu cursor visibly between items', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    const before = instance.lastFrame() ?? '';
    await keys.pressArrow('down');
    const after = instance.lastFrame() ?? '';
    assert.notEqual(before, after,
      `expected the cursor marker to move after ARROW_DOWN — got the same frame:\n${before}`);
  });

  it('arrow-up clamps at top without crashing', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressArrow('up');
    await keys.pressArrow('up');
    const frame = instance.lastFrame() ?? '';
    assert.ok(frame.length > 0, 'expected non-empty frame after repeated arrow-up');
  });
});

// ---------------------------------------------------------------------------
// 2. Config reads
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — config reads', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('starts with the default config when no file exists', () => {
    const cfg = getAutoFallbackConfig(h.accDir);
    assert.equal(typeof cfg.enabled, 'boolean');
    assert.equal(typeof cfg.threshold, 'number');
    assert.equal(typeof cfg.engageEnabled, 'boolean');
    assert.equal(typeof cfg.engageThreshold, 'number');
  });

  it('reads the current config on mount and surfaces it in the rendered frame', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const cfg = getAutoFallbackConfig(h.accDir);
    const frame = instance.lastFrame() ?? '';
    assert.ok(
      frame.includes(`${cfg.threshold}`) || frame.includes(`${cfg.engageThreshold}`)
        || frame.includes('OFF'),
      `expected current config to render — got:\n${frame}`,
    );
  });

  it('reads an existing config from disk on mount', async () => {
    // Write a custom config before mounting the screen.
    setAutoFallbackConfig(h.accDir, { enabled: true, threshold: 70, engageEnabled: false });
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    // With enabled=true, label changes to "Disable auto-revert" and shows threshold.
    assert.match(frame, /70|Disable auto-revert/i,
      `expected seeded threshold in frame — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// 3. ESC on menu — calls onDone
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — ESC exits', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('ESC on menu fires onDone', async () => {
    let done = 0;
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => { done++; }} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressEsc();
    await tick();
    assert.ok(done >= 1, `expected onDone to fire after ESC — got ${done}`);
  });
});

// ---------------------------------------------------------------------------
// 4. show-config item
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — show-config', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('pressing Enter on "Show current config" reveals the config section', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Navigate down until "Show current config" is selected (2nd-to-last item when both disabled).
    // Default: 0=toggle-revert, 1=toggle-engage, 2=show-config, 3=back
    await keys.pressArrow('down');
    await keys.pressArrow('down');
    await keys.pressEnter();
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Auto-fallback config|Auto-revert|Auto-engage/i,
      `expected config panel after "Show current config" — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Back item — calls onDone
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — back item', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('navigating to "Back to main menu" and pressing Enter calls onDone', async () => {
    let done = 0;
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => { done++; }} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Navigate all the way down to land on "Back to main menu".
    for (let i = 0; i < 10; i++) {
      const frame = instance.lastFrame() ?? '';
      if (/▸ Back to main menu/.test(frame)) break;
      await keys.pressArrow('down');
    }
    await keys.pressEnter();
    await tick();
    assert.ok(done >= 1, `expected onDone after selecting Back — got ${done}`);
  });
});

// ---------------------------------------------------------------------------
// 6. Toggle-revert flow — enable via prompt
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — toggle-revert enable', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('Enter on "Enable auto-revert" opens the threshold prompt', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Item 0 is "Enable auto-revert" when disabled (default).
    await keys.pressEnter();
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /threshold|fallback|revert/i,
      `expected threshold prompt after Enter on Enable auto-revert — got:\n${frame}`);
  });

  it('submitting a valid threshold enables auto-revert and writes config', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Enter on item 0 → prompt for revert threshold.
    await keys.pressEnter();
    await tick();
    // The TextInput has a defaultValue (80). Press Enter immediately to accept
    // the default — that's a valid revert threshold (< default engageThreshold 95).
    await keys.pressEnter();
    await tick();
    const cfg = getAutoFallbackConfig(h.accDir);
    assert.equal(cfg.enabled, true, 'expected auto-revert enabled after submit');
    // The default threshold is 80.
    assert.equal(typeof cfg.threshold, 'number', `expected numeric threshold — got ${cfg.threshold}`);
    assert.ok(cfg.threshold >= 1 && cfg.threshold <= 100, `threshold ${cfg.threshold} out of range`);
  });

  it('invalid threshold (0) shows an error without writing config', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressEnter();
    await tick();
    await keys.type('0');
    await keys.pressEnter();
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /1 and 100|Pick a number/i,
      `expected validation error — got:\n${frame}`);
    // Config should remain unchanged (enabled=false).
    const cfg = getAutoFallbackConfig(h.accDir);
    assert.equal(cfg.enabled, false);
  });

  it('ESC during revert prompt closes prompt without writing config', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressEnter();
    await tick();
    // Abort the prompt with ESC.
    await keys.pressEsc();
    await tick();
    const cfg = getAutoFallbackConfig(h.accDir);
    assert.equal(cfg.enabled, false, 'config should be unchanged after ESC during prompt');
    const frame = instance.lastFrame() ?? '';
    // Prompt should be gone — menu items should be visible again.
    assert.match(frame, /auto.?revert|revert|engage/i,
      `expected menu after ESC — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// 7. Toggle-engage flow — enable via prompt
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — toggle-engage enable', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('Enter on "Enable auto-engage" opens the threshold prompt', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Item 1 is "Enable auto-engage" (default: both disabled, no set-revert item).
    await keys.pressArrow('down');
    await keys.pressEnter();
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /threshold|fallback|engage/i,
      `expected threshold prompt after Enter on Enable auto-engage — got:\n${frame}`);
  });

  it('submitting a valid engage threshold enables auto-engage and writes config', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressArrow('down');
    await keys.pressEnter();
    await tick();
    // Accept the default engage threshold (95) by pressing Enter immediately.
    // 95 > 80 (default revert threshold) so the hysteresis invariant holds.
    await keys.pressEnter();
    await tick();
    const cfg = getAutoFallbackConfig(h.accDir);
    assert.equal(cfg.engageEnabled, true, 'expected auto-engage enabled after submit');
    assert.ok(cfg.engageThreshold >= 1 && cfg.engageThreshold <= 100,
      `engageThreshold ${cfg.engageThreshold} out of range`);
  });
});

// ---------------------------------------------------------------------------
// 8. Toggle-revert disable — when already enabled
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — toggle-revert disable', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => {
    h = setup();
    // Pre-seed: auto-revert enabled with threshold=70.
    setAutoFallbackConfig(h.accDir, { enabled: true, threshold: 70 });
  });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('Enter on "Disable auto-revert" disables it immediately without prompt', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // When enabled, item 0 = "Disable auto-revert" (direct apply, no prompt).
    await keys.pressEnter();
    await tick();
    const cfg = getAutoFallbackConfig(h.accDir);
    assert.equal(cfg.enabled, false, 'expected auto-revert disabled after toggle');
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Auto-revert OFF|manual/i,
      `expected success message — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// 9. Toggle-engage disable — when already enabled
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — toggle-engage disable', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => {
    h = setup();
    // Pre-seed: auto-engage enabled.
    setAutoFallbackConfig(h.accDir, { engageEnabled: true, engageThreshold: 90 });
  });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('Enter on "Disable auto-engage" disables it immediately without prompt', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // With only engage enabled: item 0=toggle-revert, item 1=toggle-engage (Disable).
    await keys.pressArrow('down');
    await keys.pressEnter();
    await tick();
    const cfg = getAutoFallbackConfig(h.accDir);
    assert.equal(cfg.engageEnabled, false, 'expected auto-engage disabled after toggle');
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Auto-engage OFF|automatically/i,
      `expected success message — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// 10. Threshold validation — hysteresis guard
// ---------------------------------------------------------------------------

describe('AutoFallbackScreen — threshold validation', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => {
    h = setup();
    // Pre-seed: both enabled — revert=70, engage=90.
    setAutoFallbackConfig(h.accDir, { enabled: true, threshold: 70, engageEnabled: true, engageThreshold: 90 });
  });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('setting revert threshold >= engage threshold shows hysteresis error', async () => {
    instance = render(
      <AutoFallbackScreen accountsDirPath={h.accDir} onDone={() => undefined} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // With both enabled: 0=Disable auto-revert, 1=Set auto-revert threshold, ...
    // Navigate to "Set auto-revert threshold" (item 1).
    await keys.pressArrow('down');
    await keys.pressEnter();
    await tick();
    // Try setting revert threshold equal to engage threshold (90) — should fail.
    await keys.type('90');
    await keys.pressEnter();
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /strictly less|oscillation|engage threshold/i,
      `expected hysteresis error — got:\n${frame}`);
  });
});
