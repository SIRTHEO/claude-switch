// test/passthrough-session-record.test.ts
// Wiring guard: handlePassthrough must actually record THIS invocation in the
// live-session registry. markSessionLive is best-effort/try-caught and does not
// touch runClaude, so without this assertion the call could land in a dead
// branch or be dropped by a later refactor and every other passthrough test
// would still pass — a silently-non-recording ("lying") registry. This pins
// that the call fires and produces a correct entry.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handlePassthrough } from '../src/commands/passthrough.js';
import { readRaw } from '../src/sessions/session-registry.js';
import type { CommandContext } from '../src/commands/context.js';

describe('handlePassthrough — records the session in the registry', () => {
  let tmp: string;
  let claudeJson: string;
  let accDir: string;
  let savedBin: string | undefined;
  let savedCcd: string | undefined;
  let savedAccount: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-passthrough-record-'));
    claudeJson = path.join(tmp, '.claude.json');
    accDir = path.join(tmp, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });

    // Active account with a healthy OAuth token and NO api key, so the simple
    // direct-spawn branch is taken (no proxy).
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: {
        emailAddress: 'a@b.com',
        accessToken: 'oauth-tok',
        expiresAt: Date.now() + 3_600_000,
      },
    }));
    fs.writeFileSync(
      path.join(accDir, 'a@b.com.json'),
      JSON.stringify({ emailAddress: 'a@b.com' }),
      { mode: 0o600 },
    );

    savedBin = process.env.CLAUDE_SWITCH_BIN;
    process.env.CLAUDE_SWITCH_BIN = process.execPath;
    // Ensure a clean, global-bound, non-routed run.
    savedCcd = process.env.CLAUDE_CONFIG_DIR;
    savedAccount = process.env.CLAUDE_SWITCH_ACCOUNT;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_SWITCH_ACCOUNT;
  });

  afterEach(() => {
    if (savedBin === undefined) delete process.env.CLAUDE_SWITCH_BIN;
    else process.env.CLAUDE_SWITCH_BIN = savedBin;
    if (savedCcd === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedCcd;
    if (savedAccount === undefined) delete process.env.CLAUDE_SWITCH_ACCOUNT;
    else process.env.CLAUDE_SWITCH_ACCOUNT = savedAccount;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a global-bound entry for this pid/account before spawning claude', async () => {
    const ctx: CommandContext = {
      claudeJsonPath: claudeJson,
      accountsDirPath: accDir,
      updateInfo: null,
      selfUrl: import.meta.url,
    };

    let spawned = false;
    await handlePassthrough(ctx, ['--help'], {
      runClaude: ((_bin: string, _args: string[], _env?: NodeJS.ProcessEnv | null) => {
        spawned = true;
        return undefined as never;
      }),
    });

    assert.equal(spawned, true, 'claude must still be spawned');
    const sessions = readRaw(accDir);
    assert.equal(sessions.length, 1, 'exactly one session must be recorded');
    assert.equal(sessions[0]!.pid, process.pid);
    assert.equal(sessions[0]!.account, 'a@b.com');
    assert.equal(sessions[0]!.isolated, false, 'no CLAUDE_CONFIG_DIR → global-bound');
  });
});
