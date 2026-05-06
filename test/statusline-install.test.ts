import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectExistingStatusLine,
  installStatusLine,
  uninstallStatusLine,
  PLAIN_COMMAND,
  CCSTATUSLINE_COMMAND,
  CCSTATUSLINE_VERSION,
} from '../src/statusline-install.js';

describe('detectExistingStatusLine', () => {
  let dir: string;
  let settings: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'));
    settings = path.join(dir, 'settings.json');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns absent when settings.json does not exist', () => {
    assert.deepStrictEqual(detectExistingStatusLine(settings), { kind: 'absent' });
  });

  it('returns absent when settings has no statusLine block', () => {
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }));
    assert.deepStrictEqual(detectExistingStatusLine(settings), { kind: 'absent' });
  });

  it('returns ours-plain for the plain command we install', () => {
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: PLAIN_COMMAND } }));
    assert.deepStrictEqual(detectExistingStatusLine(settings), { kind: 'ours-plain' });
  });

  it('returns ours-ccstatusline for the chained command', () => {
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: CCSTATUSLINE_COMMAND } }));
    assert.deepStrictEqual(detectExistingStatusLine(settings), { kind: 'ours-ccstatusline' });
  });

  it('pins the ccstatusline command instead of executing latest', () => {
    assert.match(CCSTATUSLINE_COMMAND, new RegExp(`ccstatusline@${CCSTATUSLINE_VERSION.replaceAll('.', '\\.')}`));
    assert.doesNotMatch(CCSTATUSLINE_COMMAND, /@latest/);
  });

  it('returns foreign for an unrelated command', () => {
    const foreign = '/usr/bin/some-other-statusline';
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: foreign } }));
    assert.deepStrictEqual(detectExistingStatusLine(settings), { kind: 'foreign', command: foreign });
  });

  it('returns foreign with diagnostic message when JSON is malformed', () => {
    fs.writeFileSync(settings, '{ not json');
    const result = detectExistingStatusLine(settings);
    assert.strictEqual(result.kind, 'foreign');
  });
});

describe('installStatusLine', () => {
  let dir: string;
  let settings: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-install-'));
    settings = path.join(dir, '.claude', 'settings.json');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates settings.json (and parent dir) when missing', () => {
    installStatusLine(PLAIN_COMMAND, settings);
    const parsed = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    assert.deepStrictEqual(parsed, { statusLine: { type: 'command', command: PLAIN_COMMAND } });
  });

  it('preserves other keys in settings.json', () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', model: 'opus' }));
    installStatusLine(PLAIN_COMMAND, settings);
    const parsed = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    assert.strictEqual(parsed.theme, 'dark');
    assert.strictEqual(parsed.model, 'opus');
    assert.strictEqual(parsed.statusLine.command, PLAIN_COMMAND);
  });

  it('overwrites an existing statusLine', () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'old-thing' } }));
    installStatusLine(PLAIN_COMMAND, settings);
    const parsed = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    assert.strictEqual(parsed.statusLine.command, PLAIN_COMMAND);
  });

  it('writes mode 0600 on unix', { skip: process.platform === 'win32' }, () => {
    installStatusLine(PLAIN_COMMAND, settings);
    const stat = fs.statSync(settings);
    assert.strictEqual(stat.mode & 0o777, 0o600);
  });
});

describe('uninstallStatusLine', () => {
  let dir: string;
  let settings: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-uninstall-'));
    settings = path.join(dir, 'settings.json');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns false when no statusLine is present', () => {
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }));
    assert.strictEqual(uninstallStatusLine(settings), false);
  });

  it('removes our statusLine and preserves other keys', () => {
    fs.writeFileSync(settings, JSON.stringify({
      theme: 'dark',
      statusLine: { type: 'command', command: PLAIN_COMMAND },
    }));
    assert.strictEqual(uninstallStatusLine(settings), true);
    const parsed = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    assert.strictEqual(parsed.theme, 'dark');
    assert.strictEqual(parsed.statusLine, undefined);
  });

  it('refuses to remove a foreign statusLine', () => {
    fs.writeFileSync(settings, JSON.stringify({
      statusLine: { type: 'command', command: '/some/other/tool' },
    }));
    assert.strictEqual(uninstallStatusLine(settings), false);
    // Foreign command must still be there
    const parsed = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    assert.strictEqual(parsed.statusLine.command, '/some/other/tool');
  });
});
