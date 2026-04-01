import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../bin/cli.js';

interface SwitchInteractiveCmd { action: 'switch-interactive' }
interface SwitchToCmd { action: 'switch-to'; target: string }
interface AddCmd { action: 'add' }
interface ListCmd { action: 'list' }
interface RemoveCmd { action: 'remove'; email: string | undefined }
interface StatusCmd { action: 'status' }
interface HelpCmd { action: 'help' }
interface CompletionsCmd { action: 'completions'; shell: string | undefined }
interface PassthroughCmd { action: 'passthrough'; args: string[] }

type Command = SwitchInteractiveCmd | SwitchToCmd | AddCmd | ListCmd | RemoveCmd | StatusCmd | HelpCmd | CompletionsCmd | PassthroughCmd;

describe('parseCommand', () => {
  it('parses "switch" as interactive switch', () => {
    assert.deepEqual(parseCommand(['switch']), { action: 'switch-interactive' });
  });

  it('parses "switch add"', () => {
    assert.deepEqual(parseCommand(['switch', 'add']), { action: 'add' });
  });

  it('parses "switch list"', () => {
    assert.deepEqual(parseCommand(['switch', 'list']), { action: 'list' });
  });

  it('parses "switch ls" as list', () => {
    assert.deepEqual(parseCommand(['switch', 'ls']), { action: 'list' });
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
});
