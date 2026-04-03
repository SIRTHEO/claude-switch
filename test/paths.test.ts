// test/paths.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeJsonPath, accountsDir, claudeBinFile } from '../src/paths.js';
import os from 'node:os';
import path from 'node:path';

describe('paths', () => {
  it('claudeJsonPath points to ~/.claude.json', () => {
    assert.equal(claudeJsonPath(), path.join(os.homedir(), '.claude.json'));
  });

  it('accountsDir points to ~/.claude/accounts', () => {
    assert.equal(accountsDir(), path.join(os.homedir(), '.claude', 'accounts'));
  });

  it('claudeBinFile points to ~/.claude/accounts/.claude-bin', () => {
    assert.equal(claudeBinFile(), path.join(os.homedir(), '.claude', 'accounts', '.claude-bin'));
  });
});
