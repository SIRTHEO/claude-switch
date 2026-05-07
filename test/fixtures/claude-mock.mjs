#!/usr/bin/env node
// test/fixtures/claude-mock.mjs
// "Fake claude" used by the integration test suite. Mirrors the real
// binary's credential-lookup contract so claude-switch's profile flow
// can be exercised end-to-end in CI without touching a real Anthropic
// API account.
//
// Contract (matches what was reverse-engineered from claude v2.x):
//   service = `Claude Code-credentials${configDir ? '-' + sha256(configDir).hex.slice(0,8) : ''}`
//   account = process.env.USER || os.userInfo().username || 'claude-code-user'
//
//   - macOS  → looks the entry up in the login Keychain via `security`.
//   - other  → reads `<configDir>/.claude.json` and checks
//              oauthAccount.accessToken (the JSON-storage path Linux
//              and Windows take, since they have no system Keychain).
//
// Output:
//   stdout: "OK <email>" + exit 0 when credentials resolve
//   stdout: "FAIL <reason>" + exit 1 otherwise
//
// IMPORTANT: this file is a frozen mirror of how claude reads
// credentials. If Anthropic changes the layout in a future release,
// this stub stops reflecting reality — the canary suite (a separate
// test that diffs strings out of the real binary) is what should
// catch that. Don't update the formula here unless you've ALSO
// updated src/keychain.ts to match.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVICE_BASE = 'Claude Code-credentials';

function resolveConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function serviceFor(dir) {
  // Empty CLAUDE_CONFIG_DIR (default `~/.claude`) → no hash suffix.
  if (!process.env.CLAUDE_CONFIG_DIR) return SERVICE_BASE;
  const hash = createHash('sha256').update(dir.normalize('NFC')).digest('hex').substring(0, 8);
  return `${SERVICE_BASE}-${hash}`;
}

function resolveAccount() {
  let name;
  try { name = process.env.USER || os.userInfo().username; } catch { name = 'claude-code-user'; }
  return /^[a-zA-Z0-9._-]+$/.test(name || '') ? name : 'claude-code-user';
}

function readClaudeJson(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, '.claude.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function lookupDarwin(service, account) {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    const data = JSON.parse(raw);
    return Boolean(data?.claudeAiOauth?.accessToken);
  } catch {
    return false;
  }
}

const dir = resolveConfigDir();
const service = serviceFor(dir);
const account = resolveAccount();
const cfg = readClaudeJson(dir);
const email = cfg?.oauthAccount?.emailAddress ?? 'unknown@example.com';

// CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 forces the JSON-only branch even on
// darwin — mirrors the production write-side gate so the mock stays
// consistent with what claude-switch actually writes.
const useKeychain = process.platform === 'darwin'
  && process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN !== '1';

const credentialsResolve = useKeychain
  ? lookupDarwin(service, account)
  // Linux/Windows path (and darwin-with-keychain-disabled):
  // claude-switch embeds tokens directly in the per-profile claude.json
  // since no system keychain is in play.
  : Boolean(cfg?.oauthAccount?.accessToken);

if (credentialsResolve) {
  process.stdout.write(`OK ${email}\n`);
  process.exit(0);
}

process.stdout.write(
  `FAIL no-creds platform=${process.platform} service="${service}" account="${account}" configDir="${dir}"\n`,
);
process.exit(1);
