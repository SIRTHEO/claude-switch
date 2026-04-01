// test/proxy.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpawnArgs } from '../src/proxy.js';

describe('proxy', () => {
  it('builds spawn args for unix', () => {
    const result = buildSpawnArgs('/usr/local/bin/claude', ['--help'], 'darwin');
    assert.deepEqual(result, {
      command: '/usr/local/bin/claude',
      args: ['--help'],
      options: { stdio: 'inherit' },
    });
  });

  it('builds spawn args for windows .cmd', () => {
    const result = buildSpawnArgs('C:\\npm\\claude.cmd', ['--help'], 'win32');
    assert.deepEqual(result, {
      command: 'C:\\npm\\claude.cmd',
      args: ['--help'],
      options: { stdio: 'inherit', shell: true },
    });
  });

  it('builds spawn args for windows non-cmd', () => {
    const result = buildSpawnArgs('C:\\bin\\claude.exe', ['--help'], 'win32');
    assert.deepEqual(result, {
      command: 'C:\\bin\\claude.exe',
      args: ['--help'],
      options: { stdio: 'inherit' },
    });
  });
});
