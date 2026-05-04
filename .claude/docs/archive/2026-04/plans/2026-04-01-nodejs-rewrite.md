# claude-switch Node.js Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite claude-switch from a zsh script to a cross-platform Node.js CLI, published on npm.

**Architecture:** Single npm package with `bin.claude` entry point. Modules: paths (cross-platform paths), accounts (CRUD), resolver (find real binary), proxy (passthrough), switcher (interactive + fuzzy match). Zero external dependencies — Node.js stdlib only (ESM).

**Tech Stack:** Node.js (ESM), `node:test` for testing, `node:readline` for interactive input, `node:child_process` for proxy.

**Note:** All process spawning uses `spawnSync` (not `exec`) to avoid shell injection. On Windows, `.cmd` files use `shell: true` with `spawnSync` — this is safe because the command is a resolved binary path, not user input.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `bin/cli.js`
- Create: `.gitignore` (replace existing)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-switch",
  "version": "2.0.0",
  "description": "Instant multi-account switching for Claude Code — cross-platform",
  "type": "module",
  "bin": {
    "claude": "./bin/cli.js"
  },
  "scripts": {
    "test": "node --test test/**/*.test.js"
  },
  "keywords": ["claude", "claude-code", "multi-account", "switch"],
  "author": "SIRTHEO",
  "license": "MIT",
  "engines": {
    "node": ">=18.0.0"
  },
  "files": [
    "bin/",
    "src/",
    "LICENSE",
    "README.md"
  ]
}
```

- [ ] **Step 2: Create `bin/cli.js` stub**

```js
#!/usr/bin/env node
// claude-switch — Claude Code multi-account wrapper

console.log('claude-switch v2.0.0 — stub');
process.exit(0);
```

- [ ] **Step 3: Update `.gitignore`**

```
node_modules/
.claude/
```

- [ ] **Step 4: Verify the stub runs**

Run: `node bin/cli.js`
Expected: `claude-switch v2.0.0 — stub`

- [ ] **Step 5: Commit**

```bash
git add package.json bin/cli.js .gitignore
git commit -m "feat: scaffold Node.js project structure"
```

---

### Task 2: Cross-Platform Paths Module

**Files:**
- Create: `src/paths.js`
- Create: `test/paths.test.js`

- [ ] **Step 1: Write failing test for `paths.js`**

```js
// test/paths.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeJsonPath, accountsDir } from '../src/paths.js';
import os from 'node:os';
import path from 'node:path';

