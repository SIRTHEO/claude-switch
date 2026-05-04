# Auto-setup on install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `npm install -g @sirtheo/claude-switch`, the wrapper finds the real claude binary and configures PATH automatically — zero manual steps.

**Architecture:** A `postinstall` script runs after global install, finds the real claude, saves its path to `~/.claude/accounts/.claude-bin`, and prepends the npm bin dir to each detected shell config. At runtime, `findClaude()` reads the saved path first before falling back to PATH scan.

**Tech Stack:** Node.js ESM, TypeScript, no new dependencies.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/setup.ts` | All setup logic (find, save, patch shells) |
| Create | `bin/setup.ts` | Postinstall entry point |
| Create | `postinstall.js` | Cross-platform postinstall wrapper |
| Create | `test/setup.test.ts` | Tests for setup logic |
| Modify | `src/paths.ts` | Add `claudeBinFile()` |
| Modify | `bin/cli.ts` | `findClaude()` reads saved bin; add `setup` command |
| Modify | `package.json` | postinstall script, files, version 2.1.2 |
| Modify | `README.md` | Rewrite: new install flow, no em dashes |

---

## Task 1: Add `claudeBinFile()` to `src/paths.ts`

**Files:**
- Modify: `src/paths.ts`
- Test: `test/paths.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/paths.test.ts`, add at the bottom of the existing `paths` describe block:

```typescript
it('claudeBinFile points to ~/.claude/accounts/.claude-bin', () => {
  assert.equal(claudeBinFile(), path.join(os.homedir(), '.claude', 'accounts', '.claude-bin'));
});
```

Also add `claudeBinFile` to the import at the top of the file:
```typescript
import { claudeJsonPath, accountsDir, claudeBinFile } from '../src/paths.js';
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test 2>&1 | grep -A3 "claudeBinFile"
```
Expected: compile error — `claudeBinFile` not exported.

- [ ] **Step 3: Implement**

In `src/paths.ts`, add after `accountsDir()`:
```typescript
export function claudeBinFile(): string {
  return path.join(os.homedir(), '.claude', 'accounts', '.claude-bin');
}
```

- [ ] **Step 4: Run tests**

```bash
npm test 2>&1 | tail -8
```
Expected: all pass, no failures.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "feat: add claudeBinFile() to paths"
```

---

## Task 2: Create `src/setup.ts`

