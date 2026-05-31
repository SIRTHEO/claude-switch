// test/commands-default.test.ts
// Coverage for `claude switch default <name>` — the default-pointer re-point
// verb (slice 4a). handleDefaultSet validates the target and persists the
// pointer via setDefaultPointer; the bare-`claude` divert (tested in
// passthrough-pointer.test.ts) is what then acts on it.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleDefaultSet } from '../src/commands/default-pointer.js';
import { readDefaultPointer } from '../src/profiles/workspaces.js';
import { createProfile } from '../src/profiles/profiles.js';
import { ExitError } from '../src/platform/errors.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

describe('handleDefaultSet', () => {
  let home: string;
  let accDir: string;
  let savedHome: SavedHome;
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-default-'));
    savedHome = setFakeHome(home);
    accDir = path.join(home, '.claude', 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
    logs = [];
    origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  });

  afterEach(() => {
    console.log = origLog;
    restoreFakeHome(savedHome);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('re-points to an existing profile and confirms', async () => {
    createProfile('work');
    await handleDefaultSet(accDir, 'work');
    assert.equal(readDefaultPointer(accDir), 'work');
    assert.match(logs.join('\n'), /profile "work"/);
  });

  it("re-points to the global with 'default'", async () => {
    createProfile('work');
    await handleDefaultSet(accDir, 'work');
    await handleDefaultSet(accDir, 'default');
    assert.equal(readDefaultPointer(accDir), 'default');
    assert.match(logs.join('\n'), /global account/);
  });

  it('throws ExitError on an unknown profile and leaves the pointer at default', async () => {
    await assert.rejects(() => handleDefaultSet(accDir, 'ghost'), ExitError);
    assert.equal(readDefaultPointer(accDir), 'default');
  });
});
