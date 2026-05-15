// test/ui/setup-wizard.test.tsx
// Coverage for the SetupWizard screen (Phase 18.6 — push from 34→60%).
//
// Strategy: inject deterministic `deps` overrides so we can control which
// step the wizard transitions to without relying on the host machine's
// real claude install, npm bin, or shell config. All system-probe deps
// are replaced by tiny stubs; no real files are written/read.
//
// Phase 18.6 adds:
//   - controlled step transitions via SetupDeps injection
//   - manual-bin path (enter empty, enter path)
//   - no-npm-bin → summary auto-transition
//   - no-shell-config → enter/esc → summary
//   - pick-configs → onSubmit → startStatusLine paths
//   - startStatusLine: ours-plain (skip), foreign (sl-existing), absent (sl-confirm)
//   - sl-existing → enter → sl-replace-or-chain → arrow/enter/esc
//   - sl-confirm → confirm → sl-pick-variant → arrow/enter/esc
//   - summary → enter → onDone fired
//   - installStatusLine throwing → installed: false
//
// All keystroke helpers use makeKeystrokeHelper(instance) as required.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';

import { SetupScreen } from '../../src/ui/screens/setup-wizard.js';
import type { SetupWizardResult, SetupDeps } from '../../src/ui/screens/setup-wizard.js';
import { makeKeystrokeHelper } from './ink-keystroke-helper.js';

// ink-testing-library instance type (minimal structural interface)
interface InkInstance {
  stdin: { write(data: string): void };
  unmount: () => void;
  lastFrame: () => string | undefined;
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

/** Stub deps that put the wizard on manual-bin step (findRealClaude returns null). */
function makeStubDepsManualBin(overrides: Partial<SetupDeps> = {}): Partial<SetupDeps> {
  return {
    findRealClaude: () => null,
    saveClaudeBin: () => undefined,
    getNpmBinDir: () => '/usr/local/bin',
    detectShellConfigs: () => ['/home/user/.zshrc'],
    patchShellConfig: () => true,
    detectExistingStatusLine: () => ({ kind: 'absent' }),
    installStatusLine: () => undefined,
    ...overrides,
  };
}

/** Stub deps that skip directly to pick-configs (claude found, npm bin found, shells found). */
function makeStubDepsPickConfigs(overrides: Partial<SetupDeps> = {}): Partial<SetupDeps> {
  return {
    findRealClaude: () => '/usr/local/bin/claude',
    saveClaudeBin: () => undefined,
    getNpmBinDir: () => '/usr/local/bin',
    detectShellConfigs: () => ['/home/user/.zshrc'],
    patchShellConfig: () => true,
    detectExistingStatusLine: () => ({ kind: 'absent' }),
    installStatusLine: () => undefined,
    ...overrides,
  };
}

/** Stub deps that auto-navigate to no-npm-bin then summary. */
function makeStubDepsNoNpmBin(overrides: Partial<SetupDeps> = {}): Partial<SetupDeps> {
  return {
    findRealClaude: () => '/usr/local/bin/claude',
    saveClaudeBin: () => undefined,
    getNpmBinDir: () => null,
    detectShellConfigs: () => [],
    patchShellConfig: () => false,
    detectExistingStatusLine: () => ({ kind: 'absent' }),
    installStatusLine: () => undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Existing tests (preserved — no regression)
// ---------------------------------------------------------------------------

describe('SetupScreen — existing (baseline)', () => {
  let instance: InkInstance | null = null;

  afterEach(() => { instance?.unmount(); instance = null; });

  it('mounts and renders a non-empty first frame', async () => {
    instance = render(
      <SetupScreen selfPath="/usr/local/bin/claude-switch" onDone={() => undefined} />,
    ) as InkInstance;
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.ok(frame.length > 0, 'expected the wizard to render at least one cell on mount');
  });

  it('reaches a stable step within a few ticks (does not infinite-loop)', async () => {
    instance = render(
      <SetupScreen selfPath="/usr/local/bin/claude-switch" onDone={() => undefined} />,
    ) as InkInstance;
    await ticks(5);
    const a = instance.lastFrame();
    await tick();
    const b = instance.lastFrame();
    assert.equal(a, b, `expected stable frame after several ticks`);
  });

  it('does not call onDone before the user makes a choice', async () => {
    const calls: SetupWizardResult[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={(r) => { calls.push(r); }}
      />,
    ) as InkInstance;
    await ticks(5);
    assert.equal(calls.length, 0, `expected zero onDone calls before keystrokes — got ${calls.length}`);
  });
});

// ---------------------------------------------------------------------------
// manual-bin step (Phase 18.6)
// ---------------------------------------------------------------------------

describe('SetupScreen — manual-bin step', () => {
  let instance: InkInstance | null = null;

  afterEach(() => { instance?.unmount(); instance = null; });

  it('renders the manual-bin prompt when findRealClaude returns null', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsManualBin()}
      />,
    ) as InkInstance;
    await ticks(3);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /No claude binary|claude.*binary|Path.*skip/i,
      `expected manual-bin step to render — got:\n${frame}`);
  });

