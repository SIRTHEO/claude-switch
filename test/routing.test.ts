// test/routing.test.ts
// Coverage for src/routing.ts — pure resolver, schema validators, glob
// expansion, .claude-switch discovery, resolution matrix.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  expandPattern,
  globToRegExp,
  parseClaudeSwitchFile,
  parseRoutingFile,
  findClaudeSwitchFile,
  resolveRouting,
} from '../src/routing.js';

const FAKE_HOME_PARENT = path.join(os.tmpdir(), 'cs-routing-test');

function mkdir(p: string): string {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe('globToRegExp', () => {
  it('matches literal paths', () => {
    assert.equal(globToRegExp('/work').test('/work'), true);
    assert.equal(globToRegExp('/work').test('/personal'), false);
  });

  it('* matches within a single segment', () => {
    const re = globToRegExp('/x/*');
    assert.equal(re.test('/x/foo'), true);
    assert.equal(re.test('/x/foo/bar'), false); // separator blocked
  });

  it('** matches across segments', () => {
    const re = globToRegExp('/x/**');
    assert.equal(re.test('/x'), true);
    assert.equal(re.test('/x/a'), true);
    assert.equal(re.test('/x/a/b/c'), true);
  });

  it('? matches a single non-separator character', () => {
    const re = globToRegExp('/a?');
    assert.equal(re.test('/ab'), true);
    assert.equal(re.test('/abc'), false);
    assert.equal(re.test('/a/b'), false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const re = globToRegExp('/a.b+c');
    assert.equal(re.test('/a.b+c'), true);
    assert.equal(re.test('/aXb+c'), false); // `.` shouldn't match X
  });
});

// expandPattern + the resolveRouting groups below rely on Unix-style
// absolute paths (`/home/u/work/**`) as fixtures. On Windows,
// `path.isAbsolute('/home/u/work/**')` returns true but `path.resolve`
// reinterprets it relative to the current drive, so the test
// expectations no longer hold. The runtime feature still works on
// Windows when the user supplies native paths (`C:\Users\...`); only
// these specific test fixtures are platform-coupled. Skipping on
// Windows is the pragmatic call until/unless the routing tests are
// rewritten with `path.posix.*` helpers.
const skipOnWindows = { skip: process.platform === 'win32' };

describe('expandPattern', skipOnWindows, () => {
  const home = '/home/u';

  it('expands ~/ prefix to home', () => {
    assert.equal(expandPattern('~/work/**', home), '/home/u/work/**');
  });

  it('handles bare ~', () => {
    assert.equal(expandPattern('~', home), '/home/u');
  });

  it('rejects patterns escaping home via ..', () => {
    assert.equal(expandPattern('~/../etc/**', home), null);
  });

  it('rejects absolute patterns outside home', () => {
    assert.equal(expandPattern('/etc/**', home), null);
  });

  it('accepts absolute patterns inside home', () => {
    assert.equal(expandPattern('/home/u/work/**', home), '/home/u/work/**');
  });

  it('rejects empty patterns', () => {
    assert.equal(expandPattern('', home), null);
  });
});

describe('parseClaudeSwitchFile', () => {
  it('accepts an empty match-less object', () => {
    const r = parseClaudeSwitchFile('{}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, {});
  });

  it('accepts emailDomain match', () => {
    const r = parseClaudeSwitchFile('{"match":{"emailDomain":"acme.com"}}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value!.match, { emailDomain: 'acme.com' });
  });

  it('accepts email match', () => {
    const r = parseClaudeSwitchFile('{"match":{"email":"a@b.com"}}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value!.match, { email: 'a@b.com' });
  });

  it('accepts disable: true and ignores siblings', () => {
    const r = parseClaudeSwitchFile('{"match":{"disable":true,"emailDomain":"x.com"}}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value!.match, { disable: true });
  });

  it('accepts nested any', () => {
    const r = parseClaudeSwitchFile(
      '{"match":{"any":[{"emailDomain":"a.com"},{"emailDomain":"b.com"}]}}',
    );
    assert.equal(r.ok, true);
    assert.equal(r.value!.match!.any!.length, 2);
  });

  it('rejects invalid JSON', () => {
    const r = parseClaudeSwitchFile('{ not json');
    assert.equal(r.ok, false);
    assert.match(r.error!, /invalid JSON/);
  });

  it('rejects match without any criterion', () => {
    const r = parseClaudeSwitchFile('{"match":{}}');
    assert.equal(r.ok, false);
  });

  it('rejects array as top-level', () => {
    const r = parseClaudeSwitchFile('[]');
    assert.equal(r.ok, false);
  });
});

describe('parseRoutingFile', () => {
  it('accepts empty rules', () => {
    const r = parseRoutingFile('{"version":1,"rules":[]}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { version: 1, rules: [] });
  });

  it('accepts a rule with account', () => {
    const r = parseRoutingFile('{"version":1,"rules":[{"match":"~/work/**","account":"a@b.com"}]}');
    assert.equal(r.ok, true);
    assert.equal(r.value!.rules[0]!.account, 'a@b.com');
  });

  it('accepts a rule with alias', () => {
    const r = parseRoutingFile('{"version":1,"rules":[{"match":"~/work/**","alias":"work"}]}');
    assert.equal(r.ok, true);
    assert.equal(r.value!.rules[0]!.alias, 'work');
  });

  it('rejects a rule with both account AND alias', () => {
    const r = parseRoutingFile(
      '{"version":1,"rules":[{"match":"x","account":"a@b.com","alias":"w"}]}',
    );
    assert.equal(r.ok, false);
  });

  it('rejects a rule with neither account NOR alias', () => {
    const r = parseRoutingFile('{"version":1,"rules":[{"match":"x"}]}');
    assert.equal(r.ok, false);
  });

  it('rejects unsupported version', () => {
    const r = parseRoutingFile('{"version":2,"rules":[]}');
    assert.equal(r.ok, false);
  });

  it('rejects missing rules array', () => {
    const r = parseRoutingFile('{"version":1}');
    assert.equal(r.ok, false);
  });
});

describe('findClaudeSwitchFile', () => {
  let home: string;
  let repo: string;

  before(() => {
    mkdir(FAKE_HOME_PARENT);
    home = mkdir(path.join(FAKE_HOME_PARENT, 'home'));
    repo = mkdir(path.join(home, 'work', 'project'));
    mkdir(path.join(repo, '.git'));
    writeFile(path.join(repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');
  });

  after(() => {
    fs.rmSync(FAKE_HOME_PARENT, { recursive: true, force: true });
  });

  it('finds the file at the cwd itself', () => {
    const found = findClaudeSwitchFile(repo, home);
    assert.equal(found, path.join(repo, '.claude-switch'));
  });

  it('walks up to find a parent file', () => {
    const sub = mkdir(path.join(repo, 'src', 'deep'));
    const found = findClaudeSwitchFile(sub, home);
    assert.equal(found, path.join(repo, '.claude-switch'));
  });

  it('stops at .git boundary', () => {
    const outerRepo = mkdir(path.join(home, 'outer'));
    mkdir(path.join(outerRepo, '.git'));
    writeFile(path.join(home, '.claude-switch'), '{"match":{"emailDomain":"x.com"}}');
    const found = findClaudeSwitchFile(outerRepo, home);
    // outer has its own .git, no .claude-switch in it; walk halts at the
    // boundary so the home-level file is NOT picked up.
    assert.equal(found, null);
    fs.unlinkSync(path.join(home, '.claude-switch'));
  });

  it('returns null when no file exists in the walk', () => {
    const orphan = mkdir(path.join(home, 'orphan'));
    assert.equal(findClaudeSwitchFile(orphan, home), null);
  });
});

describe('resolveRouting — env override', () => {
  const accountsDir = '/tmp/cs-routing-empty';

  beforeEach(() => {
    fs.rmSync(accountsDir, { recursive: true, force: true });
    fs.mkdirSync(accountsDir, { recursive: true });
  });

  it('uses CLAUDE_SWITCH_ACCOUNT when it matches a saved email', () => {
    const r = resolveRouting({
      cwd: '/tmp',
      accountsDirPath: accountsDir,
      env: { CLAUDE_SWITCH_ACCOUNT: 'work@acme.com' },
      activeEmail: 'personal@gmail.com',
      savedEmails: ['work@acme.com', 'personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.email, 'work@acme.com');
    assert.equal(r?.source, 'env');
    assert.match(r?.banner ?? '', /CLAUDE_SWITCH_ACCOUNT/);
  });

  it('is silent when env matches the active email', () => {
    const r = resolveRouting({
      cwd: '/tmp',
      accountsDirPath: accountsDir,
      env: { CLAUDE_SWITCH_ACCOUNT: 'work@acme.com' },
      activeEmail: 'work@acme.com',
      savedEmails: ['work@acme.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.banner, undefined);
  });

  it('resolves env value via alias when not a direct email', () => {
    const r = resolveRouting({
      cwd: '/tmp',
      accountsDirPath: accountsDir,
      env: { CLAUDE_SWITCH_ACCOUNT: 'work' },
      activeEmail: 'personal@gmail.com',
      savedEmails: ['work@acme.com'],
      lastUsedByDomain: {},
      resolveAlias: (a) => (a === 'work' ? 'work@acme.com' : null),
    });
    assert.equal(r?.email, 'work@acme.com');
  });

  it('warns when env value is unresolvable', () => {
    const r = resolveRouting({
      cwd: '/tmp',
      accountsDirPath: accountsDir,
      env: { CLAUDE_SWITCH_ACCOUNT: 'ghost@nowhere.com' },
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.email, 'personal@gmail.com');
    assert.equal(r?.source, 'env');
    assert.match(r?.warning ?? '', /not a saved account/);
  });
});

describe('resolveRouting — .claude-switch in repo', () => {
  let home: string;
  let repo: string;
  let accountsDir: string;

  before(() => {
    mkdir(FAKE_HOME_PARENT);
    home = mkdir(path.join(FAKE_HOME_PARENT, 'home2'));
    repo = mkdir(path.join(home, 'work', 'proj'));
    mkdir(path.join(repo, '.git'));
    accountsDir = mkdir(path.join(home, '.claude', 'accounts'));
    writeFile(path.join(repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');
    // Pretend HOME so findClaudeSwitchFile uses it.
    process.env.HOME = home;
  });

  after(() => {
    fs.rmSync(FAKE_HOME_PARENT, { recursive: true, force: true });
    delete process.env.HOME;
  });

  beforeEach(() => {
    // No env override during this group.
  });

  it('active satisfies → silent', () => {
    const r = resolveRouting({
      cwd: repo,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'theo@acme.com',
      savedEmails: ['theo@acme.com', 'personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.email, 'theo@acme.com');
    assert.equal(r?.source, 'claude-switch-file');
    assert.equal(r?.banner, undefined);
  });

  it('exactly 1 match → switches with banner', () => {
    const r = resolveRouting({
      cwd: repo,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['theo@acme.com', 'personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.email, 'theo@acme.com');
    assert.match(r?.banner ?? '', /routed to theo@acme\.com/);
  });

  it('N matches → uses last-used among set', () => {
    const r = resolveRouting({
      cwd: repo,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['alice@acme.com', 'bob@acme.com', 'personal@gmail.com'],
      lastUsedByDomain: { 'acme.com': 'bob@acme.com' },
    });
    assert.equal(r?.email, 'bob@acme.com');
    assert.match(r?.banner ?? '', /last-used/);
  });

  it('N matches with no lastUsed → first alphabetical', () => {
    const r = resolveRouting({
      cwd: repo,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['bob@acme.com', 'alice@acme.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.email, 'alice@acme.com');
  });

  it('0 matches → warning + falls back to active', () => {
    const r = resolveRouting({
      cwd: repo,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.email, 'personal@gmail.com');
    assert.match(r?.warning ?? '', /no saved account matches/);
  });

  it('disable: true → returns null', () => {
    writeFile(path.join(repo, '.claude-switch'), '{"match":{"disable":true}}');
    const r = resolveRouting({
      cwd: repo,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['theo@acme.com', 'personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r, null);
    // Restore the file for other tests in this group (none after, but
    // future-proofing).
    writeFile(path.join(repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');
  });

  it('malformed file → warning, falls back to active', () => {
    writeFile(path.join(repo, '.claude-switch'), '{ broken');
    const r = resolveRouting({
      cwd: repo,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.email, 'personal@gmail.com');
    assert.match(r?.warning ?? '', /unreadable/);
    writeFile(path.join(repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');
  });
});

describe('resolveRouting — global rules', skipOnWindows, () => {
  let home: string;
  let workDir: string;
  let accountsDir: string;

  before(() => {
    mkdir(FAKE_HOME_PARENT);
    home = mkdir(path.join(FAKE_HOME_PARENT, 'home3'));
    workDir = mkdir(path.join(home, 'work', 'project'));
    accountsDir = mkdir(path.join(home, '.claude', 'accounts'));
    writeFile(
      path.join(accountsDir, '.routing.json'),
      JSON.stringify({
        version: 1,
        rules: [
          { match: '~/work/**', account: 'work@acme.com' },
        ],
      }),
    );
    process.env.HOME = home;
  });

  after(() => {
    fs.rmSync(FAKE_HOME_PARENT, { recursive: true, force: true });
    delete process.env.HOME;
  });

  it('matches a glob and routes', () => {
    const r = resolveRouting({
      cwd: workDir,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['work@acme.com', 'personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.email, 'work@acme.com');
    assert.equal(r?.source, 'global-rules');
  });

  it('no matching rule → returns null', () => {
    const r = resolveRouting({
      cwd: home,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['work@acme.com', 'personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r, null);
  });

  it('rule references unsaved account → skipped, falls through', () => {
    writeFile(
      path.join(accountsDir, '.routing.json'),
      JSON.stringify({
        version: 1,
        rules: [{ match: '~/work/**', account: 'ghost@nowhere.com' }],
      }),
    );
    const r = resolveRouting({
      cwd: workDir,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r, null);
  });

  it('rule alias is resolved via resolveAlias', () => {
    writeFile(
      path.join(accountsDir, '.routing.json'),
      JSON.stringify({
        version: 1,
        rules: [{ match: '~/work/**', alias: 'work' }],
      }),
    );
    const r = resolveRouting({
      cwd: workDir,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['work@acme.com'],
      lastUsedByDomain: {},
      resolveAlias: (a) => (a === 'work' ? 'work@acme.com' : null),
    });
    assert.equal(r?.email, 'work@acme.com');
  });
});

describe('resolveRouting — precedence (env > .claude-switch > global)', () => {
  let home: string;
  let workDir: string;
  let accountsDir: string;

  before(() => {
    mkdir(FAKE_HOME_PARENT);
    home = mkdir(path.join(FAKE_HOME_PARENT, 'home4'));
    workDir = mkdir(path.join(home, 'work', 'project'));
    mkdir(path.join(workDir, '.git'));
    accountsDir = mkdir(path.join(home, '.claude', 'accounts'));
    writeFile(
      path.join(workDir, '.claude-switch'),
      '{"match":{"emailDomain":"acme.com"}}',
    );
    writeFile(
      path.join(accountsDir, '.routing.json'),
      JSON.stringify({
        version: 1,
        rules: [{ match: '~/work/**', account: 'global@example.com' }],
      }),
    );
    process.env.HOME = home;
  });

  after(() => {
    fs.rmSync(FAKE_HOME_PARENT, { recursive: true, force: true });
    delete process.env.HOME;
  });

  it('env beats both file and global', () => {
    const r = resolveRouting({
      cwd: workDir,
      accountsDirPath: accountsDir,
      env: { CLAUDE_SWITCH_ACCOUNT: 'global@example.com' },
      activeEmail: 'personal@gmail.com',
      savedEmails: ['global@example.com', 'theo@acme.com', 'personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.source, 'env');
  });

  it('.claude-switch beats global rules', () => {
    const r = resolveRouting({
      cwd: workDir,
      accountsDirPath: accountsDir,
      env: {},
      activeEmail: 'personal@gmail.com',
      savedEmails: ['global@example.com', 'theo@acme.com', 'personal@gmail.com'],
      lastUsedByDomain: {},
    });
    assert.equal(r?.source, 'claude-switch-file');
    assert.equal(r?.email, 'theo@acme.com');
  });
});
