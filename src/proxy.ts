// src/proxy.ts
import { type ProcessPort, nodeProcessAdapter } from './process.js';

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
  _platform: string,
  extraEnv?: NodeJS.ProcessEnv | null,
): SpawnArgs {
  const options: SpawnOptions = { stdio: 'inherit' };

  // On Windows, .cmd files are handled by libuv/Node.js internally without
  // shell: true — libuv invokes cmd.exe with properly escaped arguments.
  // Using shell: true would pass raw argv to cmd.exe, enabling injection
  // via arguments containing & | ( ) etc. (CVE-2024-27980 pattern).

  if (extraEnv) {
    options.env = { ...process.env, ...extraEnv };
  }

  return { command: binaryPath, args, options };
}

export function run(
  binaryPath: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv | null,
  deps?: { process?: ProcessPort },
): never {
  const { command, args: spawnArgs, options } = buildSpawnArgs(
    binaryPath,
    args,
    process.platform,
    extraEnv,
  );

  // Async spawn keeps Node's event loop running so any local servers (e.g.
  // the fallback proxy on 127.0.0.1) can serve requests while claude is
  // running. spawnSync blocks the loop — fatal when claude depends on a
  // proxy hosted in this same process via ANTHROPIC_BASE_URL.
  const child = (deps?.process ?? nodeProcessAdapter).spawn(command, spawnArgs, options);

  child.on('error', (err) => {
    console.error(`Error: could not run claude: ${err.message}`);
    process.exit(1);
  });

  // Forward signals so Ctrl-C in the terminal reaches claude cleanly.
  const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* noop */ } };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGHUP', forward('SIGHUP'));

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });

  // Block here so the function's `never` contract holds — the actual exit
  // is driven by the child's 'exit' handler above.
  return new Promise<never>(() => {}) as never;
}