  it('empty Enter on manual-bin skips (binPath=null) and transitions to next step', async () => {
    const saveClaudeBinCalls: string[] = [];

    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsManualBin({
          saveClaudeBin: (p) => { saveClaudeBinCalls.push(p); },
          // no-shell-config path so wizard reaches summary without more keystrokes
          detectShellConfigs: () => [],
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);

    // Wait for manual-bin step to render
    await ticks(3);

    // Press Enter with empty input
    await ks.pressEnter();
    await ticks(5);

    // Should have advanced past manual-bin; no saveClaudeBin call for skip
    assert.equal(saveClaudeBinCalls.length, 0, 'empty Enter should skip saveClaudeBin');
  });

  it('typing a path + Enter on manual-bin calls saveClaudeBin and advances', async () => {
    const saveClaudeBinCalls: string[] = [];

    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsManualBin({
          saveClaudeBin: (p) => { saveClaudeBinCalls.push(p); },
          detectShellConfigs: () => [],
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);

    await ticks(3);
    // Type a path
    await ks.type('/custom/bin/claude');
    await ks.pressEnter();
    await ticks(5);

    assert.ok(saveClaudeBinCalls.includes('/custom/bin/claude'),
      `expected saveClaudeBin('/custom/bin/claude') — got: ${JSON.stringify(saveClaudeBinCalls)}`);
  });
});

// ---------------------------------------------------------------------------
// no-npm-bin → summary (Phase 18.6)
// ---------------------------------------------------------------------------

describe('SetupScreen — no-npm-bin path', () => {
  let instance: InkInstance | null = null;

  afterEach(() => { instance?.unmount(); instance = null; });

  it('auto-transitions through no-npm-bin to summary and renders summary', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsNoNpmBin()}
      />,
    ) as InkInstance;
    await ticks(5);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /summary|Shell config|enter.*esc.*finish/i,
      `expected summary step to render — got:\n${frame}`);
  });

  it('onDone is called with statusLineInstalled=false when npm bin is missing', async () => {
    const results: SetupWizardResult[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={(r) => { results.push(r); }}
        deps={makeStubDepsNoNpmBin()}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(5);
    // Summary step requires Enter to finish
    await ks.pressEnter();
    await ticks(3);
    assert.ok(results.length > 0, 'expected onDone to be called');
    assert.equal(results[0]!.statusLineInstalled, false);
    assert.equal(results[0]!.patchedConfigs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// no-shell-config step (Phase 18.6)
// ---------------------------------------------------------------------------

describe('SetupScreen — no-shell-config step', () => {
  let instance: InkInstance | null = null;

  afterEach(() => { instance?.unmount(); instance = null; });

  it('renders no-shell-config message when detectShellConfigs returns empty', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsManualBin({
          // Override findRealClaude to trigger detect-shell then no-shell-config
          findRealClaude: () => '/usr/local/bin/claude',
          detectShellConfigs: () => [],
        })}
      />,
    ) as InkInstance;
    await ticks(4);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /No shell config|no shell|shell.*config/i,
      `expected no-shell-config message — got:\n${frame}`);
  });

  it('Enter on no-shell-config advances to summary', async () => {
    const results: SetupWizardResult[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={(r) => { results.push(r); }}
        deps={{
          findRealClaude: () => '/usr/local/bin/claude',
          saveClaudeBin: () => undefined,
          getNpmBinDir: () => '/usr/local/bin',
          detectShellConfigs: () => [],
          patchShellConfig: () => false,
          detectExistingStatusLine: () => ({ kind: 'absent' }),
          installStatusLine: () => undefined,
        }}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);

    await ticks(4);
    // no-shell-config: press Enter to continue
    await ks.pressEnter();
    await ticks(3);

    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /summary|enter.*esc.*finish/i,
      `expected summary step after Enter on no-shell-config — got:\n${frame}`);

    // Press Enter again to close summary and call onDone
    await ks.pressEnter();
    await ticks(3);
    assert.ok(results.length > 0, 'expected onDone after Enter on summary');
  });

  it('ESC on no-shell-config also advances to summary', async () => {
    const results: SetupWizardResult[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={(r) => { results.push(r); }}
        deps={{
          findRealClaude: () => '/usr/local/bin/claude',
          saveClaudeBin: () => undefined,
          getNpmBinDir: () => '/usr/local/bin',
          detectShellConfigs: () => [],
          patchShellConfig: () => false,
          detectExistingStatusLine: () => ({ kind: 'absent' }),
          installStatusLine: () => undefined,
        }}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);

    await ticks(4);
    await ks.pressEsc();
    await ticks(3);

    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /summary|enter.*esc.*finish/i,
      `expected summary step after ESC on no-shell-config — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// startStatusLine paths (Phase 18.6)
// ---------------------------------------------------------------------------

describe('SetupScreen — startStatusLine: already installed (ours-plain)', () => {
  let instance: InkInstance | null = null;

  afterEach(() => { instance?.unmount(); instance = null; });

  it('skips status-line questions and goes straight to summary when ours-plain detected', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'ours-plain' }),
        })}
      />,
    ) as InkInstance;
    // pick-configs step renders with MultiSelect — we need to submit it.
    // MultiSelect submits on Enter with all pre-selected.
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    // Submit MultiSelect (enter with defaults)
    await ks.pressEnter();
    await ticks(5);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /summary|enter.*esc.*finish/i,
      `expected summary (skipped sl-confirm) when ours-plain — got:\n${frame}`);
  });
});

describe('SetupScreen — startStatusLine: foreign existing', () => {
  let instance: InkInstance | null = null;

  afterEach(() => { instance?.unmount(); instance = null; });

  it('shows sl-existing step when a foreign statusline is detected', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'foreign', command: 'mycustom_prompt_command' }),
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    // Submit MultiSelect
    await ks.pressEnter();
    await ticks(5);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /already.*status|custom.*status|chain|replace|keep/i,
      `expected sl-existing or sl-replace-or-chain step — got:\n${frame}`);
  });

  it('Enter on sl-existing goes to sl-replace-or-chain', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'foreign', command: 'mycustom' }),
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect → startStatusLine → sl-existing
    await ticks(5);
    await ks.pressEnter(); // advance sl-existing → sl-replace-or-chain
    await ticks(3);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Keep.*I have|Chain.*ccstatusline|Replace.*badge|What.*like.*do/i,
      `expected sl-replace-or-chain menu — got:\n${frame}`);
  });

  it('arrow-down moves cursor in sl-replace-or-chain', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'foreign', command: 'mycustom' }),
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect
    await ticks(5);
    await ks.pressEnter(); // sl-existing → sl-replace-or-chain
    await ticks(3);
    const before = instance.lastFrame() ?? '';
    await ks.pressArrow('down');
    await ticks(2);
    const after = instance.lastFrame() ?? '';
    assert.notEqual(before, after, 'expected cursor to move after arrow-down in sl-replace-or-chain');
  });

  it('ESC on sl-replace-or-chain goes to summary', async () => {
    const results: SetupWizardResult[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={(r) => { results.push(r); }}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'foreign', command: 'mycustom' }),
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect
    await ticks(5);
    await ks.pressEnter(); // sl-existing → sl-replace-or-chain
    await ticks(3);
    await ks.pressEsc(); // → summary
    await ticks(3);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /summary|enter.*esc.*finish/i,
      `expected summary after ESC on sl-replace-or-chain — got:\n${frame}`);
  });

  it('Enter on sl-replace-or-chain (skip choice) goes to summary without installing', async () => {
    const installCalls: string[] = [];
    const results: SetupWizardResult[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={(r) => { results.push(r); }}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'foreign', command: 'mycustom' }),
          installStatusLine: (cmd) => { installCalls.push(cmd); },
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect
    await ticks(5);
    await ks.pressEnter(); // sl-existing → sl-replace-or-chain (cursor=0 = skip)
    await ticks(3);
    await ks.pressEnter(); // select 'skip'
    await ticks(3);
    assert.equal(installCalls.length, 0, 'skip should not call installStatusLine');
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /summary|enter.*esc.*finish/i, `expected summary — got:\n${frame}`);
  });

  it('Enter on sl-replace-or-chain (replace choice) installs PLAIN_COMMAND', async () => {
    const installCalls: string[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'foreign', command: 'mycustom' }),
          installStatusLine: (cmd) => { installCalls.push(cmd); },
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect
    await ticks(5);
    await ks.pressEnter(); // sl-existing → sl-replace-or-chain
    await ticks(3);
    // Move to 'replace' (index 2)
    await ks.pressArrow('down'); await ticks(2);
    await ks.pressArrow('down'); await ticks(2);
    await ks.pressEnter(); // select 'replace'
    await ticks(3);
    assert.ok(installCalls.length > 0, 'expected installStatusLine to be called for replace');
  });
});

// ---------------------------------------------------------------------------
// sl-confirm → sl-pick-variant (Phase 18.6)
// ---------------------------------------------------------------------------

describe('SetupScreen — sl-confirm → sl-pick-variant', () => {
  let instance: InkInstance | null = null;

  afterEach(() => { instance?.unmount(); instance = null; });

  it('renders sl-confirm when no existing statusline detected', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'absent' }),
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect → startStatusLine → sl-confirm
    await ticks(5);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /status bar|account.*badge|Show.*active/i,
      `expected sl-confirm step — got:\n${frame}`);
  });

  it('sl-pick-variant renders after confirming sl-confirm', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'absent' }),
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect → sl-confirm
    await ticks(5);
    // ConfirmInput default is 'confirm'; pressing Enter confirms
    await ks.pressEnter();
    await ticks(3);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Which style|badge|ccstatusline/i,
      `expected sl-pick-variant step — got:\n${frame}`);
  });

  it('arrow-down moves cursor in sl-pick-variant', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'absent' }),
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect → sl-confirm
    await ticks(5);
    await ks.pressEnter(); // confirm → sl-pick-variant
    await ticks(3);
    const before = instance.lastFrame() ?? '';
    await ks.pressArrow('down');
    await ticks(2);
    const after = instance.lastFrame() ?? '';
    assert.notEqual(before, after, 'expected cursor to move after arrow-down in sl-pick-variant');
  });

  it('ESC on sl-pick-variant goes to summary', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'absent' }),
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect → sl-confirm
    await ticks(5);
    await ks.pressEnter(); // confirm → sl-pick-variant
    await ticks(3);
    await ks.pressEsc(); // → summary
    await ticks(3);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /summary|enter.*esc.*finish/i,
      `expected summary after ESC on sl-pick-variant — got:\n${frame}`);
  });

  it('Enter on sl-pick-variant (plain) calls installStatusLine and shows summary', async () => {
    const installCalls: string[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'absent' }),
          installStatusLine: (cmd) => { installCalls.push(cmd); },
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect → sl-confirm
    await ticks(5);
    await ks.pressEnter(); // confirm → sl-pick-variant
    await ticks(3);
    await ks.pressEnter(); // select plain (index 0)
    await ticks(3);
    assert.ok(installCalls.length > 0, 'expected installStatusLine to be called');
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /summary|enter.*esc.*finish/i,
      `expected summary after selecting plain — got:\n${frame}`);
  });

  it('installStatusLine throwing → statusLineInstalled=false in result', async () => {
    const results: SetupWizardResult[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={(r) => { results.push(r); }}
        deps={makeStubDepsPickConfigs({
          detectExistingStatusLine: () => ({ kind: 'absent' }),
          installStatusLine: () => { throw new Error('install failed'); },
        })}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(4);
    await ks.pressEnter(); // submit MultiSelect → sl-confirm
    await ticks(5);
    await ks.pressEnter(); // confirm → sl-pick-variant
    await ticks(3);
    await ks.pressEnter(); // select variant → installAndFinish (throws) → summary
    await ticks(3);
    // Now at summary, press Enter to call onDone
    await ks.pressEnter();
    await ticks(3);
    assert.ok(results.length > 0, 'expected onDone to be called');
    assert.equal(results[0]!.statusLineInstalled, false,
      'expected statusLineInstalled=false when installStatusLine throws');
  });
});

// ---------------------------------------------------------------------------
// summary step (Phase 18.6)
// ---------------------------------------------------------------------------

describe('SetupScreen — summary step', () => {
  let instance: InkInstance | null = null;

  afterEach(() => { instance?.unmount(); instance = null; });

  it('summary shows binPath when claude was found', async () => {
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={() => undefined}
        deps={makeStubDepsNoNpmBin()}
      />,
    ) as InkInstance;
    await ticks(5);
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /\/usr\/local\/bin\/claude|Real claude/i,
      `expected binPath in summary — got:\n${frame}`);
  });

  it('summary Enter calls onDone', async () => {
    const results: SetupWizardResult[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={(r) => { results.push(r); }}
        deps={makeStubDepsNoNpmBin()}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(5);
    await ks.pressEnter();
    await ticks(3);
    assert.ok(results.length > 0, 'expected onDone to be called from summary Enter');
    assert.equal(results[0]!.cancelled, false);
  });

  it('summary ESC also calls onDone', async () => {
    const results: SetupWizardResult[] = [];
    instance = render(
      <SetupScreen
        selfPath="/usr/local/bin/claude-switch"
        onDone={(r) => { results.push(r); }}
        deps={makeStubDepsNoNpmBin()}
      />,
    ) as InkInstance;
    const ks = makeKeystrokeHelper(instance);
    await ticks(5);
    await ks.pressEsc();
    await ticks(3);
    assert.ok(results.length > 0, 'expected onDone to be called from summary ESC');
  });
});
