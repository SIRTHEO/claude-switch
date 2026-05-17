import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../bin/cli.js';

describe('parseCommand', () => {
  it('parses "switch" as interactive switch', () => {
    assert.deepEqual(parseCommand(['switch']), { action: 'switch-interactive' });
  });

  it('parses "switch add"', () => {
    assert.deepEqual(parseCommand(['switch', 'add']), { action: 'add' });
  });

  it('parses "switch list"', () => {
    assert.deepEqual(parseCommand(['switch', 'list']), { action: 'list', json: false });
  });

  it('parses "switch ls" as list', () => {
    assert.deepEqual(parseCommand(['switch', 'ls']), { action: 'list', json: false });
  });

  it('parses "switch list --json"', () => {
    assert.deepEqual(parseCommand(['switch', 'list', '--json']), { action: 'list', json: true });
  });

  it('parses "switch remove email"', () => {
    assert.deepEqual(parseCommand(['switch', 'remove', 'a@b.com']), { action: 'remove', email: 'a@b.com' });
  });

  it('parses "switch rm email" as remove', () => {
    assert.deepEqual(parseCommand(['switch', 'rm', 'a@b.com']), { action: 'remove', email: 'a@b.com' });
  });

  it('parses "switch status"', () => {
    assert.deepEqual(parseCommand(['switch', 'status']), { action: 'status' });
  });

  it('parses "switch help"', () => {
    assert.deepEqual(parseCommand(['switch', 'help']), { action: 'help' });
  });

  it('parses "switch --completions bash"', () => {
    assert.deepEqual(parseCommand(['switch', '--completions', 'bash']), { action: 'completions', shell: 'bash' });
  });

  it('parses "switch email" as switch-to', () => {
    assert.deepEqual(parseCommand(['switch', 'a@b.com']), { action: 'switch-to', target: 'a@b.com' });
  });

  it('parses "switch --version"', () => {
    assert.deepEqual(parseCommand(['switch', '--version']), { action: 'version' });
  });

  it('parses "switch -v"', () => {
    assert.deepEqual(parseCommand(['switch', '-v']), { action: 'version' });
  });

  it('parses non-switch commands as passthrough', () => {
    assert.deepEqual(parseCommand(['--help']), { action: 'passthrough', args: ['--help'] });
  });

  it('parses empty args as passthrough', () => {
    assert.deepEqual(parseCommand([]), { action: 'passthrough', args: [] });
  });

  it('parses "switch alias work work@co.com"', () => {
    assert.deepEqual(parseCommand(['switch', 'alias', 'work', 'work@co.com']),
      { action: 'alias-set', name: 'work', email: 'work@co.com' });
  });

  it('parses "switch alias --list"', () => {
    assert.deepEqual(parseCommand(['switch', 'alias', '--list']),
      { action: 'alias-list' });
  });

  it('parses "switch alias --remove work"', () => {
    assert.deepEqual(parseCommand(['switch', 'alias', '--remove', 'work']),
      { action: 'alias-remove', name: 'work' });
  });

  it('parses "switch alias" with no args as alias-list', () => {
    assert.deepEqual(parseCommand(['switch', 'alias']),
      { action: 'alias-list' });
  });

  it('parses "--as work" as temporary-switch', () => {
    assert.deepEqual(parseCommand(['--as', 'work', 'do', 'stuff']),
      { action: 'temporary-switch', target: 'work', args: ['do', 'stuff'] });
  });

  it('parses "--as work" with no extra args', () => {
    assert.deepEqual(parseCommand(['--as', 'work']),
      { action: 'temporary-switch', target: 'work', args: [] });
  });

  it('parses "--as" with no target', () => {
    assert.deepEqual(parseCommand(['--as']),
      { action: 'temporary-switch', target: undefined, args: [] });
  });

  it('parses "switch cache-health" with no flags', () => {
    assert.deepEqual(
      parseCommand(['switch', 'cache-health']),
      { action: 'cache-health', sessionPath: undefined, json: false },
    );
  });

  it('parses "switch cache-health --json"', () => {
    assert.deepEqual(
      parseCommand(['switch', 'cache-health', '--json']),
      { action: 'cache-health', sessionPath: undefined, json: true },
    );
  });

  it('parses "switch cache-health --session /path/to/session.jsonl"', () => {
    assert.deepEqual(
      parseCommand(['switch', 'cache-health', '--session', '/path/to/session.jsonl']),
      { action: 'cache-health', sessionPath: '/path/to/session.jsonl', json: false },
    );
  });

  it('parses "switch cache-health --json --session /path"', () => {
    assert.deepEqual(
      parseCommand(['switch', 'cache-health', '--json', '--session', '/path']),
      { action: 'cache-health', sessionPath: '/path', json: true },
    );
  });

  it('parses "switch setup"', () => {
    assert.deepEqual(parseCommand(['switch', 'setup']), { action: 'setup' });
  });

  it('parses "switch apikey set work"', () => {
    assert.deepEqual(parseCommand(['switch', 'apikey', 'set', 'work']),
      { action: 'apikey-set', target: 'work' });
  });

  it('parses "switch apikey show work"', () => {
    assert.deepEqual(parseCommand(['switch', 'apikey', 'show', 'work']),
      { action: 'apikey-show', target: 'work' });
  });

  it('parses "switch apikey remove work"', () => {
    assert.deepEqual(parseCommand(['switch', 'apikey', 'remove', 'work']),
      { action: 'apikey-remove', target: 'work' });
  });

  it('parses "switch apikey rm work" as remove', () => {
    assert.deepEqual(parseCommand(['switch', 'apikey', 'rm', 'work']),
      { action: 'apikey-remove', target: 'work' });
  });

  it('throws on unknown apikey subcommand', () => {
    assert.throws(() => parseCommand(['switch', 'apikey', 'wat']), /apikey/);
  });

  it('parses "switch fallback on"', () => {
    assert.deepEqual(parseCommand(['switch', 'fallback', 'on']),
      { action: 'fallback', mode: 'on' });
  });

  it('parses "switch fallback off"', () => {
    assert.deepEqual(parseCommand(['switch', 'fallback', 'off']),
      { action: 'fallback', mode: 'off' });
  });

  it('parses "switch fallback" with no arg as status', () => {
    assert.deepEqual(parseCommand(['switch', 'fallback']),
      { action: 'fallback', mode: 'status' });
  });

  it('parses "switch fallback status"', () => {
    assert.deepEqual(parseCommand(['switch', 'fallback', 'status']),
      { action: 'fallback', mode: 'status' });
  });

  it('throws on unknown fallback subcommand', () => {
    assert.throws(() => parseCommand(['switch', 'fallback', 'maybe']), /fallback/);
  });

  it('parses "fallback auto-revert on" (canonical name from v3.2.0)', () => {
    assert.deepEqual(parseCommand(['switch', 'fallback', 'auto-revert', 'on']),
      { action: 'fallback-auto', mode: 'on' });
  });

  it('parses "fallback auto-revert off"', () => {
    assert.deepEqual(parseCommand(['switch', 'fallback', 'auto-revert', 'off']),
      { action: 'fallback-auto', mode: 'off' });
  });

  it('parses "fallback auto-revert on --threshold 70"', () => {
    assert.deepEqual(parseCommand(['switch', 'fallback', 'auto-revert', 'on', '--threshold', '70']),
      { action: 'fallback-auto', mode: 'on', threshold: 70 });
  });

  it('parses "fallback auto-engage on" (always canonical)', () => {
    assert.deepEqual(parseCommand(['switch', 'fallback', 'auto-engage', 'on']),
      { action: 'fallback-auto-engage', mode: 'on' });
  });

  it('rejects retired "fallback auto" alias (use auto-revert)', () => {
    assert.throws(
      () => parseCommand(['switch', 'fallback', 'auto', 'on']),
      /Usage: claude switch fallback/,
    );
  });

  // ---- route sub-tree ----

  it('parses "switch route" as list (default)', () => {
    assert.deepEqual(parseCommand(['switch', 'route']), { action: 'route-list' });
  });

  it('parses "switch route list"', () => {
    assert.deepEqual(parseCommand(['switch', 'route', 'list']), { action: 'route-list' });
  });

  it('parses "switch route ls" as list', () => {
    assert.deepEqual(parseCommand(['switch', 'route', 'ls']), { action: 'route-list' });
  });

  it('parses "switch route add <pattern> <email>"', () => {
    assert.deepEqual(
      parseCommand(['switch', 'route', 'add', '~/work/**', 'a@b.com']),
      { action: 'route-add', pattern: '~/work/**', target: 'a@b.com' },
    );
  });

  it('parses "switch route add" with missing args (handler validates)', () => {
    // Parser passes through `undefined` so the handler can produce a usage
    // message. We do NOT throw at parse time so `route add --help` etc.
    // can be added later without re-jiggering the parser.
    assert.deepEqual(
      parseCommand(['switch', 'route', 'add']),
      { action: 'route-add', pattern: undefined, target: undefined },
    );
  });

  it('parses "switch route remove <pattern>"', () => {
    assert.deepEqual(
      parseCommand(['switch', 'route', 'remove', '~/work/**']),
      { action: 'route-remove', pattern: '~/work/**' },
    );
  });

  it('parses "switch route rm" as remove', () => {
    assert.deepEqual(
      parseCommand(['switch', 'route', 'rm', '~/work/**']),
      { action: 'route-remove', pattern: '~/work/**' },
    );
  });

  it('parses "switch route test" with no cwd → uses process.cwd at handler time', () => {
    assert.deepEqual(parseCommand(['switch', 'route', 'test']), {
      action: 'route-test',
      cwd: undefined,
      json: false,
    });
  });

  it('parses "switch route test <cwd>"', () => {
    assert.deepEqual(parseCommand(['switch', 'route', 'test', '/some/path']), {
      action: 'route-test',
      cwd: '/some/path',
      json: false,
    });
  });

  it('parses "switch route test --json"', () => {
    assert.deepEqual(parseCommand(['switch', 'route', 'test', '--json']), {
      action: 'route-test',
      cwd: '--json',
      json: true,
    });
  });

  it('rejects unknown route subcommand', () => {
    assert.throws(
      () => parseCommand(['switch', 'route', 'frobnicate']),
      /Usage: claude switch route/,
    );
  });
});
