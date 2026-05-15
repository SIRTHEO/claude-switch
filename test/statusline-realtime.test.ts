// test/statusline-realtime.test.ts
// E2E realtime statusline bundle.
//
// Three scenarios:
//   A — switch A→B in shell + statusline reload + check badge updated
//   B — profile C session shows C's account, not the global account
//   C — proxy in API burst → statusline shows oauth-burst / OAuth↻API
//
// All scenarios run against `dist/bin/cli.js` (post-build) and use
// fully-isolated tmp directories. No writes touch the real ~/.claude.json.

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When compiled, test files live in dist/test/. Resolve two levels up to
// reach the repo root, then point at dist/bin/cli.js — matching the pattern
// from test/statusline-profile.test.ts.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'dist', 'bin', 'cli.js');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface StatuslineJson {
  email: string | null;
  shortName?: string;
  mode?: string | null;
  effectiveMode?: 'oauth' | 'oauth-burst' | 'api-auto' | 'api';
  proxyRuntimeMode?: string | null;
  fallback?: boolean;
  hasApiKey?: boolean;
  profile?: string | null;
  fiveHour?: number | null;
  sevenDay?: number | null;
}

/**
 * Invoke `claude switch statusline --json --no-color` in an isolated env.
 * `home`       — HOME for the subprocess
 * `configDir` — CLAUDE_CONFIG_DIR override (profile scenario)
 * `accountsDir` — overrides the accounts directory derivation; when omitted
 *                the default `<home>/.claude/accounts` is used implicitly
 *                through the HOME + standard accounts-dir resolution.
 */
function runStatusline(
  home: string,
  opts: { configDir?: string } = {},
): StatuslineJson {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_SWITCH_DISABLE_KEYCHAIN: '1',
  };
  if (opts.configDir) {
    env.CLAUDE_CONFIG_DIR = opts.configDir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }
  const r = spawnSync(process.execPath, [CLI, 'switch', 'statusline', '--json', '--no-color'], {
    env,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (r.error) throw r.error;
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as StatuslineJson;
}

/**
 * Invoke `claude switch <target>` in an isolated env (no Keychain, no real
 * HOME). Used for Scenario A to verify that a switch command updates the
 * active account in `.claude.json`.
 */
function runSwitch(home: string, target: string): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_SWITCH_DISABLE_KEYCHAIN: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, [CLI, 'switch', target], {
    env,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (r.error) throw r.error;
  return { status: r.status, stderr: r.stderr };
}

/**
 * Replicate the private `cachePathFor(accountsDirPath, email)` logic from
 * `src/usage.ts` so we can pre-populate per-account cache files in tests
 * without exporting an internal function.
 *
 * Algorithm: sha256(email).slice(0,16) → filename `.usage-cache.<hash>.json`
 */
function cachePathFor(accountsDirPath: string, email: string): string {
  const hash = createHash('sha256').update(email).digest('hex').slice(0, 16);
  return path.join(accountsDirPath, `.usage-cache.${hash}.json`);
}

/**
 * Write a fresh per-account usage cache entry.
 */
function writeUsageCache(
  accountsDirPath: string,
  email: string,
  fiveHourPct: number,
  sevenDayPct: number,
): void {
  fs.mkdirSync(accountsDirPath, { recursive: true });
  const cache = {
    fetchedAt: Date.now(),
    account: email,
    payload: {
      five_hour: { utilization: fiveHourPct },
      seven_day: { utilization: sevenDayPct },
    },
  };
  fs.writeFileSync(cachePathFor(accountsDirPath, email), JSON.stringify(cache));
}

/**
 * Write a minimal account data file under `<accountsDir>/<email>.json` so
 * `claude switch <email>` can discover and switch to the account.
 */
function writeAccountFile(accountsDirPath: string, email: string): void {
  fs.mkdirSync(accountsDirPath, { recursive: true });
  fs.writeFileSync(
    path.join(accountsDirPath, `${email}.json`),
    JSON.stringify({ emailAddress: email }),
  );
}

// ---------------------------------------------------------------------------
// Scenario A — switch A→B, statusline reflects the active account
// ---------------------------------------------------------------------------

describe('statusline realtime — Scenario A: switch A→B + badge update', () => {
  let tmpHome: string;
  let accountsDir: string;

  const emailA = 'sirtheo.work@example.com';
  const emailB = 'sirtheo.personal@example.com';

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-rt-a-'));
    accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });

    // Pre-populate per-account caches: A @ 30%/40%, B @ 60%/70%
    writeUsageCache(accountsDir, emailA, 30, 40);
    writeUsageCache(accountsDir, emailB, 60, 70);

    // Register both accounts in the accounts dir
    writeAccountFile(accountsDir, emailA);
    writeAccountFile(accountsDir, emailB);

    // Start with account A active
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: emailA },
    }));
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('statusline shows account A (30%) before any switch', () => {
    const got = runStatusline(tmpHome);
    assert.strictEqual(got.email, emailA, 'active account must be A initially');
    assert.strictEqual(got.fiveHour, 30, 'five-hour usage must be 30% for account A');
  });

  it('after switching to B, statusline reflects B (60%)', () => {
    const sw = runSwitch(tmpHome, emailB);
    assert.strictEqual(sw.status, 0, `claude switch ${emailB} must exit 0, stderr: ${sw.stderr}`);

    const got = runStatusline(tmpHome);
    assert.strictEqual(got.email, emailB, 'active account must be B after switch');
    assert.strictEqual(got.fiveHour, 60, 'five-hour usage must be 60% for account B');
  });

  it('after switching back to A, statusline reflects A (30%) again', () => {
    // Switch B → A
    const sw = runSwitch(tmpHome, emailA);
    assert.strictEqual(sw.status, 0, `claude switch ${emailA} must exit 0, stderr: ${sw.stderr}`);

    const got = runStatusline(tmpHome);
    assert.strictEqual(got.email, emailA, 'active account must be A again');
    assert.strictEqual(got.fiveHour, 30, 'five-hour usage must be 30% for account A');
  });
});