**Files:**
- Create: `src/setup.ts`
- Test: `test/setup.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/setup.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getSavedClaudeBin,
  saveClaudeBin,
  getNpmBinDir,
  detectShellConfigs,
  patchShellConfig,
} from '../src/setup.js';

describe('getSavedClaudeBin', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-setup-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when .claude-bin does not exist', () => {
    assert.equal(getSavedClaudeBin(), null);
  });

  it('returns null when saved path is not executable', () => {
    const binFile = path.join(tmpDir, '.claude', 'accounts', '.claude-bin');
    fs.mkdirSync(path.dirname(binFile), { recursive: true });
    fs.writeFileSync(binFile, '/nonexistent/path/claude');
    assert.equal(getSavedClaudeBin(), null);
  });

  it('returns path when saved path is executable', () => {
    const fakeExe = path.join(tmpDir, 'claude');
    fs.writeFileSync(fakeExe, '#!/bin/sh');
    fs.chmodSync(fakeExe, 0o755);
    const binFile = path.join(tmpDir, '.claude', 'accounts', '.claude-bin');
    fs.mkdirSync(path.dirname(binFile), { recursive: true });
    fs.writeFileSync(binFile, fakeExe);
    assert.equal(getSavedClaudeBin(), fakeExe);
  });
});

describe('saveClaudeBin', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-setup-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes path to .claude-bin file', () => {
    saveClaudeBin('/usr/local/bin/claude');
    const binFile = path.join(tmpDir, '.claude', 'accounts', '.claude-bin');
    assert.equal(fs.readFileSync(binFile, 'utf-8').trim(), '/usr/local/bin/claude');
  });
});

describe('getNpmBinDir', () => {
  let origPrefix: string | undefined;

  beforeEach(() => { origPrefix = process.env.npm_config_prefix; });
  afterEach(() => { process.env.npm_config_prefix = origPrefix; });

  it('returns null when npm_config_prefix is not set', () => {
    delete process.env.npm_config_prefix;
    assert.equal(getNpmBinDir(), null);
  });

  it('returns prefix/bin on unix', () => {
    if (process.platform === 'win32') return;
    process.env.npm_config_prefix = '/opt/homebrew';
    assert.equal(getNpmBinDir(), '/opt/homebrew/bin');
  });
});

describe('detectShellConfigs', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-setup-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no shell configs exist', () => {
    assert.deepEqual(detectShellConfigs(), []);
  });

  it('returns only existing shell configs', () => {
    const zshrc = path.join(tmpDir, '.zshrc');
    fs.writeFileSync(zshrc, '');
    const result = detectShellConfigs();
    assert.ok(result.includes(zshrc));
    assert.equal(result.length, 1);
  });
});

describe('patchShellConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-setup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends PATH block to zshrc', () => {
    const zshrc = path.join(tmpDir, '.zshrc');
    fs.writeFileSync(zshrc, '# existing content\n');
    const result = patchShellConfig(zshrc, '/opt/homebrew/bin');
    assert.equal(result, true);
    const content = fs.readFileSync(zshrc, 'utf-8');
    assert.ok(content.includes('# claude-switch'));
    assert.ok(content.includes('export PATH="/opt/homebrew/bin:$PATH"'));
    assert.ok(content.includes('# end claude-switch'));
  });

  it('is idempotent — does not patch twice', () => {
    const zshrc = path.join(tmpDir, '.zshrc');
    fs.writeFileSync(zshrc, '');
    patchShellConfig(zshrc, '/opt/homebrew/bin');
    const result = patchShellConfig(zshrc, '/opt/homebrew/bin');
    assert.equal(result, false);
    const content = fs.readFileSync(zshrc, 'utf-8');
    assert.equal((content.match(/# claude-switch/g) || []).length, 1);
  });

  it('uses fish_add_path for fish config', () => {
    const fishConfig = path.join(tmpDir, 'config.fish');
    fs.writeFileSync(fishConfig, '');
    patchShellConfig(fishConfig, '/opt/homebrew/bin');
    const content = fs.readFileSync(fishConfig, 'utf-8');
    assert.ok(content.includes('fish_add_path "/opt/homebrew/bin"'));
    assert.ok(!content.includes('export PATH'));
  });

  it('uses $env:PATH for PowerShell profile', () => {
    const profile = path.join(tmpDir, 'Microsoft.PowerShell_profile.ps1');
    fs.writeFileSync(profile, '');
    patchShellConfig(profile, 'C:\\Users\\user\\AppData\\Roaming\\npm');
    const content = fs.readFileSync(profile, 'utf-8');
    assert.ok(content.includes('$env:PATH'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test 2>&1 | grep -E "fail|error" | head -5
```
Expected: compile errors — `../src/setup.js` not found.

- [ ] **Step 3: Implement `src/setup.ts`**

