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
      options: { stdio: 'inherit' },
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

  it('does not set env when extraEnv is omitted', () => {
    const result = buildSpawnArgs('/usr/local/bin/claude', [], 'darwin');
    assert.equal(result.options.env, undefined);
  });

  it('does not set env when extraEnv is null', () => {
    const result = buildSpawnArgs('/usr/local/bin/claude', [], 'darwin', null);
    assert.equal(result.options.env, undefined);
  });

  it('merges extraEnv with process.env', () => {
    const result = buildSpawnArgs('/usr/local/bin/claude', [], 'darwin', { ANTHROPIC_API_KEY: 'sk-ant-test' });
    assert.equal(result.options.env?.ANTHROPIC_API_KEY, 'sk-ant-test');
    // Sanity check: a process.env var is preserved. Use case-insensitive
    // lookup because Windows stores PATH as "Path" (and Node.js exposes it
    // case-insensitively via process.env.PATH, but the spread {...process.env}
    // preserves the original key). On unix the real key is always uppercase.
    const env = result.options.env ?? {};
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path');
    assert.ok(pathKey, 'expected a PATH-like key to be present');
    assert.equal(env[pathKey], process.env.PATH);
  });

  it('extraEnv overrides parent process.env', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-old';
    try {
      const result = buildSpawnArgs('/usr/local/bin/claude', [], 'darwin', { ANTHROPIC_API_KEY: 'sk-ant-new' });
      assert.equal(result.options.env?.ANTHROPIC_API_KEY, 'sk-ant-new');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