// ---------------------------------------------------------------------------
// Scenario B — profile C session shows C's account, not the global account
// ---------------------------------------------------------------------------

describe('statusline realtime — Scenario B: profile session shows profile account', () => {
  let tmpHome: string;
  let profileCDir: string;

  const emailGlobal = 'sirtheo.work@example.com';
  const emailC = 'sirtheo.personal@example.com';

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-rt-b-'));

    // Global account A
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: emailGlobal },
    }));

    // Accounts dir for global fallback/apikey checks
    const accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });

    // Profile C — uses emailC, lives in ~/.claude/profiles/profileC/
    profileCDir = path.join(tmpHome, '.claude', 'profiles', 'profileC');
    fs.mkdirSync(profileCDir, { recursive: true });
    fs.writeFileSync(path.join(profileCDir, '.claude.json'), JSON.stringify({
      userID: 'c'.repeat(64),
      oauthAccount: { emailAddress: emailC },
    }));
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('statusline without CLAUDE_CONFIG_DIR shows the global account', () => {
    const got = runStatusline(tmpHome);
    assert.strictEqual(got.email, emailGlobal, 'without CCD, global account must be shown');
    assert.strictEqual(got.profile, null);
  });

  it('statusline with CLAUDE_CONFIG_DIR=profileC shows emailC, not the global account (Phase 13.1 fix)', () => {
    const got = runStatusline(tmpHome, { configDir: profileCDir });
    assert.strictEqual(
      got.email,
      emailC,
      'statusline must reflect profile identity when CCD points into profilesDir; pre-13.1 showed the global account',
    );
    assert.notStrictEqual(got.email, emailGlobal, 'must NOT show the global account in a profile session');
    assert.strictEqual(got.profile, 'profileC', 'profile badge must reflect the active profile name');
  });
});

// ---------------------------------------------------------------------------
// Scenario C — proxy in oauth-burst → statusline shows `oauth-burst` / OAuth↻API
// ---------------------------------------------------------------------------

describe('statusline realtime — Scenario C: proxy oauth-burst mode reflected', () => {
  let tmpHome: string;
  let accountsDir: string;

  const email = 'sirtheo.work@example.com';

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-rt-c-'));
    accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });

    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: email },
    }));
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterEach(() => {
    // Remove any marker between tests so each scenario starts clean
    try { fs.unlinkSync(path.join(accountsDir, '.proxy-mode.json')); } catch { /* may not exist */ }
  });

  it('without proxy marker, shows effectiveMode=oauth (back-compat)', () => {
    const got = runStatusline(tmpHome);
    assert.strictEqual(got.email, email);
    assert.strictEqual(got.effectiveMode, 'oauth', 'no marker + no fallback = oauth');
    assert.strictEqual(got.proxyRuntimeMode, null);
  });

  it('with oauth-burst proxy marker, shows proxyRuntimeMode=oauth-burst and effectiveMode=oauth-burst', () => {
    // Setup: write the proxy-mode.json marker as if the proxy transitioned to burst
    const marker = {
      mode: 'oauth-burst',
      updatedAt: Date.now(),
      lastReason: 'simulated oauth burst for E2E test',
    };
    fs.writeFileSync(path.join(accountsDir, '.proxy-mode.json'), JSON.stringify(marker));

    const got = runStatusline(tmpHome);
    assert.strictEqual(got.proxyRuntimeMode, 'oauth-burst',
      'proxyRuntimeMode must echo the marker mode');
    assert.strictEqual(got.effectiveMode, 'oauth-burst',
      'effectiveMode must be oauth-burst when the proxy marker says so');
  });

  it('stale proxy marker (>10 min old) is ignored — falls back to oauth', () => {
    // Simulate a crashed proxy that left a stale oauth-burst marker
    const staleMarker = {
      mode: 'oauth-burst',
      updatedAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago
    };
    fs.writeFileSync(path.join(accountsDir, '.proxy-mode.json'), JSON.stringify(staleMarker));

    const got = runStatusline(tmpHome);
    assert.strictEqual(got.effectiveMode, 'oauth',
      'stale marker must not sticky-display the wrong mode');
    assert.strictEqual(got.proxyRuntimeMode, null,
      'stale marker must not be surfaced in proxyRuntimeMode');
  });
});
