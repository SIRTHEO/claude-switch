import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePassthrough } from '../src/commands/passthrough.js';
import type { CommandContext } from '../src/commands/context.js';

// When the loopback fallback proxy fails to start, handlePassthrough must
// degrade to a direct OAuth spawn — never let the proxy reject crash the whole
// `claude` invocation. (Found via dependency-graph edge trace 2026-05-27: the
// `await startFallbackProxy(...)` was unguarded.)
describe('handlePassthrough — proxy start failure degrades to direct spawn', () => {
  let tmp: string;
  let claudeJson: string;
  let accDir: string;
  let savedBin: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-passthrough-degrade-'));
    claudeJson = path.join(tmp, '.claude.json');
    accDir = path.join(tmp, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });

    // Active account with a healthy (far-future) OAuth token...
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: {
        emailAddress: 'a@b.com',
        accessToken: 'oauth-tok',
        expiresAt: Date.now() + 3_600_000,
      },
    }));
    // ...and a saved API key, so the proxy branch (oauth-first) is taken.
    fs.writeFileSync(
      path.join(accDir, 'a@b.com.json'),
      JSON.stringify({ emailAddress: 'a@b.com', _apiKey: 'sk-ant-api03-test' }),
      { mode: 0o600 },
    );

    // findClaude must resolve to a real executable or it process.exit(1)s.
    savedBin = process.env.CLAUDE_SWITCH_BIN;
    process.env.CLAUDE_SWITCH_BIN = process.execPath;
  });

  afterEach(() => {
    if (savedBin === undefined) delete process.env.CLAUDE_SWITCH_BIN;
    else process.env.CLAUDE_SWITCH_BIN = savedBin;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runs claude directly with extraEnv when startProxy rejects', async () => {
    const ctx: CommandContext = {
      claudeJsonPath: claudeJson,
      accountsDirPath: accDir,
      updateInfo: null,
      selfUrl: fileURLToPath(import.meta.url),
    };

    let proxyAttempted = false;
    const runCalls: Array<{ env: NodeJS.ProcessEnv | null | undefined }> = [];

    await handlePassthrough(ctx, ['--help'], {
      startProxy: async () => {
        proxyAttempted = true;
        throw new Error('EADDRINUSE: simulated loopback bind failure');
      },
      runClaude: ((_bin: string, _args: string[], env?: NodeJS.ProcessEnv | null) => {
        runCalls.push({ env });
        // proxyRun's real return type is `never`; the cast keeps the fake total.
        return undefined as never;
      }),
    });

    assert.equal(proxyAttempted, true, 'the proxy branch must have been reached');
    assert.equal(runCalls.length, 1, 'claude must still be spawned exactly once');
    // Degrade path uses the legacy extraEnv, NOT the proxy ANTHROPIC_BASE_URL.
    const env = runCalls[0]!.env;
    assert.ok(
      !env || env.ANTHROPIC_BASE_URL === undefined,
      'degraded spawn must not point at a proxy that never started',
    );
  });
});