Create `src/setup.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolve } from './resolver.js';
import { claudeBinFile, accountsDir } from './paths.js';

const BLOCK_START = '# claude-switch';
const BLOCK_END = '# end claude-switch';

export function getSavedClaudeBin(): string | null {
  try {
    const bin = fs.readFileSync(claudeBinFile(), 'utf-8').trim();
    if (!bin) return null;
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

export function saveClaudeBin(binPath: string): void {
  const dir = accountsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(claudeBinFile(), binPath, 'utf-8');
  if (process.platform !== 'win32') {
    fs.chmodSync(claudeBinFile(), 0o600);
  }
}

export function findRealClaude(selfPath: string): string | null {
  const fromPath = resolve({ envBin: '', selfPath, pathEnv: process.env.PATH || '' });
  if (fromPath) return fromPath;
  return resolve({ envBin: '', selfPath, pathEnv: undefined });
}

export function getNpmBinDir(): string | null {
  const prefix = process.env.npm_config_prefix;
  if (!prefix) return null;
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

export function detectShellConfigs(): string[] {
  const home = os.homedir();
  const candidates: string[] = [
    path.join(home, '.zshrc'),
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.config', 'fish', 'config.fish'),
  ];

  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || home;
    candidates.push(
      path.join(userProfile, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      path.join(userProfile, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    );
  }

  return candidates.filter(f => {
    try { fs.accessSync(f); return true; } catch { return false; }
  });
}

export function patchShellConfig(filePath: string, npmBinDir: string): boolean {
  try {
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    if (content.includes(BLOCK_START)) return false;

    const isFish = filePath.endsWith('config.fish');
    const isPs = filePath.endsWith('.ps1');

    let block: string;
    if (isFish) {
      block = `\n${BLOCK_START}\nfish_add_path "${npmBinDir}"\n${BLOCK_END}\n`;
    } else if (isPs) {
      block = `\n${BLOCK_START}\n$env:PATH = "${npmBinDir};$env:PATH"\n${BLOCK_END}\n`;
    } else {
      block = `\n${BLOCK_START}\nexport PATH="${npmBinDir}:$PATH"\n${BLOCK_END}\n`;
    }

    fs.appendFileSync(filePath, block, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function runSetup(selfPath: string): void {
  const realClaude = findRealClaude(selfPath);
  if (realClaude) {
    saveClaudeBin(realClaude);
    console.log(`claude-switch: found claude at ${realClaude}`);
  } else {
    console.log('claude-switch: warning: could not find claude binary. Set CLAUDE_SWITCH_BIN manually if needed.');
  }

  const npmBin = getNpmBinDir();
  if (!npmBin) {
    console.log('claude-switch: warning: could not detect npm bin dir, PATH not updated.');
    return;
  }

  const configs = detectShellConfigs();
  let patched = 0;
  for (const config of configs) {
    if (patchShellConfig(config, npmBin)) {
      console.log(`claude-switch: updated ${config}`);
      patched++;
    }
  }

  if (patched > 0) {
    console.log('claude-switch: setup complete. Open a new terminal to use claude-switch.');
  } else {
    console.log('claude-switch: setup complete (PATH already configured).');
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test 2>&1 | tail -8
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/setup.ts test/setup.test.ts
git commit -m "feat: setup logic — find real claude, save bin, patch shell configs"
```

---

## Task 3: Create `bin/setup.ts` and `postinstall.js`

**Files:**
- Create: `bin/setup.ts`
- Create: `postinstall.js`

- [ ] **Step 1: Create `bin/setup.ts`**

```typescript
#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runSetup } from '../src/setup.js';

try {
  runSetup(fileURLToPath(import.meta.url));
} catch (e) {
  console.log('claude-switch: setup warning:', (e as Error).message);
}
```

- [ ] **Step 2: Create `postinstall.js`**

This is a plain JS file (no TypeScript) included in the published package. It
imports setup dynamically so it fails silently if `dist/` is not built yet
(local dev installs).

```javascript
// Runs automatically after: npm install -g @sirtheo/claude-switch
import('./dist/bin/setup.js').catch(() => {});
```

- [ ] **Step 3: Run build to verify no compile errors**

```bash
npm run build 2>&1 | head -20
```
Expected: no errors, `dist/bin/setup.js` created.

- [ ] **Step 4: Commit**

```bash
git add bin/setup.ts postinstall.js
git commit -m "feat: add postinstall entry point"
```

---

## Task 4: Update `bin/cli.ts` — saved bin + `setup` command

