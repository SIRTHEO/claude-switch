// test/resolver.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolve } from '../src/routing/resolver.js';

describe('resolver', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns CLAUDE_SWITCH_BIN if set and points to a valid executable', () => {
    const customBin = path.join(tmpDir, 'custom-claude');
    fs.writeFileSync(customBin, '#!/bin/sh\necho real');
    fs.chmodSync(customBin, 0o755);
    const result = resolve({
      envBin: customBin,
      selfPath: '/some/other/path',
      pathEnv: '',
    });
    assert.equal(result, customBin);
  });

  it('returns null when CLAUDE_SWITCH_BIN points to a non-existent path', () => {
    const result = resolve({
      envBin: '/no/such/binary',
      selfPath: '/some/other/path',
      pathEnv: '',
    });
    assert.equal(result, null);
  });

  it('returns null when CLAUDE_SWITCH_BIN points to another claude-switch wrapper', () => {
    const wrapper = path.join(tmpDir, 'rogue-wrapper');
    fs.writeFileSync(wrapper, '#!/usr/bin/env node\n// claude-switch');
    fs.chmodSync(wrapper, 0o755);
    const result = resolve({
      envBin: wrapper,
      selfPath: '/some/other/path',
      pathEnv: '',
    });
    assert.equal(result, null);
  });

  it('finds claude in PATH, skipping self', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const fakeClaude = path.join(binDir, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\necho real');
    fs.chmodSync(fakeClaude, 0o755);

    const result = resolve({
      envBin: '',
      selfPath: '/different/path/cli.js',
      pathEnv: binDir,
    });
    assert.equal(result, fakeClaude);
  });

  it('skips candidate that resolves to self', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const selfFile = path.join(binDir, 'claude');
    fs.writeFileSync(selfFile, '#!/usr/bin/env node\n// claude-switch');
    fs.chmodSync(selfFile, 0o755);

    const result = resolve({
      envBin: '',
      selfPath: fs.realpathSync(selfFile),
      pathEnv: binDir,
    });
    assert.equal(result, null);
  });

  it('skips other claude-switch wrappers', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const wrapper = path.join(binDir, 'claude');
    fs.writeFileSync(wrapper, '#!/usr/bin/env zsh\n# claude-switch wrapper\necho hi');
    fs.chmodSync(wrapper, 0o755);

    const result = resolve({
      envBin: '',
      selfPath: '/other/path/cli.js',
      pathEnv: binDir,
    });
    assert.equal(result, null);
  });
});
