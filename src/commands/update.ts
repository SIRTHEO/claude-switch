// src/commands/update.ts
// `claude switch update` — explicit update check + optional install.
// Quiet mode for non-TTY (CI / scripts) prints the install command but
// never auto-installs.

import { VERSION } from '../version.js';
import {
  fetchLatestVersionSync,
  performUpdate,
  isNewer,
  detectInstallCommand,
  writeUpdateCache,
} from '../update-check.js';
import { askYN } from './_helpers.js';

// Deps injection point for testing — callers pass `{ fetch }` to avoid
// live HTTPS requests in unit tests. The default is the real registry fetch.
interface UpdateDeps {
  fetch?: () => Promise<string | null>;
}

export async function handleUpdate(deps: UpdateDeps = {}): Promise<void> {
  const fetchFn = deps.fetch ?? fetchLatestVersionSync;
  console.log(`Current version: ${VERSION}`);
  process.stdout.write('Checking for updates...');
  const latest = await fetchFn();
  process.stdout.write(`\r${' '.repeat(30)}\r`); // clear line

  if (!latest) {
    console.log('Could not reach npm registry. Check your connection.');
    return;
  }

  // Update cache so the background notifier reflects the result.
  writeUpdateCache(latest);

  if (!isNewer(VERSION, latest)) {
    console.log(`Already up to date (${VERSION}).`);
    return;
  }

  console.log(`New version available: ${VERSION} → ${latest}`);

  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (!isTTY) {
    console.log('Run in an interactive terminal to update, or run:');
    console.log(`  ${[...detectInstallCommand()].join(' ')}`);
    return;
  }

  const shouldUpdate = await askYN('Update now? [y/N] ');
  if (!shouldUpdate) {
    console.log(`Skipped. Run: ${[...detectInstallCommand()].join(' ')}`);
    return;
  }

  const ok = performUpdate();
  if (ok) {
    console.log('\nUpdated successfully. Restart your terminal to use the new version.');
  } else {
    console.error('\nUpdate failed. Try running manually:');
    console.error(`  ${[...detectInstallCommand()].join(' ')}`);
  }
}
