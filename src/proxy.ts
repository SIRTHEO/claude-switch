// src/proxy.ts
import { spawnSync } from 'node:child_process';

interface SpawnOptions {
  stdio: 'inherit';
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface SpawnArgs {
  command: string;
  args: string[];
  options: SpawnOptions;
}

export function buildSpawnArgs(
  binaryPath: string,
  args: string[],
  platform: string,
  extraEnv?: NodeJS.ProcessEnv | null,
): SpawnArgs {
  const options: SpawnOptions = { stdio: 'inherit' };

  // On Windows, .cmd files must be run via shell
  if (platform === 'win32' && binaryPath.endsWith('.cmd')) {
    options.shell = true;
  }

  if (extraEnv) {
    options.env = { ...process.env, ...extraEnv };
  }

  return { command: binaryPath, args, options };
}

export function run(binaryPath: string, args: string[], extraEnv?: NodeJS.ProcessEnv | null): never {
  const { command, args: spawnArgs, options } = buildSpawnArgs(
    binaryPath,
    args,
    process.platform,
    extraEnv,
  );
  const result = spawnSync(command, spawnArgs, options);

  if (result.error) {
    console.error(`Error: could not run claude: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
