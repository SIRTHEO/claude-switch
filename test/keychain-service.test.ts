// test/keychain-service.test.ts
// Unit coverage for the per-config-dir Keychain service-name formula.
//
// Pins the contract that lets us land profile credentials at the
// service Claude Code v2.x actually queries:
//
//   service = `Claude Code-credentials${configDir ? '-' + sha256(configDir).hex.slice(0,8) : ''}`
//   account = process.env.USER || os.userInfo().username
//
// Reverse-engineered from the production claude binary (the `My()` and
// `uV()` helpers in Bun-bundled JS). If Anthropic changes the formula
// in a future release, this test is the canary that should fail first.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  claudeKeychainServiceFor,
  claudeKeychainAccount,
} from '../src/keychain.js';

describe('claudeKeychainServiceFor', () => {
  it('returns the bare credentials service when no config dir is given', () => {
    assert.equal(claudeKeychainServiceFor(null), 'Claude Code-credentials');
    assert.equal(claudeKeychainServiceFor(undefined), 'Claude Code-credentials');
    assert.equal(claudeKeychainServiceFor(''), 'Claude Code-credentials');
  });

  it('appends the first 8 hex chars of the SHA-256 of the (NFC-normalised) absolute path', () => {
    const dir = '/Users/anyone/.claude/profiles/work';
    const expectedHash = createHash('sha256').update(dir).digest('hex').substring(0, 8);
    assert.equal(claudeKeychainServiceFor(dir), `Claude Code-credentials-${expectedHash}`);
  });

  it('produces stable output for paths that already are normalised', () => {
    // Sanity: identical input string → identical hash on every run.
    const dir = '/Users/x/.claude/profiles/p1';
    const a = claudeKeychainServiceFor(dir);
    const b = claudeKeychainServiceFor(dir);
    assert.equal(a, b);
    // 8 hex chars after the prefix, followed by nothing.
    assert.match(a, /^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  it('different paths produce different services (collision sanity)', () => {
    const a = claudeKeychainServiceFor('/Users/x/.claude/profiles/work');
    const b = claudeKeychainServiceFor('/Users/x/.claude/profiles/personal');
    assert.notEqual(a, b);
  });

  it('does NOT collapse syntactic path noise (claude itself only NFC-normalises)', () => {
    // claude's resolution is `process.env.CLAUDE_CONFIG_DIR.normalize("NFC")`
    // — no `path.normalize`, no `path.resolve`, no `realpath`. So
    // `/foo/./bar` and `/foo/bar` are different services. The contract
    // for callers is "always pass the canonical path that the eventual
    // spawn will set CLAUDE_CONFIG_DIR to". We pin that here so a
    // future refactor doesn't sneak in a path.normalize and silently
    // break compat with the binary.
    const a = claudeKeychainServiceFor('/Users/x/.claude/profiles/work');
    const b = claudeKeychainServiceFor('/Users/x/./.claude//profiles/work/');
    assert.notEqual(a, b);
  });
});

describe('claudeKeychainAccount', () => {
  it('returns the OS username when process.env.USER is set', () => {
    const orig = process.env.USER;
    process.env.USER = 'svc-account';
    try {
      assert.equal(claudeKeychainAccount(), 'svc-account');
    } finally {
      if (orig === undefined) delete process.env.USER;
      else process.env.USER = orig;
    }
  });

  it('substitutes the safe fallback when env is empty AND username is not unix-shaped', () => {
    const orig = process.env.USER;
    process.env.USER = '';
    try {
      // Whatever os.userInfo().username produces in tests is OS-dependent
      // — we only assert the contract: the result either matches the
      // unix-username regex or equals the documented fallback.
      const account = claudeKeychainAccount();
      assert.ok(/^[a-zA-Z0-9._-]+$/.test(account) || account === 'claude-code-user',
        `expected unix-shape username or fallback — got "${account}"`);
    } finally {
      if (orig === undefined) delete process.env.USER;
      else process.env.USER = orig;
    }
  });
});