**Files:**
- Modify: `bin/cli.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write failing test for `setup` command parsing**

In `test/cli.test.ts`, add inside the `parseCommand` describe block:

```typescript
it('parses "switch setup"', () => {
  assert.deepEqual(parseCommand(['switch', 'setup']), { action: 'setup' });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test 2>&1 | grep "setup"
```
Expected: FAIL — `{ action: 'switch-to', target: 'setup' }` not `{ action: 'setup' }`.

- [ ] **Step 3: Update `bin/cli.ts`**

Add import at the top (after existing imports):
```typescript
import { getSavedClaudeBin, runSetup } from '../src/setup.js';
```

Add `setup` to the `Command` type union:
```typescript
| { action: 'setup' }
```

In `parseCommand`, add before `default:`:
```typescript
case 'setup': return { action: 'setup' };
```

Replace `findClaude()` with:
```typescript
function findClaude(): string {
  const saved = getSavedClaudeBin();
  if (saved) return saved;

  const selfPath = fileURLToPath(import.meta.url);
  const bin = resolve({
    envBin: process.env.CLAUDE_SWITCH_BIN || '',
    selfPath,
    pathEnv: process.env.PATH || '',
  });
  if (!bin) {
    console.error('Error: could not find the real claude binary. Run: claude switch setup');
    process.exit(1);
  }
  return bin;
}
```

Update `showHelp()` — add this line before `All other commands...`:
```typescript
  claude switch setup              Re-run first-time setup
```

Add `setup` case in `main()` switch, before `case 'passthrough'`:
```typescript
case 'setup':
  await runSetup(fileURLToPath(import.meta.url));
  break;
```

- [ ] **Step 4: Run tests**

```bash
npm test 2>&1 | tail -8
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add bin/cli.ts test/cli.test.ts
git commit -m "feat: findClaude() reads saved bin, add switch setup command"
```

---

## Task 5: Update `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Apply all changes**

Edit `package.json`:

1. Bump version: `"2.1.2"`

2. Add `postinstall` script:
```json
"postinstall": "node postinstall.js",
```

3. Add `postinstall.js` to `files`:
```json
"files": [
  "dist/bin/",
  "dist/src/",
  "LICENSE",
  "README.md",
  "postinstall.js"
],
```

- [ ] **Step 2: Verify build and tests still pass**

```bash
npm test 2>&1 | tail -8
```
Expected: all pass.

- [ ] **Step 3: Verify postinstall.js is in the publish tarball**

```bash
npm publish --dry-run 2>&1 | grep postinstall
```
Expected: `postinstall.js` listed in tarball contents.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: add postinstall hook, bump to 2.1.2"
```

---

## Task 6: Rewrite README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite `README.md`**

Replace the entire file with the content below. Key rules: no em dashes (`-`
instead of `-`), new install section reflects auto-setup, manual PATH/CLAUDE_SWITCH_BIN
instructions removed.

```markdown
# claude-switch

Instant multi-account switching for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — cross-platform.

Claude Code does not support multiple accounts. This wrapper lets you save
multiple accounts and switch between them instantly - no logout, no browser,
no re-authentication.

## Features

- **Instant switch** - swap accounts in milliseconds, no browser needed
- **Aliases** - `claude switch work` instead of typing full emails
- **Fuzzy match** - `claude switch pers` finds `personal@gmail.com`
- **Temporary switch** - `claude --as work "do something"` without changing the active account
- **Token health** - see if your token is valid, expired, or missing
- **Shell completions** - tab completion for bash, zsh, fish, PowerShell
- **Cross-platform** - macOS, Linux, Windows
- **Auto-detect** - active account is saved automatically on first run

## How it works

Claude Code stores the active account in `~/.claude.json`. Switching is a JSON
field swap - instant and offline. The browser is only needed once per account
during initial setup.

## Installation

```bash
npm install -g @sirtheo/claude-switch
```

Open a new terminal window. Done.

Verify:

```bash
claude switch --version
```

## Quick start

### 1. Your current account is saved automatically

Just run `claude` - if you are already logged in, the active account is detected
and saved:

```
Detected account: work@company.com (saved automatically)

🔑 work@company.com
```

### 2. Add another account

```bash
claude switch add
```

This opens the browser for OAuth. After authorization, you are prompted for an alias:

```
Authenticated: personal@gmail.com
Saved: personal@gmail.com
Alias (press Enter to skip): personal
Alias set: personal -> personal@gmail.com
```

### 3. Switch

```bash
claude switch personal
```

Done.

## Usage

### Switch accounts

```bash
claude switch              # interactive menu
claude switch work         # by alias
claude switch personal@gmail.com  # by email
claude switch pers         # fuzzy match
```

### Temporary switch (--as)

Use a different account for a single command without changing the active account:

```bash
claude --as personal "review this code"
claude --as work
```

The original account is automatically restored when the command finishes. If the
process is interrupted, the account is restored on the next `claude` invocation.

### List accounts

```bash
claude switch list
```

```
Saved accounts:

  * work@company.com (active) [work, w]
    personal@gmail.com [personal]
```

### Account status

```bash
claude switch status
```

```
Active account: work@company.com
  Alias: work
  Token: valid (expires in 3 days)
```

### Aliases

```bash
claude switch alias work work@company.com    # set alias
claude switch alias w work@company.com       # multiple aliases per account
claude switch alias --list                   # list all
claude switch alias --remove w               # remove
```

### Manage accounts

```bash
claude switch add                   # add new account (opens browser)
claude switch remove old@email.com  # remove saved account
```

### Shell completions

```bash
# Bash
claude switch --completions bash >> ~/.bashrc

# Zsh
claude switch --completions zsh >> ~/.zshrc

# Fish
claude switch --completions fish > ~/.config/fish/completions/claude.fish

# PowerShell
claude switch --completions powershell >> $PROFILE
```

### Re-run setup

If you install a new shell or move to a new machine:

```bash
claude switch setup
```

## VS Code

claude-switch works with Claude Code in VS Code:

1. Switch in the integrated terminal: `claude switch work`
2. Restart your Claude Code session

Already-open sessions keep their original account.

## Good to know

- **Sessions are not affected.** Switching changes which account new sessions use.
- **Browser only once per account** - during `claude switch add`.
- **No logout.** Tokens stay valid. Switching is just a local config change.
- **Auto-save.** Active accounts are detected and saved automatically.

## Custom binary path

If the real `claude` binary cannot be found automatically:

```bash
export CLAUDE_SWITCH_BIN="/custom/path/to/claude"
```

Or re-run setup:

```bash
claude switch setup
```

## Requirements

- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

## Security

- Account profiles stored in `~/.claude/accounts/` with `600` permissions (owner-only)
- No data sent anywhere - everything stays local
- No logout performed - tokens are never invalidated

## License

MIT
```

- [ ] **Step 2: Verify the file has no em dashes**

```bash
grep -n " — " README.md | wc -l
```
Expected: `0`

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README - auto-setup flow, no em dashes"
```

---

## Task 7: npm version cleanup and publish

- [ ] **Step 1: Check if v2.1.0 is within the 72h unpublish window**

```bash
npm view @sirtheo/claude-switch time --json 2>&1 | head -20
```

If `2.1.0` publish time is within 72 hours of now (2026-04-03), proceed to
unpublish. Otherwise skip to Step 3.

- [ ] **Step 2: Unpublish v2.1.0 (if within 72h)**

```bash
npm unpublish @sirtheo/claude-switch@2.1.0 --otp=<CODE>
```

- [ ] **Step 3: Deprecate v2.1.0 (if past 72h)**

```bash
npm deprecate @sirtheo/claude-switch@2.1.0 "Broken release - bin entry was removed by npm. Install @sirtheo/claude-switch@latest instead." --otp=<CODE>
```

- [ ] **Step 4: Also deprecate v2.1.1 (it was never actually published but just in case)**

```bash
npm deprecate @sirtheo/claude-switch@2.1.1 "Superseded by 2.1.2 which includes auto-setup." --otp=<CODE> 2>/dev/null || true
```

- [ ] **Step 5: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 6: Publish v2.1.2**

```bash
npm publish --access public --otp=<CODE>
```

- [ ] **Step 7: Verify install works end-to-end**

```bash
npm install -g @sirtheo/claude-switch
# Expected output:
# claude-switch: found claude at /usr/local/bin/claude (or similar)
# claude-switch: updated ~/.zshrc
# claude-switch: setup complete. Open a new terminal to use claude-switch.
```

Open a new terminal, then:

```bash
which claude           # should be /opt/homebrew/bin/claude (or npm global bin)
claude switch --version  # should show: claude-switch 2.1.2
```
