// test/commands-mcp.test.ts
// Coverage for `src/mcp.ts` + `src/commands/mcp.ts` + the `profile mcp add`
// argv parser in bin/cli.ts.
//
// The MCP module reads/writes ~/.claude.json and <profile>/.claude.json via
// os.homedir(); we override HOME with the fake-home helper so the tests never
// touch the developer's real config.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parseCommand } from '../bin/cli.js';
import {
  handleProfileMcpAdd,
  handleProfileMcpList,
  handleProfileMcpRemove,
} from '../src/commands/mcp.js';
import { restoreFakeHome, setFakeHome, type SavedHome } from './_helpers/fake-home.js';

interface Harness {
  tmpDir: string;
  fakeHome: string;
  savedHome: SavedHome;
  stdout: string[];
}

let h: Harness;

function profileDir(name: string): string {
  return path.join(h.fakeHome, '.claude', 'profiles', name);
}
function profileJson(name: string): string {
  return path.join(profileDir(name), '.claude.json');
}
function globalJson(): string {
  return path.join(h.fakeHome, '.claude.json');
}
function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

function captureStdout(): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    h.stdout.push(String(chunk));
    return true;
  };
  return () => {
    process.stdout.write = orig;
  };
}

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mcp-'));
  const fakeHome = path.join(tmpDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  h = { tmpDir, fakeHome, savedHome: setFakeHome(fakeHome), stdout: [] };
  // A profile exists when its dir exists.
  fs.mkdirSync(profileDir('work'), { recursive: true });
});

afterEach(() => {
  restoreFakeHome(h.savedHome);
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
});

describe('profile mcp — compose from global', () => {
  it('copies a global server definition into the profile', async () => {
    fs.writeFileSync(
      globalJson(),
      JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'fs-server' } } }),
    );

    await handleProfileMcpAdd('work', 'fs', {});

    assert.deepEqual(readJson(profileJson('work')).mcpServers, {
      fs: { type: 'stdio', command: 'fs-server' },
    });
  });

  it('errors when the server is not in the global config', async () => {
    fs.writeFileSync(globalJson(), JSON.stringify({ mcpServers: {} }));
    await assert.rejects(() => handleProfileMcpAdd('work', 'nope', {}), /not in the global config/);
  });
});

describe('profile mcp — inline definition', () => {
  it('writes a stdio server with args + env', async () => {
    await handleProfileMcpAdd('work', 'local', {
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'x' },
    });
    assert.deepEqual(readJson(profileJson('work')).mcpServers, {
      local: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } },
    });
  });

  it('writes a remote sse server with headers', async () => {
    await handleProfileMcpAdd('work', 'remote', {
      transport: 'sse',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer t' },
    });
    assert.deepEqual(readJson(profileJson('work')).mcpServers, {
      remote: { type: 'sse', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
    });
  });
});

describe('profile mcp — write preserves unrelated keys', () => {
  it('keeps existing config keys and other servers intact', async () => {
    fs.writeFileSync(
      profileJson('work'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'sirtheo.work@example.com' },
        mcpServers: { keep: { type: 'stdio', command: 'keep-me' } },
      }),
    );

    await handleProfileMcpAdd('work', 'added', { command: 'new' });

    const cfg = readJson(profileJson('work'));
    assert.deepEqual(cfg.oauthAccount, { emailAddress: 'sirtheo.work@example.com' });
    assert.deepEqual(cfg.mcpServers, {
      keep: { type: 'stdio', command: 'keep-me' },
      added: { type: 'stdio', command: 'new' },
    });
  });
});

describe('profile mcp remove', () => {
  it('drops a configured server', async () => {
    fs.writeFileSync(
      profileJson('work'),
      JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }),
    );
    await handleProfileMcpRemove('work', 'a');
    assert.deepEqual(readJson(profileJson('work')).mcpServers, { b: { command: 'y' } });
  });

  it('errors when the server is not configured', async () => {
    fs.writeFileSync(profileJson('work'), JSON.stringify({ mcpServers: {} }));
    await assert.rejects(() => handleProfileMcpRemove('work', 'ghost'), /not configured/);
  });
});

