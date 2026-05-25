import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAlias, setAlias, listAliases, removeAlias, resolveAlias, getAliasesForEmail } from '../src/switching/aliases.js';

describe('aliases', () => {
  let tmpDir: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-alias-'));
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('setAlias creates aliases.json and stores alias', () => {
    setAlias('work', 'work@company.com', accDir);
    assert.equal(getAlias('work', accDir), 'work@company.com');
  });

  it('setAlias overwrites existing alias', () => {
    setAlias('work', 'old@company.com', accDir);
    setAlias('work', 'new@company.com', accDir);
    assert.equal(getAlias('work', accDir), 'new@company.com');
  });

  it('getAlias returns null for unknown alias', () => {
    assert.equal(getAlias('nope', accDir), null);
  });

  it('getAlias returns null when aliases.json does not exist', () => {
    assert.equal(getAlias('work', accDir), null);
  });

  it('listAliases returns all aliases', () => {
    setAlias('work', 'work@company.com', accDir);
    setAlias('personal', 'me@gmail.com', accDir);
    const aliases = listAliases(accDir);
    assert.equal(aliases['work'], 'work@company.com');
    assert.equal(aliases['personal'], 'me@gmail.com');
    assert.equal(Object.keys(aliases).length, 2);
  });

  it('listAliases returns empty object when no aliases', () => {
    assert.deepEqual(listAliases(accDir), {});
  });

  it('removeAlias deletes an alias', () => {
    setAlias('work', 'work@company.com', accDir);
    removeAlias('work', accDir);
    assert.equal(getAlias('work', accDir), null);
  });

  it('removeAlias throws for unknown alias', () => {
    assert.throws(() => removeAlias('nope', accDir), /no alias/i);
  });

  it('resolveAlias returns email for known alias', () => {
    setAlias('work', 'work@company.com', accDir);
    assert.equal(resolveAlias('work', accDir), 'work@company.com');
  });

  it('resolveAlias returns input unchanged if not an alias', () => {
    assert.equal(resolveAlias('user@example.com', accDir), 'user@example.com');
  });

  it('getAliasesForEmail returns aliases for email', () => {
    setAlias('work', 'work@co.com', accDir);
    setAlias('w', 'work@co.com', accDir);
    setAlias('personal', 'me@gmail.com', accDir);
    assert.deepEqual(getAliasesForEmail('work@co.com', accDir).sort(), ['w', 'work']);
  });

  it('sets 0o600 permissions on aliases.json (unix)', () => {
    if (process.platform === 'win32') return;
    setAlias('work', 'work@company.com', accDir);
    const stat = fs.statSync(path.join(accDir, 'aliases.json'));
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('does not leave .tmp file after write', () => {
    setAlias('work', 'work@company.com', accDir);
    assert.ok(!fs.existsSync(path.join(accDir, 'aliases.json.tmp')));
  });

  it('ignores non-string values in corrupted aliases.json', () => {
    fs.writeFileSync(path.join(accDir, 'aliases.json'), JSON.stringify({ work: { nested: 'obj' }, valid: 'user@co.com' }));
    const aliases = listAliases(accDir);
    assert.equal(aliases['work'], undefined);
    assert.equal(aliases['valid'], 'user@co.com');
  });

  it('returns empty object for malformed aliases.json', () => {
    fs.writeFileSync(path.join(accDir, 'aliases.json'), '["not","an","object"]');
    assert.deepEqual(listAliases(accDir), {});
  });

  it('rejects reserved sub-command names', () => {
    for (const reserved of ['add', 'list', 'remove', 'status', 'help', 'apikey', 'fallback', 'update', 'setup']) {
      assert.throws(
        () => setAlias(reserved, 'user@example.com', accDir),
        /reserved/i,
        `should reject "${reserved}"`,
      );
    }
  });

  it('rejects empty alias name', () => {
    assert.throws(() => setAlias('', 'user@example.com', accDir), /empty/i);
  });
});
