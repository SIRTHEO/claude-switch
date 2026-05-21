import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import { launchInTerminal } from '../src/terminals.js';
import type { ProcessPort } from '../src/process.js';

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
