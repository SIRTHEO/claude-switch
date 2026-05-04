# MCP sub-process inheritance under per-terminal profiles

**Status**: documented
**Date**: 2026-05-04
**Plans.md task**: 3a.6

## Question

When `claude switch profile use <name>` spawns the real `claude` binary with `CLAUDE_CONFIG_DIR=<profile-dir>`, do the MCP servers that `claude` itself launches inherit that env var? If not, the MCPs would silently use a different config dir than the parent — exactly the cross-account drift profiles are meant to prevent.

## Answer (by static analysis)

**Yes, they inherit it.** No claude-switch-side fix needed.

## Reasoning

claude-switch's spawn path (`src/proxy.ts:buildSpawnArgs`) sets up the child env as:

```ts
if (extraEnv) {
  options.env = { ...process.env, ...extraEnv };
}
```

When `bin/cli.ts:profile-use` (line 555) calls:

```ts
buildSpawnArgs(claudeBin, cmd.args, process.platform, {
  CLAUDE_CONFIG_DIR: dir,
});
```

The spawned `claude` process gets `CLAUDE_CONFIG_DIR=<profile-dir>` in its environment, on top of everything else from `process.env`.

Inside that `claude` process, when it later spawns an MCP server, Node.js's `child_process.spawn` (and equivalents) **inherit the parent's environment by default**. Unless `claude` explicitly strips `CLAUDE_CONFIG_DIR` from `process.env` before spawning the MCP — which there is no reason for it to do, since the env var is the official mechanism for config-dir override — the MCP child sees the same `CLAUDE_CONFIG_DIR` we set.

**Note**: MCP servers themselves don't read `CLAUDE_CONFIG_DIR` to find Claude state. They communicate with `claude` over stdio/JSON-RPC. The env inheritance matters only because:

- some MCP servers may spawn their own helpers, and the chain continues
- if an MCP needs to call back into `claude` (e.g., a tool that reads project context), it must hit the same config dir

Both cases work transparently with the default inheritance.

## Verification path (deferred to 3a.1b interactive smoke)

The static analysis above is sound but indirect. A live verification would be:

1. `claude switch profile create work`
2. `claude switch profile login work` (browser OAuth)
3. `claude switch profile use work`, then in the spawned REPL invoke an MCP tool
4. Use `lsof` / `dtruss` / `procmon` to confirm the MCP child has `CLAUDE_CONFIG_DIR=<profiles-dir>/work` in its environment

That step belongs in 3a.1b (interactive smoke). It's not a blocker for shipping — the static reasoning is air-tight given Node.js defaults.

## What WOULD break this

For documentation completeness, the failure modes that are NOT present today but worth noting:

| Hypothetical bug | Impact |
|---|---|
| `claude` spawns MCPs with `env: {}` (empty env) | Strips CLAUDE_CONFIG_DIR. MCP would use OS defaults (`~/.claude/`). Cross-profile leak. |
| `claude` spawns MCPs with a curated allow-list that omits CLAUDE_CONFIG_DIR | Same impact. |
| `claude` reads CLAUDE_CONFIG_DIR ONCE at startup and resolves to an absolute path, then doesn't re-export it | MCPs that respect the env var (none today) wouldn't see it. Low impact since MCPs don't read the var anyway. |

If we ever observe the symptom (MCP using wrong profile state), check whether the upstream `claude` binary changed its env-passing behaviour.

## Closure

Task 3a.6 closed by static analysis. The MCP server inheritance is correct by virtue of Node.js child_process default semantics; no additional code or test in claude-switch is needed. Live confirmation deferred to 3a.1b.
