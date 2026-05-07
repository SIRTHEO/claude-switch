#!/usr/bin/env node
// scripts/demo-fixture.mjs
// Build a synthetic ~/.claude tree for the marketing GIF.
//
// Why synthetic and not "real with renamed emails":
//   - real tokens, even if the email is renamed, would leak via the
//     access_token prefix or refresh_token if anyone inspected the
//     recorded frames closely.
//   - the dashboard never displays the actual token bytes, only
//     metadata (email, alias, expiresAt, usage %). Synthetic data
//     covers everything the user would actually see on screen.
//
// Output: prints the path of the temporary $HOME to stdout. The
// caller (scripts/render-demo.sh) exports it as HOME for the recording.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic location so the path we render in `profile status`
// stays clean (`/tmp/sirtheo-home/.claude/...`) rather than leaking a
// random tmpdir suffix into the marketing GIF. Use literal `/tmp` so
// the path also stays short (macOS's os.tmpdir() resolves to
// `/var/folders/…` which renders as a multi-line wrap in 1000px terms).
// `os` import retained for parity with future tweaks.
void os;
const tmp = '/tmp/sirtheo-home';
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const claudeDir = path.join(tmp, '.claude');
const accountsDir = path.join(claudeDir, 'accounts');
fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });

const ACCOUNTS = [
  {
    email: 'sirtheo.work@example.com',
    isActive: true,
    usage5h: 67,
    usage7d: 38,
  },
  {
    email: 'sirtheo.personal@example.com',
    isActive: false,
    usage5h: 12,
    usage7d: 8,
  },
];

const NOW = Date.now();

// .claude.json — what claude itself reads. Only emailAddress matters
// for the dashboard's "active account" label; everything else is
// padding so claude doesn't complain on `--version`-style probes.
fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({
  userID: 'demoUser0000000000000000000000000000000000000000000000000000fake',
  oauthAccount: {
    emailAddress: ACCOUNTS.find((a) => a.isActive)?.email,
    displayName: 'Sirtheo',
    organizationName: 'Sirtheo Workspace',
    // Placeholder token + 2h expiry so the dashboard's tokenHealth
    // line reads "valid" in the GIF rather than "missing". The token
    // never reaches the real Anthropic API — CLAUDE_SWITCH_DISABLE_KEYCHAIN
    // pins us to JSON-only, and we never spawn real claude during render.
    accessToken: 'sk-ant-demo-access-placeholder',
    refreshToken: 'demo-refresh',
    expiresAt: Date.now() + 2 * 3600_000,
  },
}, null, 2));

for (const acc of ACCOUNTS) {
  // Per-account snapshot — placeholder _keychain block so accounts.load
  // sets keychainRestored=true (skips the "no saved credentials"
  // warning) AND placeholder oauthAccount fields so the dashboard's
  // tokenHealth line reads "valid" after switching here in the GIF
  // (load() copies oauthAccount into ~/.claude.json). Both placeholders
  // never reach the real Anthropic API: render-demo.sh pins the run
  // to JSON-only via CLAUDE_SWITCH_DISABLE_KEYCHAIN=1, no real claude
  // is spawned.
  const tokenExpiresAt = Date.now() + 2 * 3600_000;
  fs.writeFileSync(path.join(accountsDir, `${acc.email}.json`), JSON.stringify({
    emailAddress: acc.email,
    userID: `demo${acc.email.replace(/[^a-z0-9]/gi, '0').padEnd(58, '0')}`,
    accessToken: 'sk-ant-demo-access-placeholder',
    refreshToken: 'demo-refresh',
    expiresAt: tokenExpiresAt,
    _keychain: {
      claudeAiOauth: {
        accessToken: 'sk-ant-demo-access-placeholder',
        refreshToken: 'demo-refresh',
        expiresAt: tokenExpiresAt,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: acc.isActive ? 'max20x' : 'pro',
      },
    },
  }, null, 2));
}

// Pre-create one demo profile so `claude switch profile list` and
// `profile status` have something to show. Uses the same synthetic
// userID + email pattern as the accounts (no real credentials).
const profilesDir = path.join(claudeDir, 'profiles');
const personalProfile = path.join(profilesDir, 'personal');
fs.mkdirSync(personalProfile, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(personalProfile, '.claude.json'), JSON.stringify({
  userID: 'demoProfile000000000000000000000000000000000000000000000000fake',
  oauthAccount: {
    emailAddress: ACCOUNTS[1].email,
    displayName: 'Sirtheo (personal)',
  },
}, null, 2));

// Single shared usage cache, tagged to the active account — matches
// production behaviour (claude-switch only caches the most-recently
// fetched account's quota; other rows show a neutral glyph). The
// dashboard will render usage colour for the active row only.
const active = ACCOUNTS.find((a) => a.isActive);
fs.writeFileSync(path.join(accountsDir, '.usage-cache.json'), JSON.stringify({
  fetchedAt: NOW,
  account: active.email,
  payload: {
    five_hour: { utilization: active.usage5h, resets_at: new Date(NOW + 4 * 3600_000).toISOString() },
    seven_day: { utilization: active.usage7d, resets_at: new Date(NOW + 6 * 86400_000).toISOString() },
  },
}, null, 2));

// Aliases for the cute "Account: work" line on the dashboard. Real
// path is `<accountsDir>/aliases.json` (no leading dot).
fs.writeFileSync(path.join(accountsDir, 'aliases.json'), JSON.stringify({
  work: ACCOUNTS[0].email,
  personal: ACCOUNTS[1].email,
}, null, 2));

// Fallback: off — keeps the badge in its quiet state.
fs.writeFileSync(path.join(accountsDir, '.claude-switch-state.json'), JSON.stringify({
  version: 1,
  fallback: { enabled: false, autoEngaged: false },
}, null, 2));

// Global prefs: turn off auto-launch on switch. The default would
// spawn the real `claude` binary after a successful switch, dumping
// us into the live Claude Code onboarding screen mid-recording —
// which leaks unrelated UI into the marketing GIF and overwrites the
// dashboard we wanted to showcase.
fs.writeFileSync(path.join(accountsDir, '.user-prefs.json'), JSON.stringify({
  defaultAutoLaunchOnSwitch: false,
}, null, 2));

process.stdout.write(tmp);
