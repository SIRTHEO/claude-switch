// src/proxy.ts
import { spawnSync } from 'node:child_process';

interface SpawnArgs {
  command: string;
  args: string[];
  options: { stdio: 'inherit'; shell?: boolean };
}

export function buildSpawnArgs(binaryPath: string, args: string[], platform: string): SpawnArgs {
  const options: SpawnArgs['options'] = { stdio: 'inherit' };

  // On Windows, .cmd files must be run via shell
  if (platform === 'win32' && binaryPath.endsWith('.cmd')) {
    options.shell = true;
  }

  return { command: binaryPath, args, options };
}

export function run(binaryPath: string, args: string[]): never {
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
