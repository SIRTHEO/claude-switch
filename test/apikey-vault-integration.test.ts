import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getApiKey, setApiKey, removeApiKey } from '../src/credentials/apikey.js';
import { save } from '../src/accounts/accounts.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

// Test-fidelity guard. The rest of the apikey suite runs with
// CLAUDE_SWITCH_DISABLE_KEYCHAIN=1, which forces setApiKey/getApiKey down the
// legacy `_apiKey`-in-JSON branch — NOT the production default (the cross-
// platform file vault). Bug #1 (setApiKey deleting the legacy key on a
// swallowed vault-write failure) escaped precisely because no test drove the
// real vault branch end-to-end. This suite unsets the flag so the default
// FileCredentialStore is live and exercises the path users actually hit.
describe('apikey ↔ file vault (real default path, DISABLE_KEYCHAIN unset)', () => {
  let home: string;
  let accDir: string;
  let savedHome: SavedHome;
  let savedFlag: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-apikey-vault-'));
    savedHome = setFakeHome(home);
    savedFlag = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN; // → FileCredentialStore.available() === true
    accDir = path.join(home, '.claude', 'accounts');
    const claudeJson = path.join(home, '.claude.json');
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@b.com' } }));
    save('a@b.com', claudeJson, accDir);
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN;
    else process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN = savedFlag;
    restoreFakeHome(savedHome);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const vaultFile = (): string => path.join(home, '.claude-switch', 'apikeys.json');

  it('setApiKey writes to the vault, not the legacy _apiKey JSON field', () => {
    setApiKey('a@b.com', 'sk-ant-api03-vaulttest', accDir);
    assert.ok(fs.existsSync(vaultFile()), 'vault file must be created');
    const vault = JSON.parse(fs.readFileSync(vaultFile(), 'utf-8')) as Record<string, string>;
    assert.equal(vault['a@b.com'], 'sk-ant-api03-vaulttest');
    // The vault path must NOT also write the legacy fallback field.
    const acct = JSON.parse(fs.readFileSync(path.join(accDir, 'a@b.com.json'), 'utf-8')) as { _apiKey?: string };
    assert.equal(acct._apiKey, undefined, 'vault path must not write the legacy _apiKey');
  });

  it('getApiKey round-trips from the vault', () => {
    setApiKey('a@b.com', 'sk-ant-roundtrip', accDir);
    assert.equal(getApiKey('a@b.com', accDir), 'sk-ant-roundtrip');
  });

  it('removeApiKey clears the vault entry', () => {
    setApiKey('a@b.com', 'sk-ant-x', accDir);
    assert.equal(removeApiKey('a@b.com', accDir), true);
    assert.equal(getApiKey('a@b.com', accDir), null);
  });
});
