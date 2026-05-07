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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-demo-'));
const claudeDir = path.join(tmp, '.claude');
const accountsDir = path.join(claudeDir, 'accounts');
fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });

const ACCOUNTS = [
  {
    email: 'alex.designer@acme.com',
    isActive: true,
    usage5h: 67,
    usage7d: 38,
  },
  {
    email: 'alex.personal@example.com',
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
    displayName: 'Alex Demo',
    organizationName: 'Acme Studio',
  },
}, null, 2));

for (const acc of ACCOUNTS) {
  // Per-account snapshot — same shape as `claude switch add` produces,
  // but with placeholder tokens. The dashboard never displays these.
  fs.writeFileSync(path.join(accountsDir, `${acc.email}.json`), JSON.stringify({
    emailAddress: acc.email,
    userID: `demo${acc.email.replace(/[^a-z0-9]/gi, '0').padEnd(58, '0')}`,
    _keychain: {
      claudeAiOauth: {
        accessToken: 'sk-ant-demo-placeholder',
        refreshToken: 'demo-refresh-placeholder',
        expiresAt: NOW + 7200_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: acc.isActive ? 'max20x' : 'pro',
      },
    },
  }, null, 2));

}

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

process.stdout.write(tmp);
