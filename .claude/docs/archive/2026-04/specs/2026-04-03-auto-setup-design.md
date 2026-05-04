---
title: Auto-setup on install
date: 2026-04-03
status: approved
---

# Auto-setup on install

## Problem

When `npm install -g @sirtheo/claude-switch` runs, the wrapper is placed in the
npm global bin dir (e.g. `/opt/homebrew/bin`). If the real Claude Code binary is
earlier in PATH (e.g. `/Users/example/.local/bin`), the wrapper is never invoked.
The user must manually fix their PATH and set `CLAUDE_SWITCH_BIN`. This is
unacceptable for a tool that should just work.

## Goal

`npm install -g @sirtheo/claude-switch` fully configures the system. The only
required user action is opening a new terminal window.

## Architecture

### New files

- `bin/setup.ts` - entry point for the postinstall script
- `src/setup.ts` - all setup logic

### Modified files

- `src/paths.ts` - add `claudeBinFile()` returning `~/.claude/accounts/.claude-bin`
- `bin/cli.ts` - `findClaude()` checks saved bin path before PATH scan
- `package.json` - add `postinstall`, `setup` command, bump version
- `README.md` - rewrite with new install flow, no em dashes

## Data flow

### Install time (postinstall)

```
npm install -g
  postinstall: node dist/bin/setup.js
    1. findRealClaude(selfPath, PATH) - scan PATH + known paths, skip wrappers
    2. saveClaudeBin(path) - write to ~/.claude/accounts/.claude-bin
    3. detectShellConfigs() - find existing shell config files
    4. patchShellConfig(file, npmBinDir) - prepend npm bin to PATH (idempotent)
    5. print success + "open a new terminal"
  exit 0 always (never block the install)
```

### Runtime (every `claude` invocation)

```
findClaude()
  1. read ~/.claude/accounts/.claude-bin
  2. if file exists and path is executable: return it
  3. else: fall back to resolver PATH scan (existing logic)
```

## Shell config patching

Detected automatically. Each file is patched only if the block is not already
present (idempotent re-runs).

| Platform | Shell | Config file |
|----------|-------|-------------|
| macOS/Linux | zsh | `~/.zshrc` |
| macOS/Linux | bash | `~/.bashrc`, `~/.bash_profile` |
| macOS/Linux | fish | `~/.config/fish/config.fish` |
| Windows | PowerShell | `$PROFILE` (resolved via USERPROFILE env var) |

Block written (bash/zsh):
```bash
# claude-switch
export PATH="<npm-bin>:$PATH"
# end claude-switch
```

Block written (fish):
```fish
# claude-switch
fish_add_path <npm-bin>
# end claude-switch
```

Block written (PowerShell):
```powershell
# claude-switch
$env:PATH = "<npm-bin>;$env:PATH"
# end claude-switch
```

npm bin dir is derived from `process.env.npm_config_prefix` (set by npm during
lifecycle scripts):
- Unix: `path.join(prefix, 'bin')`
- Windows: `prefix` (npm puts bins directly in prefix)

## Finding the real claude

`findRealClaude(selfPath)` extends the existing `resolve()` logic:

1. Scan PATH dirs for `claude` (same as resolver)
2. Skip self (same path as `selfPath`)
3. Skip other claude-switch wrappers (check first 512 bytes)
4. Also scan known paths not necessarily in PATH:
   - macOS: `/usr/local/bin/claude`, `~/.local/bin/claude`,
     `~/.npm-global/bin/claude`
   - Linux: `/usr/bin/claude`, `/usr/local/bin/claude`,
     `~/.local/bin/claude`
   - Windows: `%APPDATA%\npm\claude.cmd`,
     `%ProgramFiles%\nodejs\claude.cmd`
5. Return first match found

## CLI command

`claude switch setup` re-runs the full setup. Useful if the user installs on a
new machine or adds a new shell.

## Error handling

- Real claude not found: print warning, continue (user can set CLAUDE_SWITCH_BIN manually)
- Shell config not writable: print warning with manual instructions, continue
- Any unexpected error: catch, print, exit 0 (never block the install)
- `findClaude()` at runtime: if saved bin is gone or non-executable, falls back
  to resolver silently

## npm version cleanup

- `npm unpublish @sirtheo/claude-switch@2.1.0` if within 72h window
- Otherwise `npm deprecate @sirtheo/claude-switch@2.1.0 "broken release, upgrade to 2.1.1+"`
- Publish v2.1.2 (includes auto-setup)

## README rewrite

- No em dashes
- New install section: single command, open new terminal
- Remove manual PATH/CLAUDE_SWITCH_BIN instructions
- Keep all existing feature documentation
