// src/process.ts
// ProcessPort — the single child-process seam for the domain. Adapters
// implement it; domain functions take it via `deps` so tests can assert what
// would be spawned without actually launching a process. Mirrors the shape of
// node:child_process spawn/spawnSync, narrowed to what callers use.

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';

export interface ProcessPort {
  spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
  spawnSync(
    command: string,
    args: readonly string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncReturns<Buffer>;
}

/** Production adapter over node:child_process. */
export const nodeProcessAdapter: ProcessPort = {
  spawn: (command, args, options) => spawn(command, args, options ?? {}),
  // why: spawnSync's generic-options overload widens the return to
  // SpawnSyncReturns<string | Buffer>; with no `encoding` set it is always
  // Buffer at runtime, so narrow back to match the port contract.
  spawnSync: (command, args, options) =>
    spawnSync(command, args, options ?? {}) as SpawnSyncReturns<Buffer>,
};
