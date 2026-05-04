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

  it('returns false and does not patch when npmBinDir contains unsafe characters', () => {
    const zshrc = path.join(tmpDir, '.zshrc');
    fs.writeFileSync(zshrc, '');
    const result = patchShellConfig(zshrc, '/path/with"quote');
    assert.equal(result, false);
    const content = fs.readFileSync(zshrc, 'utf-8');
    assert.ok(!content.includes('claude-switch'));
  });
});

describe('findRealClaude', () => {
  let origPath: string | undefined;
  let origClaudeSwitchBin: string | undefined;

  beforeEach(() => {
    origPath = process.env.PATH;
    origClaudeSwitchBin = process.env.CLAUDE_SWITCH_BIN;
    delete process.env.CLAUDE_SWITCH_BIN;
  });
  afterEach(() => {
    process.env.PATH = origPath;
    if (origClaudeSwitchBin !== undefined) {
      process.env.CLAUDE_SWITCH_BIN = origClaudeSwitchBin;
    } else {
      delete process.env.CLAUDE_SWITCH_BIN;
    }
  });

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

  describe('first-run on fresh HOME', () => {
    let tmpHome: string;
    let origHome: string | undefined;
    let origUserProfile: string | undefined;
    // Capture stdout so the test output stays clean.
    let stdoutBuffer: string[];
    let originalWrite: typeof process.stdout.write;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-runsetup-'));
      origHome = process.env.HOME;
      origUserProfile = process.env.USERPROFILE;
      process.env.HOME = tmpHome;
      // On Windows, os.homedir() uses USERPROFILE, not HOME.
      if (process.platform === 'win32') process.env.USERPROFILE = tmpHome;
      // Fake npm prefix points at a dir we can write into.
      const fakeNpmPrefix = path.join(tmpHome, 'fake-npm-global');
      fs.mkdirSync(path.join(fakeNpmPrefix, 'bin'), { recursive: true });
      process.env.npm_config_prefix = fakeNpmPrefix;
      // Pre-create an empty .zshrc so detectShellConfigs picks it up.
      fs.writeFileSync(path.join(tmpHome, '.zshrc'), '# preserved\n');
      stdoutBuffer = [];
      originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        stdoutBuffer.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      }) as typeof process.stdout.write;
    });

    afterEach(() => {
      process.stdout.write = originalWrite;
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (process.platform === 'win32') {
        if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
        else delete process.env.USERPROFILE;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('patches an empty .zshrc on first run', () => {
      runSetup('/nonexistent/self');
      const zshrc = fs.readFileSync(path.join(tmpHome, '.zshrc'), 'utf-8');
      assert.match(zshrc, /# preserved/, 'preserves the existing .zshrc content');
      assert.match(zshrc, /fake-npm-global/, 'adds the npm bin dir to PATH');
      const out = stdoutBuffer.join('');
      assert.match(out, /setup complete/i);
    });

    it('is idempotent — second run does not duplicate the PATH block', () => {
      runSetup('/nonexistent/self');
      const afterFirst = fs.readFileSync(path.join(tmpHome, '.zshrc'), 'utf-8');
      runSetup('/nonexistent/self');
      const afterSecond = fs.readFileSync(path.join(tmpHome, '.zshrc'), 'utf-8');
      assert.equal(afterFirst, afterSecond, 'second runSetup must not change the file');
      const out = stdoutBuffer.join('');
      assert.match(out, /already configured|setup complete/i);
    });
  });
});
