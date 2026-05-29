// src/setup/versions/detect-claude.ts
//
// Detect the Anthropic Claude CLI (`claude` binary, npm package
// `@anthropic-ai/claude-code`). Install paths in scope (brief §9):
//
//   1. brew cask `claude-code` — binary downloaded from downloads.claude.ai,
//      typically resolves under $(brew --prefix). Latest = npm dist-tag for
//      the same package (we accept the brew-vs-npm version lag as a known
//      asymmetry — brief §9 "brew cask 2.1.145 < npm 2.1.156"). A future
//      slice may switch to `brew info --json=v2 --cask` for true brew
//      latest, but it adds a slow network call + an external CLI dep.
//   2. npm global — when @anthropic-ai/claude-code is installed globally.
//   3. manual / unknown — anything else.
//
// `current` is read from `claude --version`. The probe is sync (small
// stdout, fast exit) and goes through ProcessPort so tests can fake it.

import type { VersionTarget } from '../../contract.js';
import type { ProcessPort } from '../../platform/process.js';
import type { HttpPort } from '../../platform/http.js';
import { nodeProcessAdapter } from '../../platform/process.js';
import { fetchNpmLatest, isNewer, stripV } from './registry.js';
import type { TargetCache } from './cache.js';

const NPM_PACKAGE = '@anthropic-ai/claude-code';
const MANUAL_URL = 'https://docs.claude.com/en/docs/agents-and-tools/claude-code/setup';

interface DetectDeps {
  process?: ProcessPort;
  http?: HttpPort;
  now?: () => number;
}

/** Resolve `which claude` → an absolute path, or null when not on PATH. */
function whichClaude(proc: ProcessPort): string | null {
  // `command -v` is more portable than `which`, but on every platform we
  // ship to (darwin/linux) `which` exits 0 + prints the path. Capture only
  // stdout — `which` is silent on stderr.
  const r = proc.spawnSync('which', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return null;
  const out = r.stdout.toString('utf8').trim();
  return out.length > 0 ? out : null;
}

/** `claude --version` → "1.2.3" (strips a leading `v` and any trailing noise). */
function probeClaudeVersion(proc: ProcessPort): string | null {
  // We discard stderr on purpose: some versions print update notices there
  // which would mislead a downstream parser.
  const r = proc.spawnSync('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return null;
  const out = r.stdout.toString('utf8').trim();
  // Output shape: "1.2.3 (Claude Code)" — take the first whitespace-separated
  // token and strip a leading v.
  const first = out.split(/\s+/)[0];
  if (!first) return null;
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(first) ? stripV(first) : null;
}

// Install-method detection for `claude` is intentionally agnostic.
// Claude Code ships its own `claude update` self-updater (verified with
// `claude update --help`). That command knows its own install path
// (standalone Mach-O at ~/.local/share/claude/versions, brew cask, npm
// global, future Anthropic-blessed installers we don't know about yet).
//
// Trying to detect the install method ourselves and emit
// brew/npm/whatever commands is:
//   1. Fragile — symlinks lie (a binary at /opt/homebrew/bin/claude
//      can be a brew cask, an npm-link of an unrelated package — like
//      claude-switch itself! — or a manual relocation).
//   2. Brittle to Anthropic adding new install paths.
//   3. Risky — running `brew upgrade --cask claude-code` on a user who
//      installed manually fails with "Cask is not installed".
//
// So we just delegate. The source label is 'manual' because that's the
// VersionSource enum value that maps to "we don't drive npm/brew
// directly" — install-commands.ts picks up source='manual' for target
// 'claude' and emits ['claude', 'update']. If Anthropic ever changes the
// self-update command, that's the one line that has to change.

export async function detectClaude(deps: DetectDeps = {}): Promise<VersionTarget> {
  const proc = deps.process ?? nodeProcessAdapter;
  const now = deps.now ?? Date.now;
  const lastCheckedAt = new Date(now()).toISOString();

  const claudePath = whichClaude(proc);
  if (!claudePath) {
    // Not installed at all — `latest` is still meaningful (the user might
    // want to install) so we still hit npm.
    const latest = await fetchNpmLatest(NPM_PACKAGE, { http: deps.http });
    return {
      current: null,
      latest,
      source: 'unknown',
      upgradable: false,
      lastCheckedAt,
      manualUrl: MANUAL_URL,
    };
  }

  const current = probeClaudeVersion(proc);
  const latest = await fetchNpmLatest(NPM_PACKAGE, { http: deps.http });
  // source: 'manual' is the agnostic-delegation label. install-commands.ts
  // maps target='claude' + source='manual' to ['claude', 'update'] so the
  // Anthropic-shipped self-updater handles whatever install path the user
  // actually has. See the long comment block at the top of this file.
  return {
    current,
    latest,
    source: 'manual',
    upgradable: current !== null && latest !== null && isNewer(current, latest),
    lastCheckedAt,
    manualUrl: MANUAL_URL,
  };
}

/** Reconstruct a target from a cache hit. `current` is re-probed live (cheap,
 *  no network) because the user can `brew upgrade --cask claude-code` between
 *  versions invocations without us seeing the event. */
export function fromCache(
  cached: TargetCache,
  fetchedAt: number,
  deps: { process?: ProcessPort } = {},
): VersionTarget {
  const proc = deps.process ?? nodeProcessAdapter;
  const current = whichClaude(proc) ? probeClaudeVersion(proc) : null;
  const latest = cached.latest;
  return {
    current,
    latest,
    source: cached.source,
    upgradable: current !== null && latest !== null && isNewer(current, latest),
    lastCheckedAt: new Date(fetchedAt).toISOString(),
    ...(cached.manualUrl ? { manualUrl: cached.manualUrl } : {}),
  };
}
