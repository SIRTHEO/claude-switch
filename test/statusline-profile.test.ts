// Profile-aware identity in statusline.
// Spawn the built CLI with controlled HOME + CLAUDE_CONFIG_DIR fixtures
// and assert that `claude switch statusline --format json` reads the
// effective email from the right `.claude.json` (profile vs global).

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'dist', 'bin', 'cli.js');

interface StatuslineJson {
  email: string | null;
  shortName?: string;
  mode?: string | null;
  effectiveMode?: 'oauth' | 'oauth-burst' | 'api-auto' | 'api';
  proxyRuntimeMode?: string | null;
  fallback?: boolean;
  hasApiKey?: boolean;
  profile?: string | null;
}

function runStatusline(home: string, configDir?: string): StatuslineJson {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home, // Windows: os.homedir() reads USERPROFILE, not HOME
    CLAUDE_SWITCH_DISABLE_KEYCHAIN: '1', // hot-path for tests; no Keychain prompts
  };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, [CLI, 'switch', 'statusline', '--json', '--no-color'], {
    env,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (r.error) throw r.error;
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line);
}

describe('statusline — profile-aware identity (Phase 13.1)', () => {
  let tmpHome: string;
  let profileDir: string;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-prof-'));
    // Global account file
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'global@x.com' },
    }));
    // Profile with a DIFFERENT account
    profileDir = path.join(tmpHome, '.claude', 'profiles', 'workprofile');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, '.claude.json'), JSON.stringify({
      userID: 'a'.repeat(64),
      oauthAccount: { emailAddress: 'work@x.com' },
    }));
    // accounts dir so the statusline doesn't error on fallback/apikey checks
    fs.mkdirSync(path.join(tmpHome, '.claude', 'accounts'), { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('without CLAUDE_CONFIG_DIR — reads the global email', () => {
    const got = runStatusline(tmpHome);
    assert.strictEqual(got.email, 'global@x.com');
    assert.strictEqual(got.profile, null);
  });

  it('with CLAUDE_CONFIG_DIR pointing into the profiles tree — reads the PROFILE email', () => {
    const got = runStatusline(tmpHome, profileDir);
    // The actual session identity is the profile's account, not the global.
    // Pre-13.1 this showed 'global@x.com' here — the regression we're locking.
    assert.strictEqual(got.email, 'work@x.com',
      'statusline must reflect profile identity when CCD points into profilesDir');
    assert.strictEqual(got.profile, 'workprofile');
  });

  it('with CLAUDE_CONFIG_DIR outside the profiles tree — falls back to the global path', () => {
    // User points CCD at some custom dir for their own purposes. The
    // statusline should not silently assume profile identity; profile
    // detection is scoped to claude-switch's profiles dir.
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-custom-'));
    fs.writeFileSync(path.join(customDir, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'custom@x.com' },
    }));
    try {
      const got = runStatusline(tmpHome, customDir);
      // Email comes from the GLOBAL file (the CCD is non-profile, so we
      // intentionally don't redirect identity reads). profile badge null.
      assert.strictEqual(got.email, 'global@x.com');
      assert.strictEqual(got.profile, null);
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Proxy runtime mode reflected in statusline label
// ---------------------------------------------------------------------------

describe('statusline — proxy runtime mode (Phase 13.6)', () => {
  let tmpHome: string;
  let accountsDir: string;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-mode-'));
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'rtmode@x.com' },
    }));
    accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterEach(() => {
    // Clean any marker the previous test wrote so each scenario starts
    // from a known state — no inherited file across runs.
    try { fs.unlinkSync(path.join(accountsDir, '.proxy-mode.json')); } catch { /* may not exist */ }
  });

  it('renders effectiveMode=oauth when no proxy marker exists (legacy path)', () => {
    const got = runStatusline(tmpHome);
    assert.strictEqual(got.email, 'rtmode@x.com');
    assert.strictEqual(got.effectiveMode, 'oauth',
      'no marker + no fallback flag = back-compat oauth label');
    assert.strictEqual(got.proxyRuntimeMode, null);
  });

  it('renders effectiveMode=oauth-burst when proxy marker says oauth-burst', () => {
    fs.writeFileSync(path.join(accountsDir, '.proxy-mode.json'), JSON.stringify({
      mode: 'oauth-burst',
      updatedAt: Date.now(),
      lastReason: '3 consecutive OAuth failures',
    }));
    const got = runStatusline(tmpHome);
    assert.strictEqual(got.effectiveMode, 'oauth-burst');
    assert.strictEqual(got.proxyRuntimeMode, 'oauth-burst');
  });

  it('falls back to the persistent flag when the marker is stale (>10 min)', () => {
    // Simulate a crashed proxy that left a stale burst marker behind.
    // Statusline must NOT trust it — show what the persistent flag says
    // (no fallback flag set → back-compat oauth).
    fs.writeFileSync(path.join(accountsDir, '.proxy-mode.json'), JSON.stringify({
      mode: 'oauth-burst',
      updatedAt: Date.now() - 11 * 60 * 1000,
    }));
    const got = runStatusline(tmpHome);
    assert.strictEqual(got.effectiveMode, 'oauth',
      'stale marker must not sticky-display the wrong mode');
    assert.strictEqual(got.proxyRuntimeMode, null);
  });
});