describe('paths', () => {
  it('claudeJsonPath points to ~/.claude.json', () => {
    assert.equal(claudeJsonPath(), path.join(os.homedir(), '.claude.json'));
  });

  it('accountsDir points to ~/.claude/accounts', () => {
    assert.equal(accountsDir(), path.join(os.homedir(), '.claude', 'accounts'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paths.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/paths.js`**

```js
// src/paths.js
import os from 'node:os';
import path from 'node:path';

export function claudeJsonPath() {
  return path.join(os.homedir(), '.claude.json');
}

export function accountsDir() {
  return path.join(os.homedir(), '.claude', 'accounts');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paths.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/paths.js test/paths.test.js
git commit -m "feat: add cross-platform paths module"
```

---

### Task 3: Accounts Module — `getCurrent()`

**Files:**
- Create: `src/accounts.js`
- Create: `test/accounts.test.js`

- [ ] **Step 1: Write failing tests**

```js
// test/accounts.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCurrent } from '../src/accounts.js';

describe('getCurrent', () => {
  let tmpDir;
  let claudeJson;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    claudeJson = path.join(tmpDir, '.claude.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns email from oauthAccount', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'test@example.com' }
    }));
    assert.equal(getCurrent(claudeJson), 'test@example.com');
  });

  it('returns empty string when no oauthAccount', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    assert.equal(getCurrent(claudeJson), '');
  });

  it('returns empty string when file does not exist', () => {
    assert.equal(getCurrent(claudeJson), '');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/accounts.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `getCurrent`**

```js
// src/accounts.js
import fs from 'node:fs';
import path from 'node:path';

export function getCurrent(claudeJsonPath) {
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    return data?.oauthAccount?.emailAddress || '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/accounts.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/accounts.js test/accounts.test.js
git commit -m "feat: add getCurrent account reader"
```

---

### Task 4: Accounts Module — `save()` and `load()`

**Files:**
- Modify: `src/accounts.js`
- Modify: `test/accounts.test.js`

- [ ] **Step 1: Write failing tests for `save` and `load`**

Add to `test/accounts.test.js`:

```js
import { getCurrent, save, load } from '../src/accounts.js';

describe('save', () => {
  let tmpDir;
  let claudeJson;
  let accDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves oauthAccount to accounts dir', () => {
    const oauthAccount = { emailAddress: 'a@b.com', token: 'tok123' };
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount }));
    save('a@b.com', claudeJson, accDir);

    const saved = JSON.parse(fs.readFileSync(path.join(accDir, 'a@b.com.json'), 'utf-8'));
    assert.deepEqual(saved, oauthAccount);
  });

  it('creates accounts dir if missing', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'x@y.com' } }));
    save('x@y.com', claudeJson, accDir);
    assert.ok(fs.existsSync(accDir));
  });

  it('sets 0o600 permissions on account file (unix)', () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'x@y.com' } }));
    save('x@y.com', claudeJson, accDir);
    const stat = fs.statSync(path.join(accDir, 'x@y.com.json'));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe('load', () => {
  let tmpDir;
  let claudeJson;
  let accDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads oauthAccount into claude.json', () => {
    const existing = { someKey: 'value', oauthAccount: { emailAddress: 'old@x.com' } };
    fs.writeFileSync(claudeJson, JSON.stringify(existing));

    const newAccount = { emailAddress: 'new@x.com', token: 'newtok' };
    fs.writeFileSync(path.join(accDir, 'new@x.com.json'), JSON.stringify(newAccount));

    load('new@x.com', claudeJson, accDir);

    const result = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(result.someKey, 'value');
    assert.deepEqual(result.oauthAccount, newAccount);
  });

  it('throws when account file does not exist', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({}));
    assert.throws(() => load('nope@x.com', claudeJson, accDir), /no saved account/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/accounts.test.js`
Expected: FAIL — `save` and `load` not exported

- [ ] **Step 3: Implement `save` and `load`**

Add to `src/accounts.js`:

```js
export function save(email, claudeJsonPath, accountsDirPath) {
  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });

  const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  const accountFile = path.join(accountsDirPath, `${email}.json`);

  fs.writeFileSync(accountFile, JSON.stringify(data.oauthAccount || {}, null, 2));
  if (process.platform !== 'win32') {
    fs.chmodSync(accountFile, 0o600);
  }
}

export function load(email, claudeJsonPath, accountsDirPath) {
  const accountFile = path.join(accountsDirPath, `${email}.json`);

  if (!fs.existsSync(accountFile)) {
    throw new Error(`No saved account for ${email}`);
  }

  const accountData = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
  const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  data.oauthAccount = accountData;

  const tmp = claudeJsonPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0));
  fs.renameSync(tmp, claudeJsonPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(claudeJsonPath, 0o600);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/accounts.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/accounts.js test/accounts.test.js
git commit -m "feat: add save and load account operations"
```

---

### Task 5: Accounts Module — `list()` and `remove()`

**Files:**
- Modify: `src/accounts.js`
- Modify: `test/accounts.test.js`

- [ ] **Step 1: Write failing tests**

Add to `test/accounts.test.js`:

```js
import { getCurrent, save, load, list, remove } from '../src/accounts.js';

describe('list', () => {
  let tmpDir;
  let accDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns list of saved emails', () => {
    fs.writeFileSync(path.join(accDir, 'a@b.com.json'), '{}');
    fs.writeFileSync(path.join(accDir, 'c@d.com.json'), '{}');
    const result = list(accDir);
    assert.deepEqual(result.sort(), ['a@b.com', 'c@d.com']);
  });

  it('returns empty array when no accounts', () => {
    assert.deepEqual(list(accDir), []);
  });

  it('returns empty array when dir does not exist', () => {
    assert.deepEqual(list(path.join(tmpDir, 'nope')), []);
  });
});

describe('remove', () => {
  let tmpDir;
  let accDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes account file', () => {
    fs.writeFileSync(path.join(accDir, 'a@b.com.json'), '{}');
    remove('a@b.com', accDir);
    assert.ok(!fs.existsSync(path.join(accDir, 'a@b.com.json')));
  });

  it('throws when account does not exist', () => {
    assert.throws(() => remove('nope@x.com', accDir), /no saved account/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/accounts.test.js`
Expected: FAIL — `list` and `remove` not exported

- [ ] **Step 3: Implement `list` and `remove`**

Add to `src/accounts.js`:

```js
export function list(accountsDirPath) {
  try {
    const files = fs.readdirSync(accountsDirPath);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export function remove(email, accountsDirPath) {
  const accountFile = path.join(accountsDirPath, `${email}.json`);
  if (!fs.existsSync(accountFile)) {
    throw new Error(`No saved account for ${email}`);
  }
  fs.unlinkSync(accountFile);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/accounts.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/accounts.js test/accounts.test.js
git commit -m "feat: add list and remove account operations"
```

---

### Task 6: Binary Resolver

**Files:**
- Create: `src/resolver.js`
- Create: `test/resolver.test.js`

- [ ] **Step 1: Write failing tests**

```js
// test/resolver.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolve } from '../src/resolver.js';

describe('resolver', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns CLAUDE_SWITCH_BIN if set', () => {
    const result = resolve({
      envBin: '/custom/path/claude',
      selfPath: '/some/other/path',
      pathEnv: '',
    });
    assert.equal(result, '/custom/path/claude');
  });

  it('finds claude in PATH, skipping self', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const fakeClaude = path.join(binDir, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\necho real');
    fs.chmodSync(fakeClaude, 0o755);

    const result = resolve({
      envBin: '',
      selfPath: '/different/path/cli.js',
      pathEnv: binDir,
    });
    assert.equal(result, fakeClaude);
  });

  it('skips candidate that resolves to self', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const selfFile = path.join(binDir, 'claude');
    fs.writeFileSync(selfFile, '#!/usr/bin/env node\n// claude-switch');
    fs.chmodSync(selfFile, 0o755);

    const result = resolve({
      envBin: '',
      selfPath: fs.realpathSync(selfFile),
      pathEnv: binDir,
    });
    assert.equal(result, null);
  });

  it('skips other claude-switch wrappers', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const wrapper = path.join(binDir, 'claude');
    fs.writeFileSync(wrapper, '#!/usr/bin/env zsh\n# claude-switch wrapper\necho hi');
    fs.chmodSync(wrapper, 0o755);

    const result = resolve({
      envBin: '',
      selfPath: '/other/path/cli.js',
      pathEnv: binDir,
    });
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolver.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/resolver.js`**

```js
// src/resolver.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KNOWN_PATHS = {
  darwin: ['/usr/local/bin/claude', path.join(os.homedir(), '.npm-global', 'bin', 'claude')],
  linux: ['/usr/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.local', 'bin', 'claude')],
  win32: [],
};

function getKnownPaths() {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const progFiles = process.env.ProgramFiles || '';
    return [
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(progFiles, 'nodejs', 'claude.cmd'),
    ];
  }
  return KNOWN_PATHS[platform] || KNOWN_PATHS.linux;
}

function isClaudeSwitchWrapper(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    return buf.toString('utf-8').includes('claude-switch');
  } catch {
    return false;
  }
}

function candidateNames() {
  if (process.platform === 'win32') {
    return ['claude.cmd', 'claude.exe', 'claude'];
  }
  return ['claude'];
}

export function resolve({ envBin, selfPath, pathEnv }) {
  // Tier 1: explicit env var
  if (envBin) return envBin;

  const separator = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv ? pathEnv.split(separator) : [];
  const names = candidateNames();

  // Tier 2: PATH scan
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);

      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }

      // Skip self
      try {
        if (fs.realpathSync(candidate) === selfPath) continue;
      } catch {
        continue;
      }

      // Skip other claude-switch wrappers
      if (isClaudeSwitchWrapper(candidate)) continue;

      return candidate;
    }
  }

  // Tier 3: known paths fallback
  for (const knownPath of getKnownPaths()) {
    try {
      fs.accessSync(knownPath, fs.constants.X_OK);
    } catch {
      continue;
    }
    if (isClaudeSwitchWrapper(knownPath)) continue;
    try {
      if (fs.realpathSync(knownPath) === selfPath) continue;
    } catch {
      continue;
    }
    return knownPath;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/resolver.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/resolver.js test/resolver.test.js
git commit -m "feat: add three-tier binary resolver"
```

---

### Task 7: Proxy Module

**Files:**
- Create: `src/proxy.js`
- Create: `test/proxy.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/proxy.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpawnArgs } from '../src/proxy.js';

describe('proxy', () => {
  it('builds spawn args for unix', () => {
    const result = buildSpawnArgs('/usr/local/bin/claude', ['--help'], 'darwin');
    assert.deepEqual(result, {
      command: '/usr/local/bin/claude',
      args: ['--help'],
      options: { stdio: 'inherit' },
    });
  });

  it('builds spawn args for windows .cmd', () => {
    const result = buildSpawnArgs('C:\\npm\\claude.cmd', ['--help'], 'win32');
    assert.deepEqual(result, {
      command: 'C:\\npm\\claude.cmd',
      args: ['--help'],
      options: { stdio: 'inherit', shell: true },
    });
  });

  it('builds spawn args for windows non-cmd', () => {
    const result = buildSpawnArgs('C:\\bin\\claude.exe', ['--help'], 'win32');
    assert.deepEqual(result, {
      command: 'C:\\bin\\claude.exe',
      args: ['--help'],
      options: { stdio: 'inherit' },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/proxy.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/proxy.js`**

```js
// src/proxy.js
import { spawnSync } from 'node:child_process';

export function buildSpawnArgs(binaryPath, args, platform) {
  const options = { stdio: 'inherit' };

  // On Windows, .cmd files must be run via shell
  if (platform === 'win32' && binaryPath.endsWith('.cmd')) {
    options.shell = true;
  }

  return { command: binaryPath, args, options };
}

export function run(binaryPath, args) {
  const { command, args: spawnArgs, options } = buildSpawnArgs(
    binaryPath,
    args,
    process.platform
  );
  const result = spawnSync(command, spawnArgs, options);

  if (result.error) {
    console.error(`Error: could not run claude: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/proxy.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/proxy.js test/proxy.test.js
git commit -m "feat: add cross-platform proxy module"
```

---

### Task 8: Switcher Module — Fuzzy Match

**Files:**
- Create: `src/switcher.js`
- Create: `test/switcher.test.js`

- [ ] **Step 1: Write failing tests**

```js
// test/switcher.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch } from '../src/switcher.js';

describe('fuzzyMatch', () => {
  const accounts = ['work@company.com', 'personal@gmail.com', 'test@company.com'];

  it('returns exact match', () => {
    assert.deepEqual(fuzzyMatch('work@company.com', accounts), ['work@company.com']);
  });

  it('returns single partial match', () => {
    assert.deepEqual(fuzzyMatch('personal', accounts), ['personal@gmail.com']);
  });

  it('returns multiple matches when ambiguous', () => {
    assert.deepEqual(fuzzyMatch('company', accounts), ['work@company.com', 'test@company.com']);
  });

  it('returns empty when no match', () => {
    assert.deepEqual(fuzzyMatch('nope', accounts), []);
  });

  it('is case-insensitive', () => {
    assert.deepEqual(fuzzyMatch('PERSONAL', accounts), ['personal@gmail.com']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/switcher.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement fuzzyMatch**

```js
// src/switcher.js
export function fuzzyMatch(input, accounts) {
  const lower = input.toLowerCase();

  // Exact match first
  const exact = accounts.find(a => a === input);
  if (exact) return [exact];

  // Partial match (case-insensitive)
  return accounts.filter(a => a.toLowerCase().includes(lower));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/switcher.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/switcher.js test/switcher.test.js
git commit -m "feat: add fuzzy match for account switching"
```

---

### Task 9: Switcher Module — `switchTo` and `switchInteractive`

**Files:**
- Modify: `src/switcher.js`
- Modify: `test/switcher.test.js`

- [ ] **Step 1: Write failing tests for `switchTo`**

Add to `test/switcher.test.js`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach } from 'node:test';
import { fuzzyMatch, switchTo } from '../src/switcher.js';

describe('switchTo', () => {
  let tmpDir;
  let claudeJson;
  let accDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-switch-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('switches to target account', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'old@x.com', token: 'old' }
    }));
    fs.writeFileSync(path.join(accDir, 'new@x.com.json'), JSON.stringify({
      emailAddress: 'new@x.com', token: 'new'
    }));

    const msg = switchTo('new@x.com', claudeJson, accDir);
    assert.match(msg, /switched to new@x.com/i);

    const result = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    assert.equal(result.oauthAccount.emailAddress, 'new@x.com');
  });

  it('saves current account before switching', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'old@x.com', token: 'old' }
    }));
    fs.writeFileSync(path.join(accDir, 'new@x.com.json'), JSON.stringify({
      emailAddress: 'new@x.com', token: 'new'
    }));

    switchTo('new@x.com', claudeJson, accDir);
    const savedOld = JSON.parse(fs.readFileSync(path.join(accDir, 'old@x.com.json'), 'utf-8'));
    assert.equal(savedOld.token, 'old');
  });

  it('returns already-active message when switching to current', () => {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'a@x.com' }
    }));

    const msg = switchTo('a@x.com', claudeJson, accDir);
    assert.match(msg, /already on/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/switcher.test.js`
Expected: FAIL — `switchTo` not exported

- [ ] **Step 3: Implement `switchTo`**

Add to `src/switcher.js`:

```js
import { getCurrent, save, load } from './accounts.js';

export function switchTo(targetEmail, claudeJsonPath, accountsDirPath) {
  const currentEmail = getCurrent(claudeJsonPath);

  if (targetEmail === currentEmail) {
    return `Already on ${targetEmail}`;
  }

  if (currentEmail) {
    save(currentEmail, claudeJsonPath, accountsDirPath);
  }

  load(targetEmail, claudeJsonPath, accountsDirPath);
  return `Switched to ${targetEmail}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/switcher.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/switcher.js test/switcher.test.js
git commit -m "feat: add switchTo with auto-save of current account"
```

---

### Task 10: Switcher Module — `switchInteractive` and `addAccount`

**Files:**
- Modify: `src/switcher.js`

- [ ] **Step 1: Implement `switchInteractive`**

Add to `src/switcher.js`:

```js
import readline from 'node:readline';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function switchInteractive(claudeJsonPath, accountsDirPath) {
  const { list } = await import('./accounts.js');
  const accounts = list(accountsDirPath);
  const currentEmail = getCurrent(claudeJsonPath);

  if (accounts.length === 0) {
    console.log('No saved accounts. Run: claude switch add');
    return;
  }

  if (accounts.length < 2) {
    console.log('Only one account saved. Run: claude switch add');
    return;
  }

  console.log('Accounts:\n');
  accounts.forEach((email, i) => {
    const marker = email === currentEmail ? ' (active)' : '';
    console.log(`  ${i + 1}) ${email}${marker}`);
  });

  const choice = await ask(`\nSwitch to [1-${accounts.length}]: `);
  const index = parseInt(choice, 10);

  if (isNaN(index) || index < 1 || index > accounts.length) {
    console.log('Invalid choice.');
    process.exit(1);
  }

  console.log(switchTo(accounts[index - 1], claudeJsonPath, accountsDirPath));
}
```

- [ ] **Step 2: Implement `addAccount`**

Add to `src/switcher.js`:

```js
import { spawnSync } from 'node:child_process';

export async function addAccount(claudeBin, claudeJsonPath, accountsDirPath) {
  const currentEmail = getCurrent(claudeJsonPath);
  const expectedEmail = await ask('Email to add (press Enter to skip): ');

  if (currentEmail) {
    save(currentEmail, claudeJsonPath, accountsDirPath);
  }

  console.log('\nLog in with the new account in your browser.\n');

  while (true) {
    spawnSync(claudeBin, ['auth', 'login'], { stdio: 'inherit' });

    const newEmail = getCurrent(claudeJsonPath);
    if (!newEmail) {
      console.log('Login failed or cancelled.');
      if (currentEmail) {
        load(currentEmail, claudeJsonPath, accountsDirPath);
      }
      process.exit(1);
    }

    console.log(`\nAuthenticated: ${newEmail}`);
    save(newEmail, claudeJsonPath, accountsDirPath);
    console.log(`Saved: ${newEmail}`);

    if (!expectedEmail || newEmail === expectedEmail) break;

    console.log(`\n(expected ${expectedEmail})`);
    const retry = await ask(`Retry login for ${expectedEmail}? [y/N]: `);
    if (retry.toLowerCase() !== 'y') break;

    console.log('\nLog in with the new account in your browser.\n');
  }
}
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `node --test test/switcher.test.js`
Expected: PASS (interactive functions tested manually)

- [ ] **Step 4: Commit**

```bash
git add src/switcher.js
git commit -m "feat: add interactive switch menu and add-account flow"
```

---

### Task 11: CLI Entry Point

**Files:**
- Modify: `bin/cli.js`
- Create: `test/cli.test.js`

- [ ] **Step 1: Write failing test for command parsing**

```js
// test/cli.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../bin/cli.js';

describe('parseCommand', () => {
  it('parses "switch" as interactive switch', () => {
    assert.deepEqual(parseCommand(['switch']), { action: 'switch-interactive' });
  });

  it('parses "switch add"', () => {
    assert.deepEqual(parseCommand(['switch', 'add']), { action: 'add' });
  });

  it('parses "switch list"', () => {
    assert.deepEqual(parseCommand(['switch', 'list']), { action: 'list' });
  });

  it('parses "switch ls" as list', () => {
    assert.deepEqual(parseCommand(['switch', 'ls']), { action: 'list' });
  });

  it('parses "switch remove email"', () => {
    assert.deepEqual(parseCommand(['switch', 'remove', 'a@b.com']), { action: 'remove', email: 'a@b.com' });
  });

  it('parses "switch rm email" as remove', () => {
    assert.deepEqual(parseCommand(['switch', 'rm', 'a@b.com']), { action: 'remove', email: 'a@b.com' });
  });

  it('parses "switch status"', () => {
    assert.deepEqual(parseCommand(['switch', 'status']), { action: 'status' });
  });

  it('parses "switch help"', () => {
    assert.deepEqual(parseCommand(['switch', 'help']), { action: 'help' });
  });

  it('parses "switch --completions bash"', () => {
    assert.deepEqual(parseCommand(['switch', '--completions', 'bash']), { action: 'completions', shell: 'bash' });
  });

  it('parses "switch email" as switch-to', () => {
    assert.deepEqual(parseCommand(['switch', 'a@b.com']), { action: 'switch-to', target: 'a@b.com' });
  });

  it('parses non-switch commands as passthrough', () => {
    assert.deepEqual(parseCommand(['--help']), { action: 'passthrough', args: ['--help'] });
  });

  it('parses empty args as passthrough', () => {
    assert.deepEqual(parseCommand([]), { action: 'passthrough', args: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli.test.js`
Expected: FAIL — `parseCommand` not exported

- [ ] **Step 3: Implement `bin/cli.js`**

```js
#!/usr/bin/env node
// claude-switch — Claude Code multi-account wrapper

import { resolve } from '../src/resolver.js';
import { getCurrent, save, list as listAccounts, remove as removeAccount } from '../src/accounts.js';
import { fuzzyMatch, switchTo, switchInteractive, addAccount } from '../src/switcher.js';
import { run as proxyRun } from '../src/proxy.js';
import { claudeJsonPath, accountsDir } from '../src/paths.js';
import { generateBash, generateZsh, generateFish, generatePowerShell } from '../src/completions.js';
import fs from 'node:fs';

export function parseCommand(args) {
  if (args[0] !== 'switch') {
    return { action: 'passthrough', args };
  }

  const sub = args[1];
  if (!sub) return { action: 'switch-interactive' };

  switch (sub) {
    case 'add': return { action: 'add' };
    case 'list':
    case 'ls': return { action: 'list' };
    case 'remove':
    case 'rm': return { action: 'remove', email: args[2] };
    case 'status': return { action: 'status' };
    case 'help':
    case '--help':
    case '-h': return { action: 'help' };
    case '--completions': return { action: 'completions', shell: args[2] };
    default: return { action: 'switch-to', target: sub };
  }
}

function findClaude() {
  const selfPath = fs.realpathSync(new URL(import.meta.url).pathname);
  const bin = resolve({
    envBin: process.env.CLAUDE_SWITCH_BIN || '',
    selfPath,
    pathEnv: process.env.PATH || '',
  });
  if (!bin) {
    console.error('Error: could not find the real claude binary in PATH.');
    process.exit(1);
  }
  return bin;
}

function showHelp() {
  console.log(`claude-switch — multi-account wrapper for Claude Code

Usage:
  claude switch                  Switch account (interactive menu)
  claude switch <email>          Switch to a specific account (fuzzy match)
  claude switch add              Add a new account (opens browser)
  claude switch list             List saved accounts
  claude switch remove <email>   Remove a saved account
  claude switch status           Show active account
  claude switch help             Show this help
  claude switch --completions <shell>  Generate shell completions

All other commands are passed through to the real claude binary.`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = parseCommand(args);
  const cJson = claudeJsonPath();
  const aDir = accountsDir();

  switch (cmd.action) {
    case 'switch-interactive':
      await switchInteractive(cJson, aDir);
      break;

    case 'switch-to': {
      const accounts = listAccounts(aDir);
      const matches = fuzzyMatch(cmd.target, accounts);
      if (matches.length === 1) {
        console.log(switchTo(matches[0], cJson, aDir));
      } else if (matches.length > 1) {
        console.log('Multiple matches:');
        matches.forEach(m => console.log(`  ${m}`));
        console.log('Be more specific.');
      } else {
        console.log(`No account matching "${cmd.target}". Run: claude switch list`);
      }
      break;
    }

    case 'add': {
      const claudeBin = findClaude();
      await addAccount(claudeBin, cJson, aDir);
      break;
    }

    case 'list': {
      const accounts = listAccounts(aDir);
      const current = getCurrent(cJson);
      if (accounts.length === 0) {
        console.log('No saved accounts. Run: claude switch add');
      } else {
        console.log('Saved accounts:\n');
        for (const email of accounts) {
          const marker = email === current ? '  * ' : '    ';
          console.log(`${marker}${email}${email === current ? ' (active)' : ''}`);
        }
      }
      break;
    }

    case 'remove':
      if (!cmd.email) {
        console.log('Usage: claude switch remove <email>');
        process.exit(1);
      }
      try {
        const current = getCurrent(cJson);
        if (cmd.email === current) {
          console.log('Cannot remove the active account. Switch to another account first.');
          process.exit(1);
        }
        removeAccount(cmd.email, aDir);
        console.log(`Removed: ${cmd.email}`);
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
      break;

    case 'status': {
      const current = getCurrent(cJson);
      if (current) {
        console.log(current);
      } else {
        console.log('No account connected. Run: claude switch add');
      }
      break;
    }

    case 'completions': {
      const generators = { bash: generateBash, zsh: generateZsh, fish: generateFish, powershell: generatePowerShell };
      const gen = generators[cmd.shell];
      if (!gen) {
        console.log('Usage: claude switch --completions <bash|zsh|fish|powershell>');
        process.exit(1);
      }
      console.log(gen());
      break;
    }

    case 'help':
      showHelp();
      break;

    case 'passthrough': {
      const claudeBin = findClaude();
      const email = getCurrent(cJson);

      if (email) {
        const accounts = listAccounts(aDir);
        if (accounts.length === 0) {
          save(email, cJson, aDir);
          console.log(`Detected existing account: ${email} (saved automatically)\n`);
        }
        console.log(`🔑 ${email}\n`);
      } else {
        console.error('⚠️  No account connected. Run: claude switch add');
        process.exit(1);
      }

      proxyRun(claudeBin, cmd.args);
      break;
    }
  }
}

// Only run main() when executed directly, not when imported for testing
const selfUrl = new URL(import.meta.url).pathname;
const invoked = process.argv[1];
if (invoked) {
  try {
    if (fs.realpathSync(invoked) === fs.realpathSync(selfUrl)) {
      main();
    }
  } catch {
    // If realpathSync fails, we're likely being imported
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/cli.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js test/cli.test.js
git commit -m "feat: implement CLI entry point with command routing"
```

---

### Task 12: Shell Completions

**Files:**
- Create: `src/completions.js`
- Create: `test/completions.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/completions.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/completions.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/completions.js`**

```js
// src/completions.js

const SUBCOMMANDS = ['add', 'list', 'ls', 'remove', 'rm', 'status', 'help'];

export function generateBash() {
  return `_claude_switch() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [[ "\${COMP_WORDS[1]}" == "switch" ]]; then
    if [[ $COMP_CWORD -eq 2 ]]; then
      COMPREPLY=($(compgen -W "${SUBCOMMANDS.join(' ')}" -- "$cur"))
      local accounts_dir="$HOME/.claude/accounts"
      if [[ -d "$accounts_dir" ]]; then
        local emails=$(ls "$accounts_dir"/*.json 2>/dev/null | xargs -I{} basename {} .json)
        COMPREPLY+=($(compgen -W "$emails" -- "$cur"))
      fi
    fi
  fi
}
complete -F _claude_switch claude`;
}

export function generateZsh() {
  return `#compdef claude
_claude_switch() {
  local -a subcommands accounts
  subcommands=(${SUBCOMMANDS.map(s => `'${s}'`).join(' ')})

  if (( CURRENT == 3 )) && [[ "\${words[2]}" == "switch" ]]; then
    local accounts_dir="$HOME/.claude/accounts"
    if [[ -d "$accounts_dir" ]]; then
      accounts=(\${(f)"$(ls "$accounts_dir"/*.json 2>/dev/null | xargs -I{} basename {} .json)"})
    fi
    _describe 'subcommand' subcommands
    _describe 'account' accounts
  fi
}
compdef _claude_switch claude`;
}

export function generateFish() {
  return `complete -c claude -n '__fish_seen_subcommand_from switch' -a '${SUBCOMMANDS.join(' ')}' -d 'switch subcommand'
complete -c claude -n '__fish_seen_subcommand_from switch' -a '(ls ~/.claude/accounts/*.json 2>/dev/null | xargs -I{} basename {} .json)' -d 'account'`;
}

export function generatePowerShell() {
  return `Register-ArgumentCompleter -CommandName claude -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $subcommands = @(${SUBCOMMANDS.map(s => `'${s}'`).join(', ')})
  $words = $commandAst.ToString().Split()

  if ($words.Count -ge 2 -and $words[1] -eq 'switch') {
    $subcommands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
    $accountsDir = Join-Path $env:USERPROFILE '.claude' 'accounts'
    if (Test-Path $accountsDir) {
      Get-ChildItem "$accountsDir\\*.json" | ForEach-Object {
        $email = $_.BaseName
        if ($email -like "$wordToComplete*") {
          [System.Management.Automation.CompletionResult]::new($email, $email, 'ParameterValue', $email)
        }
      }
    }
  }
}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/completions.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/completions.js test/completions.test.js
git commit -m "feat: add shell completions for bash, zsh, fish, PowerShell"
```

---

### Task 13: README Rewrite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite README.md**

```markdown
# claude-switch

Instant multi-account switching for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — cross-platform.

Claude Code doesn't support multiple accounts. This wrapper lets you save multiple accounts and switch between them **instantly** — no logout, no browser, no re-authentication.

## How it works

Claude Code determines the active account from the `oauthAccount` field in `~/.claude.json`. Switching is just a JSON field swap — instant and offline. The browser is only needed once per account, during the initial `claude switch add`.

## Installation

```bash
npm install -g claude-switch
```

This installs a `claude` wrapper that intercepts `claude switch` commands and passes everything else to the real Claude Code binary.

**Important:** The npm global bin directory must come before the real claude binary in your PATH. npm usually handles this automatically.

### Verify installation

```bash
claude switch help
```

### Upgrading from the shell script version

Account files in `~/.claude/accounts/` are fully compatible. Just:

1. Remove the old symlink: `rm ~/bin/claude`
2. Install: `npm install -g claude-switch`
3. Done — existing accounts carry over.

## Setup

The browser is needed **only during initial setup** — once per account.

### Save your current account

```bash
claude switch add
```

Press Enter when prompted for email (skips verification). This saves the currently active account.

### Add another account

```bash
claude switch add
```

Enter the email of the new account. This opens the browser for OAuth. Repeat for as many accounts as you need.

## Usage

### Switch account (interactive)

```bash
claude switch
```

```
Accounts:

  1) work@company.com (active)
  2) personal@gmail.com

Switch to [1-2]: 2
Switched to personal@gmail.com
```

### Switch by email (fuzzy match)

```bash
claude switch personal      # matches personal@gmail.com
claude switch work@company.com  # exact match
```

### List accounts

```bash
claude switch list
```

### Show active account

```bash
claude switch status
```

### Remove an account

```bash
claude switch remove old@email.com
```

### Normal usage

```bash
claude
```

Shows the active account before starting:

```
🔑 work@company.com

╭──────────────────────────────────────╮
│ ✻ Welcome to Claude Code!            │
╰──────────────────────────────────────╯
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

## Good to know

- **Already-open sessions are not affected.** Switching changes which account new sessions use.
- **The browser is only needed once per account**, during `claude switch add`.
- **No logout is ever performed.** Tokens stay valid.
- **Cross-platform:** works on macOS, Linux, and Windows.

## Custom binary path

If the real claude binary can't be found automatically:

```bash
export CLAUDE_SWITCH_BIN="/custom/path/to/claude"
```

## Requirements

- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed

## Security

- Account profiles stored in `~/.claude/accounts/` with `600` permissions (owner-only, Unix)
- No data sent anywhere — everything stays local
- No logout performed — tokens are never invalidated

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for Node.js cross-platform release"
```

---

### Task 14: Cleanup Legacy Files

**Files:**
- Remove: `claude-switch` (old zsh script)
- Remove: `install.sh` (replaced by npm install)

- [ ] **Step 1: Remove old files**

```bash
git rm claude-switch install.sh
```

- [ ] **Step 2: Commit**

```bash
git commit -m "chore: remove legacy zsh script and installer"
```

---

### Task 15: Integration Test and Manual Verification

**Files:**
- All

- [ ] **Step 1: Run full test suite**

Run: `node --test test/**/*.test.js`
Expected: ALL PASS

- [ ] **Step 2: Test npm link locally**

```bash
npm link
```

Verify `claude switch help` works.

- [ ] **Step 3: Test passthrough**

Run: `claude --version`
Expected: shows real Claude Code version (after account banner)

- [ ] **Step 4: Test interactive switch**

Run: `claude switch`
Expected: shows account menu (if accounts exist)

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes"
```

(Only if changes were needed)

---

### Task 16: Prepare for npm Publish

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify `package.json` fields**

Ensure these fields are set correctly:

```json
{
  "name": "claude-switch",
  "version": "2.0.0",
  "description": "Instant multi-account switching for Claude Code — cross-platform",
  "type": "module",
  "bin": {
    "claude": "./bin/cli.js"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/SIRTHEO/claude-switch.git"
  },
  "scripts": {
    "test": "node --test test/**/*.test.js"
  },
  "keywords": ["claude", "claude-code", "multi-account", "switch", "account-switching"],
  "author": "SIRTHEO",
  "license": "MIT",
  "engines": {
    "node": ">=18.0.0"
  },
  "files": [
    "bin/",
    "src/",
    "LICENSE",
    "README.md"
  ]
}
```

- [ ] **Step 2: Test `npm pack`**

Run: `npm pack --dry-run`
Expected output lists only: `bin/cli.js`, `src/*.js`, `LICENSE`, `README.md`, `package.json`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: finalize package.json for npm publish"
```
