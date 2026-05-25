// test/passthrough-routing.test.ts
// Integration coverage for resolveRoutingForPassthrough — the helper
// that runs inside the passthrough snapshot lock and performs the
// in-lock save/load swap when project-aware routing decides on a
// different account.

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
    claudeJsonPath: f.claudeJson,
    cwd: f.repo,
    initialEmail: email,
    savedEmails: saved,
  };
}

// Capture initial env state at module load time so after() can restore it.
const savedHomeInitial: SavedHome = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const ORIGINAL_SWITCH_ACCOUNT = process.env.CLAUDE_SWITCH_ACCOUNT;

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
    assert.equal(r.flipped, false);
  });

  it('flips active when .claude-switch matches a different saved account', () => {
    const f = setupFixture('flip', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com', 'theo@acme.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com', 'theo@acme.com']),
    );
    assert.equal(r.flipped, true);
    assert.equal(r.decision?.email, 'theo@acme.com');
    assert.match(r.decision?.banner ?? '', /routed to theo@acme\.com/);
    assert.equal(getCurrent(f.claudeJson), 'theo@acme.com');
  });

  it('does not flip when active already satisfies', () => {
    const f = setupFixture('already-active', {
      activeEmail: 'theo@acme.com',
      savedEmails: ['theo@acme.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'theo@acme.com', ['theo@acme.com']),
    );
    assert.equal(r.flipped, false);
    assert.equal(r.decision?.email, 'theo@acme.com');
    assert.equal(r.decision?.banner, undefined);
    assert.equal(getCurrent(f.claudeJson), 'theo@acme.com');
  });

  it('emits warning + does NOT flip on 0-match', () => {
    const f = setupFixture('no-match-warn', {
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com'],
    });
    setFakeHome(f.home);
    writeFile(path.join(f.repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');

    const r = resolveRoutingForPassthrough(
      baseInput(f, 'personal@gmail.com', ['personal@gmail.com']),
    );
    assert.equal(r.flipped, false);
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
    assert.equal(r.flipped, false);
    assert.equal(getCurrent(f.claudeJson), 'personal@gmail.com');
  });

  it('emits isolatedHint when target has defaultIsolated:true', () => {
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
    assert.equal(r.flipped, false);
    assert.match(r.isolatedHint ?? '', /isolated/);
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
    assert.equal(r.flipped, true);
    assert.equal(r.decision?.email, 'bob@other.com');
    assert.equal(getCurrent(f.claudeJson), 'bob@other.com');
  });

  it('updates lastUsedByDomain after a domain-constrained flip', () => {
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

    // state.json should now record acme.com → alice.
    const stateRaw = JSON.parse(
      fs.readFileSync(path.join(f.accountsDir, '.claude-switch-state.json'), 'utf-8'),
    );
    assert.equal(stateRaw.lastUsedByDomain?.['acme.com'], 'alice@acme.com');

    // Second call from active=alice should be silent (already satisfies).
    const r2 = resolveRoutingForPassthrough(
      baseInput(f, 'alice@acme.com', ['personal@gmail.com', 'alice@acme.com', 'bob@acme.com']),
    );
    assert.equal(r2.flipped, false);
  });
});
