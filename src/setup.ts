import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolve } from './resolver.js';
import { claudeBinFile } from './paths.js';

const BLOCK_START = '# claude-switch';
const BLOCK_END = '# end claude-switch';

// Magic string we use to detect another claude-switch wrapper (so we don't
// recursively spawn ourselves). Kept in sync with src/resolver.ts.
const WRAPPER_MAGIC = 'claude-switch';

function isClaudeSwitchWrapper(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    fs.readSync(fd, buf, 0, 512, 0);
    return buf.toString('utf-8').includes(WRAPPER_MAGIC);
  } catch {
    return false; // unreadable/missing → treat as not-a-wrapper
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

export function getSavedClaudeBin(binFile?: string): string | null {
  try {
    const file = binFile ?? claudeBinFile();

    // Reject the bin-pointer file itself if it is a symlink — an attacker who
    // can flip the symlink to /etc/passwd would otherwise have the real claude
    // binary read from somewhere unexpected.
    const ptrStat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!ptrStat || ptrStat.isSymbolicLink()) return null;

    const bin = fs.readFileSync(file, 'utf-8').trim();
    if (!bin) return null;
    fs.accessSync(bin, fs.constants.X_OK);

    // Avoid infinite spawn loops if .claude-bin somehow points back at us.
    if (isClaudeSwitchWrapper(bin)) return null;

    return bin;
  } catch {
    return null; // any read/stat/access failure → no usable saved bin
  }
}

export function saveClaudeBin(binPath: string, binFile?: string): void {
  const file = binFile ?? claudeBinFile();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, binPath, 'utf-8');
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
  }
}

export function findRealClaude(selfPath: string): string | null {
  const fromPath = resolve({ envBin: process.env.CLAUDE_SWITCH_BIN || '', selfPath, pathEnv: process.env.PATH || '' });
  if (fromPath) return fromPath;
  return resolve({ envBin: process.env.CLAUDE_SWITCH_BIN || '', selfPath, pathEnv: undefined });
}

export function getNpmBinDir(): string | null {
  const prefix = process.env.npm_config_prefix;
  if (!prefix) return null;
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

export function detectShellConfigs(home?: string): string[] {
  const h = home ?? os.homedir();
  const candidates: string[] = [
    path.join(h, '.zshrc'),
    path.join(h, '.bashrc'),
    path.join(h, '.bash_profile'),
    path.join(h, '.config', 'fish', 'config.fish'),
  ];

  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || h;
    candidates.push(
      path.join(userProfile, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      path.join(userProfile, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    );
  }

  return candidates.filter(f => {
    try { fs.accessSync(f); return true; } catch { return false; } // not present → don't include
  });
}

export function patchShellConfig(filePath: string, npmBinDir: string): boolean {
  if (/["\n`$]/.test(npmBinDir)) {
    return false;
  }
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
    return false; // couldn't read/write the rc file → report PATH not patched
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
