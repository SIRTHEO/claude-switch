import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import { launchInTerminal, buildWindowsLaunch } from '../src/sessions/terminals.js';
import type { ProcessPort } from '../src/platform/process.js';

interface SpawnCall { command: string; args: readonly string[]; }

// A ProcessPort that records every spawn/spawnSync without launching
// anything, so the launch shaping can be asserted without opening a real
// terminal window.
function recordingProc(): { proc: { process: ProcessPort }; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const result: SpawnSyncReturns<Buffer> = {
    pid: 1, output: [], stdout: Buffer.from(''), stderr: Buffer.from(''),
    status: 0, signal: null,
  };
  return {
    calls,
    proc: {
      process: {
        spawn: (command, args) => {
          calls.push({ command, args });
          return { unref: () => {} } as unknown as ChildProcess;
        },
        spawnSync: (command, args) => {
          calls.push({ command, args });
          return result;
        },
      },
    },
  };
}

describe('launchInTerminal — spawn shaping via injected ProcessPort', () => {
  it('drives Terminal.app through osascript on macOS', { skip: process.platform !== 'darwin' }, () => {
    const { proc, calls } = recordingProc();
    launchInTerminal({ terminalId: 'terminal', cwd: '/tmp/x', command: ['claude'] }, proc);
    assert.equal(calls.length, 2, 'do-script + activate');
    assert.equal(calls[0]!.command, 'osascript');
    assert.match(String(calls[0]!.args[1]), /tell application "Terminal" to do script/);
    assert.match(String(calls[0]!.args[1]), /cd .*\/tmp\/x/);
    assert.match(String(calls[1]!.args[1]), /to activate/);
  });

  it('spawns the bin with -e bash -lc on Linux', { skip: process.platform !== 'linux' }, () => {
    const { proc, calls } = recordingProc();
    launchInTerminal({ terminalId: 'xterm', cwd: '/tmp/x', command: ['claude'] }, proc);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'xterm');
    assert.deepEqual(calls[0]!.args.slice(0, 3), ['-e', 'bash', '-lc']);
  });

  it('throws on an unknown terminal id for the platform', { skip: process.platform === 'win32' }, () => {
    const { proc } = recordingProc();
    assert.throws(
      () => launchInTerminal({ terminalId: 'no-such-term', command: ['claude'] }, proc),
      /Unknown terminal id/,
    );
  });
});

// Pure shaping for the Windows launch — runnable on any platform. Guards the
// profile-isolation env (CLAUDE_CONFIG_DIR) and the argv form that the inline
// version got wrong (env dropped, starting-directory glued into one arg).
describe('buildWindowsLaunch — Windows argv + env shaping', () => {
  it('threads opts.env (profile isolation) and cwd into the spawn options', () => {
    const { options } = buildWindowsLaunch({
      terminalId: 'windows-terminal',
      cwd: 'C:/work',
      env: { CLAUDE_CONFIG_DIR: 'C:/profiles/x' },
      command: ['claude'],
    });
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, 'C:/profiles/x', 'CLAUDE_CONFIG_DIR must reach the child');
    assert.equal(options.cwd, 'C:/work');
    assert.equal(options.detached, true);
  });

  it('emits -d <cwd> as a separate argv pair for Windows Terminal, command trailing', () => {
    const { exe, args } = buildWindowsLaunch({
      terminalId: 'windows-terminal',
      cwd: 'C:/work',
      command: ['claude', '--resume'],
    });
    assert.equal(exe, 'wt.exe');
    assert.deepEqual(args, ['-d', 'C:/work', 'claude', '--resume']);
  });

  it('omits -d for non-wt hosts (they inherit the spawn cwd)', () => {
    const { exe, args } = buildWindowsLaunch({
      terminalId: 'powershell',
      cwd: 'C:/work',
      command: ['claude'],
    });
    assert.equal(exe, 'powershell.exe');
    assert.deepEqual(args, ['claude']);
  });

  it('throws on an unknown terminal id', () => {
    assert.throws(
      () => buildWindowsLaunch({ terminalId: 'no-such', command: ['claude'] }),
      /Unknown terminal id on Windows/,
    );
  });
});
