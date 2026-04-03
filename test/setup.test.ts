import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getSavedClaudeBin,
  saveClaudeBin,
  getNpmBinDir,
  detectShellConfigs,
  patchShellConfig,
  findRealClaude,
  runSetup,
} from '../src/setup.js';

describe('getSavedClaudeBin', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-setup-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when .claude-bin does not exist', () => {
    const binFile = path.join(tmpDir, '.claude', 'accounts', '.claude-bin');
    assert.equal(getSavedClaudeBin(binFile), null);
  });

  it('returns null when saved path is not executable', () => {
    const binFile = path.join(tmpDir, '.claude', 'accounts', '.claude-bin');
    fs.mkdirSync(path.dirname(binFile), { recursive: true });
    fs.writeFileSync(binFile, '/nonexistent/path/claude');
    assert.equal(getSavedClaudeBin(binFile), null);
  });

  it('returns path when saved path is executable', () => {
    const fakeExe = path.join(tmpDir, 'claude');
    fs.writeFileSync(fakeExe, '#!/bin/sh');
    fs.chmodSync(fakeExe, 0o755);
    const binFile = path.join(tmpDir, '.claude', 'accounts', '.claude-bin');
    fs.mkdirSync(path.dirname(binFile), { recursive: true });
    fs.writeFileSync(binFile, fakeExe);
    assert.equal(getSavedClaudeBin(binFile), fakeExe);
  });
});

describe('saveClaudeBin', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-setup-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes path to .claude-bin file', () => {
    const binFile = path.join(tmpDir, '.claude', 'accounts', '.claude-bin');
    saveClaudeBin('/usr/local/bin/claude', binFile);
    assert.equal(fs.readFileSync(binFile, 'utf-8').trim(), '/usr/local/bin/claude');
  });

  it('sets 0o600 permissions on .claude-bin file (unix)', () => {
    if (process.platform === 'win32') return;
    const binFile = path.join(tmpDir, '.claude', 'accounts', '.claude-bin');
    saveClaudeBin('/usr/local/bin/claude', binFile);
    const stat = fs.statSync(binFile);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe('getNpmBinDir', () => {
  let origPrefix: string | undefined;

  beforeEach(() => { origPrefix = process.env.npm_config_prefix; });
  afterEach(() => { process.env.npm_config_prefix = origPrefix; });

  it('returns null when npm_config_prefix is not set', () => {
    delete process.env.npm_config_prefix;
    assert.equal(getNpmBinDir(), null);
  });

  it('returns prefix/bin on unix', () => {
    if (process.platform === 'win32') return;
    process.env.npm_config_prefix = '/opt/homebrew';
    assert.equal(getNpmBinDir(), '/opt/homebrew/bin');
  });
});

describe('detectShellConfigs', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-setup-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no shell configs exist', () => {
    assert.deepEqual(detectShellConfigs(tmpDir), []);
  });

  it('returns only existing shell configs', () => {
    const zshrc = path.join(tmpDir, '.zshrc');
    fs.writeFileSync(zshrc, '');
    const result = detectShellConfigs(tmpDir);
    assert.ok(result.includes(zshrc));
    assert.equal(result.length, 1);
  });
});

describe('patchShellConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-setup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends PATH block to zshrc', () => {
    const zshrc = path.join(tmpDir, '.zshrc');
    fs.writeFileSync(zshrc, '# existing content\n');
    const result = patchShellConfig(zshrc, '/opt/homebrew/bin');
    assert.equal(result, true);
    const content = fs.readFileSync(zshrc, 'utf-8');
    assert.ok(content.includes('# claude-switch'));
    assert.ok(content.includes('export PATH="/opt/homebrew/bin:$PATH"'));
    assert.ok(content.includes('# end claude-switch'));
  });

  it('is idempotent — does not patch twice', () => {
    const zshrc = path.join(tmpDir, '.zshrc');
    fs.writeFileSync(zshrc, '');
    patchShellConfig(zshrc, '/opt/homebrew/bin');
    const result = patchShellConfig(zshrc, '/opt/homebrew/bin');
    assert.equal(result, false);
    const content = fs.readFileSync(zshrc, 'utf-8');
    assert.equal((content.match(/# claude-switch/g) || []).length, 1);
  });

  it('uses fish_add_path for fish config', () => {
    const fishConfig = path.join(tmpDir, 'config.fish');
    fs.writeFileSync(fishConfig, '');
    patchShellConfig(fishConfig, '/opt/homebrew/bin');
    const content = fs.readFileSync(fishConfig, 'utf-8');
    assert.ok(content.includes('fish_add_path "/opt/homebrew/bin"'));
    assert.ok(!content.includes('export PATH'));
  });

  it('uses $env:PATH for PowerShell profile', () => {
    const profile = path.join(tmpDir, 'Microsoft.PowerShell_profile.ps1');
    fs.writeFileSync(profile, '');
    patchShellConfig(profile, 'C:\\Users\\user\\AppData\\Roaming\\npm');
    const content = fs.readFileSync(profile, 'utf-8');
    assert.ok(content.includes('$env:PATH'));
  });
});

describe('findRealClaude', () => {
  let origPath: string | undefined;

  beforeEach(() => { origPath = process.env.PATH; });
  afterEach(() => { process.env.PATH = origPath; });

  it('returns null when no claude binary exists in PATH', () => {
    process.env.PATH = '';
    // Pass the real resolved path of the system claude as selfPath so the
    // known-paths fallback treats any found binary as "self" and skips it.
    let selfPath = '/nonexistent/self/path';
    try {
      selfPath = fs.realpathSync('/usr/local/bin/claude');
    } catch { /* not installed, bogus path is fine */ }
    const result = findRealClaude(selfPath);
    assert.equal(result, null);
  });
});

describe('runSetup', () => {
  let origPath: string | undefined;
  let origPrefix: string | undefined;

  beforeEach(() => {
    origPath = process.env.PATH;
    origPrefix = process.env.npm_config_prefix;
    process.env.PATH = '';
    delete process.env.npm_config_prefix;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    process.env.npm_config_prefix = origPrefix;
  });

  it('does not throw when no claude binary found and no npm prefix', () => {
    assert.doesNotThrow(() => runSetup('/nonexistent/self'));
  });
});