describe('profile mcp list --json', () => {
  it('reports configured / available / profile-only / globalDrift', async () => {
    fs.writeFileSync(
      globalJson(),
      JSON.stringify({
        mcpServers: {
          shared: { type: 'stdio', command: 'shared-v2' }, // configured + drift
          avail: { type: 'http', url: 'https://a.test' }, // available only
        },
      }),
    );
    fs.writeFileSync(
      profileJson('work'),
      JSON.stringify({
        mcpServers: {
          shared: { type: 'stdio', command: 'shared-v1' }, // older copy → drift
          only: { type: 'stdio', command: 'profile-only' }, // profile-only
        },
      }),
    );

    const restore = captureStdout();
    await handleProfileMcpList('work', { json: true });
    restore();

    const payload = JSON.parse(h.stdout.join('').trim()) as Array<{
      name: string;
      configured: boolean;
      inGlobal: boolean;
      globalDrift: boolean;
      transport: string | null;
      detail: string | null;
    }>;
    const by = (n: string) => payload.find((e) => e.name === n);

    assert.deepEqual(by('shared'), {
      name: 'shared',
      configured: true,
      inGlobal: true,
      globalDrift: true,
      transport: 'stdio',
      detail: 'shared-v1', // effective = profile's copy
    });
    assert.deepEqual(by('avail'), {
      name: 'avail',
      configured: false,
      inGlobal: true,
      globalDrift: false,
      transport: 'http',
      detail: 'https://a.test',
    });
    assert.deepEqual(by('only'), {
      name: 'only',
      configured: true,
      inGlobal: false,
      globalDrift: false,
      transport: 'stdio',
      detail: 'profile-only',
    });
  });

  it('errors for a non-existent profile', async () => {
    await assert.rejects(() => handleProfileMcpList('ghost', { json: true }), /does not exist/);
  });
});

describe('profile mcp add — argv parser', () => {
  const add = (rest: string[]) =>
    parseCommand(['switch', 'profile', 'mcp', 'add', 'work', 'srv', ...rest]);

  it('empty tail → compose (no inline spec)', () => {
    const cmd = add([]);
    assert.equal(cmd.action, 'profile-mcp-add');
    if (cmd.action !== 'profile-mcp-add') return;
    assert.deepEqual(cmd.spec, {});
  });

  it('parses a stdio command after --', () => {
    const cmd = add(['--env', 'A=1', '--', 'node', 'server.js', '--port', '3000']);
    if (cmd.action !== 'profile-mcp-add') return assert.fail('wrong action');
    assert.deepEqual(cmd.spec, { env: { A: '1' }, command: 'node', args: ['server.js', '--port', '3000'] });
  });

  it('parses a remote sse server', () => {
    const cmd = add(['--transport', 'sse', '--url', 'https://x.test', '--header', 'Authorization:Bearer t']);
    if (cmd.action !== 'profile-mcp-add') return assert.fail('wrong action');
    assert.deepEqual(cmd.spec, {
      transport: 'sse',
      url: 'https://x.test',
      headers: { Authorization: 'Bearer t' },
    });
  });

  it('rejects --transport without --url', () => {
    assert.throws(() => add(['--transport', 'sse']), /needs both --transport and --url/);
  });

  it('rejects mixing -- command with --transport', () => {
    assert.throws(() => add(['--transport', 'sse', '--url', 'u', '--', 'node']), /Cannot combine/);
  });

  it('rejects a duplicate --env key', () => {
    assert.throws(() => add(['--env', 'A=1', '--env', 'A=2', '--', 'node']), /Duplicate --env/);
  });

  it('rejects a dangling -- with no command', () => {
    assert.throws(() => add(['--']), /Expected a command after/);
  });
});
