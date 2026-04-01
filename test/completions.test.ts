// test/completions.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateBash, generateZsh, generateFish, generatePowerShell } from '../src/completions.js';

describe('completions', () => {
  it('bash completion contains subcommands', () => {
    const output = generateBash();
    assert.ok(output.includes('switch'));
    assert.ok(output.includes('add'));
    assert.ok(output.includes('list'));
    assert.ok(output.includes('remove'));
    assert.ok(output.includes('status'));
  });

  it('zsh completion contains subcommands', () => {
    const output = generateZsh();
    assert.ok(output.includes('switch'));
    assert.ok(output.includes('add'));
  });

  it('fish completion contains subcommands', () => {
    const output = generateFish();
    assert.ok(output.includes('switch'));
    assert.ok(output.includes('add'));
  });

  it('powershell completion contains subcommands', () => {
    const output = generatePowerShell();
    assert.ok(output.includes('switch'));
    assert.ok(output.includes('add'));
  });
});
