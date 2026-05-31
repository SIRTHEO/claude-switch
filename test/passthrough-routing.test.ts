// test/passthrough-routing.test.ts
// Integration coverage for resolveRoutingForPassthrough — the synchronous
// helper that runs inside the passthrough snapshot lock. Under the unified
// profile model (decision B2) it NEVER swaps the global account: a cwd rule
// pointing at a different account yields an isolated-launch signal instead —
// `launchIsolated` when a logged-in overlay already exists, else `mintIsolated`
// for the handler to create-on-demand off the lock. The async mint itself is
// covered in passthrough-isolate.test.ts (the handler path).

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveRoutingForPassthrough,
  type RoutingForPassthroughInput,
} from '../src/commands/passthrough.js';
import { getCurrent, save } from '../src/accounts/accounts.js';
import { writeStoredAccountPrefs } from '../src/switching/preferences.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

const ROOT = path.join(os.tmpdir(), 'cs-passthrough-routing');

function mkdir(p: string): string {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

interface Fixture {
  home: string;
  accountsDir: string;
  claudeJson: string;
  repo: string;
}

function setupFixture(name: string, opts?: { activeEmail?: string; savedEmails?: string[] }): Fixture {
  const home = mkdir(path.join(ROOT, name));
  const accountsDir = mkdir(path.join(home, '.claude', 'accounts'));
  const claudeJson = path.join(home, '.claude.json');

  // Seed claude.json with an oauthAccount the way Claude Code itself would.
  const active = opts?.activeEmail ?? '';
  writeFile(claudeJson, JSON.stringify(active ? { oauthAccount: { emailAddress: active } } : {}));

  // Seed saved account files. We run with CLAUDE_SWITCH_DISABLE_KEYCHAIN=1
  // (set by `npm test`) so save() will skip the Keychain branch and the
  // test remains deterministic across machines.
  for (const email of opts?.savedEmails ?? []) {
    // Temporarily flip claude.json to that email so save() snapshots the
    // right oauthAccount, then put it back.
    writeFile(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
    save(email, claudeJson, accountsDir);
  }
  // Restore the active claude.json.
  writeFile(claudeJson, JSON.stringify(active ? { oauthAccount: { emailAddress: active } } : {}));

  const repo = mkdir(path.join(home, 'work', 'project'));
  mkdir(path.join(repo, '.git'));

  return { home, accountsDir, claudeJson, repo };
}

function cleanup(): void {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

function baseInput(f: Fixture, email: string | null, saved: string[]): RoutingForPassthroughInput {
  return {
    accountsDirPath: f.accountsDir,
    cwd: f.repo,
    initialEmail: email,
    savedEmails: saved,
  };
}

// Capture initial env state at module load time so after() can restore it.
const savedHomeInitial: SavedHome = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const ORIGINAL_SWITCH_ACCOUNT = process.env.CLAUDE_SWITCH_ACCOUNT;

/** Seed a live, GLOBAL-bound session for `account` using this test process's
 *  pid (always alive, so listLiveSessions' real isProcessAlive keeps it). */
function seedLiveGlobalSession(f: Fixture, account: string): void {
  writeFile(
    path.join(f.accountsDir, '.sessions.json'),
    JSON.stringify([
      { pid: process.pid, account, configDir: null, isolated: false, cwd: f.repo, startedAt: 1 },
    ]),
  );
}

/** Create a logged-in overlay profile for `email` under the fake home. */
function createOverlay(f: Fixture, profileName: string, email: string): string {
  const dir = mkdir(path.join(f.home, '.claude', 'profiles', profileName));
  fs.writeFileSync(path.join(dir, '.cs-overlay'), '');
  writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  return dir;
}

describe('resolveRoutingForPassthrough', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_SWITCH_ACCOUNT;
  });

  before(() => {
    mkdir(ROOT);
  });

  after(() => {
    cleanup();
    restoreFakeHome(savedHomeInitial);
    if (ORIGINAL_CONFIG_DIR !== undefined) process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    if (ORIGINAL_SWITCH_ACCOUNT !== undefined) process.env.CLAUDE_SWITCH_ACCOUNT = ORIGINAL_SWITCH_ACCOUNT;
  });

  it('returns null decision when no routing source matches', () => {
    const f = setupFixture('no-match', {
      activeEmail: 'a@gmail.com',
      savedEmails: ['a@gmail.com'],
    });
    setFakeHome(f.home);
    const r = resolveRoutingForPassthrough(baseInput(f, 'a@gmail.com', ['a@gmail.com']));
    assert.equal(r.decision, null);
    assert.equal(r.launchIsolated, undefined);
    assert.equal(r.mintIsolated, undefined);
  });

  it('signals create-on-demand (no global swap) when .claude-switch matches a different saved account', () => {
    const f = setupFixture('flip', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'theo@acme.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'theo@acme.com']),
    );
    // No overlay exists → mint signal, not a launchIsolated.
    assert.equal(r.mintIsolated?.email, 'theo@acme.com');
    assert.equal(r.launchIsolated, undefined);
    assert.equal(r.decision?.email, 'theo@acme.com');
    assert.match(r.launchIsolatedBanner ?? '', /routed to theo@acme\.com/);
    // The global active was NOT swapped — routing is ephemeral (B2).
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });

  it('does not act when active already satisfies', () => {
    const f = setupFixture('already-active', {
      activeEmail: 'theo@acme.com',
      savedEmails: ['theo@acme.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'theo@acme.com', ['theo@acme.com']),
    );
    assert.equal(r.launchIsolated, undefined);
    assert.equal(r.mintIsolated, undefined);
    assert.equal(r.decision?.email, 'theo@acme.com');
    assert.equal(r.decision?.banner, undefined);
    assert.equal(getCurrent(f.claudeJson), 'theo@acme.com');
  });

  it('emits warning + does NOT act on 0-match', () => {
    const f = setupFixture('no-match-warn', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com']),
    );
    assert.equal(r.launchIsolated, undefined);
    assert.equal(r.mintIsolated, undefined);
    assert.match(r.decision?.warning ?? '', /no saved account matches/);
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });

  it('skips routing entirely when CLAUDE_CONFIG_DIR is set', () => {
    const f = setupFixture('in-profile', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'theo@acme.com'],
    });
    setFakeHome(f.home);
    process.env.CLAUDE_CONFIG_DIR = '/some/profile/dir';
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'theo@acme.com']),
    );
    assert.equal(r.decision, null);
    assert.equal(r.launchIsolated, undefined);
    assert.equal(r.mintIsolated, undefined);
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });

  it('signals create-on-demand with the "always isolated" banner when target has defaultIsolated:true', () => {
    const f = setupFixture('isolated-target', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'theo@acme.com'],
    });
    setFakeHome(f.home);
    writeStoredAccountPrefs('theo@acme.com', f.accountsDir, { defaultIsolated: true });
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'theo@acme.com']),
    );
    // No overlay yet → mint on demand (NOT the old hint-and-run-the-wrong-account).
    assert.equal(r.mintIsolated?.email, 'theo@acme.com');
    assert.match(r.launchIsolatedBanner ?? '', /always isolated/);
    // Active stays on personal — we did NOT silently flip into work.
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });

  it('CLAUDE_SWITCH_ACCOUNT env var beats .claude-switch', () => {
    const f = setupFixture('env-wins', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'alice@acme.com', 'bob@other.com'],
    });
    setFakeHome(f.home);
    process.env.CLAUDE_SWITCH_ACCOUNT = 'bob@other.com';
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'alice@acme.com', 'bob@other.com']),
    );
    assert.equal(r.mintIsolated?.email, 'bob@other.com');
    assert.equal(r.decision?.email, 'bob@other.com');
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });

  it('updates lastUsedByDomain after a domain-constrained route', () => {
    const f = setupFixture('last-used', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'alice@acme.com', 'bob@acme.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    // First call: N-match with no lastUsed → picks alphabetical first.
    const r1 = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'alice@acme.com', 'bob@acme.com']),
    );
    assert.equal(r1.decision?.email, 'alice@acme.com');
    assert.equal(r1.mintIsolated?.email, 'alice@acme.com');

    // state.json should now record acme.com → alice (routing memory survives,
    // it is NOT the sticky default-pointer).
    const stateRaw = JSON.parse(
      fs.readFileSync(path.join(f.accountsDir, '.claude-switch-state.json'), 'utf-8'),
    );
    assert.equal(stateRaw.lastUsedByDomain?.['acme.com'], 'alice@acme.com');

    // Second call from active=alice should be silent (already satisfies).
    const r2 = resolveRoutingForPassthrough(
      baseInput(f, 'alice@acme.com', ['personal@gmail.com', 'alice@acme.com', 'bob@acme.com']),
    );
    assert.equal(r2.mintIsolated, undefined);
    assert.equal(r2.launchIsolated, undefined);
  });

  // ── B2 — ephemeral isolated launch (never swaps the global) ──────────────

  it('launches isolated (no global swap) when an overlay is ready and a swap would clash', () => {
    const f = setupFixture('conflict-overlay', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'theo@acme.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');
    seedLiveGlobalSession(f, 'personal@gmail.com'); // another account live global-bound
    const overlayDir = createOverlay(f, 'acme-overlay', 'theo@acme.com');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'theo@acme.com']),
    );
    assert.deepEqual(r.launchIsolated, { email: 'theo@acme.com', configDir: overlayDir });
    assert.equal(r.mintIsolated, undefined);
    assert.match(r.launchIsolatedBanner ?? '', /isolated/);
    // The global active was NOT swapped — the live session keeps its token.
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });

  it('signals create-on-demand (no swap, no refusal) when a swap would clash and no overlay exists', () => {
    const f = setupFixture('conflict-no-overlay', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'theo@acme.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');
    seedLiveGlobalSession(f, 'personal@gmail.com');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'theo@acme.com']),
    );
    // The clash refusal is gone: an isolated launch never touches the live
    // session's tokens, so we mint on demand instead of refusing.
    assert.equal(r.mintIsolated?.email, 'theo@acme.com');
    assert.equal(r.launchIsolated, undefined);
    assert.match(r.launchIsolatedBanner ?? '', /token clash/);
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });

  it('does NOT treat a live session of the SAME target account as a clash', () => {
    const f = setupFixture('same-account-live', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'theo@acme.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');
    seedLiveGlobalSession(f, 'theo@acme.com'); // the live session IS the target

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'theo@acme.com']),
    );
    assert.equal(r.mintIsolated?.email, 'theo@acme.com');
    // Not flagged as a clash → the plain routing banner, not the clash one.
    assert.doesNotMatch(r.launchIsolatedBanner ?? '', /token clash/);
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });

  it('launches the overlay isolated for a defaultIsolated target even with no live clash', () => {
    const f = setupFixture('isolated-overlay', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'theo@acme.com'],
    });
    setFakeHome(f.home);
    writeStoredAccountPrefs('theo@acme.com', f.accountsDir, { defaultIsolated: true });
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');
    const overlayDir = createOverlay(f, 'acme-overlay', 'theo@acme.com');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'theo@acme.com']),
    );
    assert.deepEqual(r.launchIsolated, { email: 'theo@acme.com', configDir: overlayDir });
    assert.equal(r.mintIsolated, undefined);
    assert.match(r.launchIsolatedBanner ?? '', /always isolated/);
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });
});
