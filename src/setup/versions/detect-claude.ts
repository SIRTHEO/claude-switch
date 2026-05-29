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

import path from 'node:path';

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
  /** Override homebrew prefix detection in tests. Default = sniff
   *  $(brew --prefix) at call time. */
  brewPrefix?: () => string | null;
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

/** $(brew --prefix), or null if brew isn't on PATH. Tiny invocation, fast. */
function defaultBrewPrefix(proc: ProcessPort): string | null {
  const r = proc.spawnSync('brew', ['--prefix'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return null;
  const out = r.stdout.toString('utf8').trim();
  return out.length > 0 ? out : null;
}

/** Path-prefix sniff: when `claude` lives under the brew prefix, the cask
 *  is in charge of upgrades — we mark the row as `source: 'brew'` so the
 *  GUI surfaces the right action label ("brew upgrade …"). */
function inferSource(claudePath: string, brewPrefix: string | null): 'brew' | 'npm' | 'unknown' {
  if (brewPrefix && claudePath.startsWith(brewPrefix + path.sep)) return 'brew';
  // npm global installs live under `<npm prefix>/bin/<name>` — we don't go
  // probe `npm prefix -g` because the user's setup might be nvm/asdf/Volta,
  // each with a different layout; the conservative call is to assume "npm
  // global" only when the path obviously isn't brew. The classic npm-global
  // signal is `/node_modules/` somewhere in the path.
  if (claudePath.includes('/node_modules/')) return 'npm';
  return 'unknown';
}

export async function detectClaude(deps: DetectDeps = {}): Promise<VersionTarget> {
  const proc = deps.process ?? nodeProcessAdapter;
  const now = deps.now ?? Date.now;
  const brewPrefix = (deps.brewPrefix ?? (() => defaultBrewPrefix(proc)))();
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
  const source = inferSource(claudePath, brewPrefix);
  const latest = await fetchNpmLatest(NPM_PACKAGE, { http: deps.http });
  const target: VersionTarget = {
    current,
    latest,
    source: source === 'unknown' ? 'manual' : source,
    upgradable: current !== null && latest !== null && isNewer(current, latest),
    lastCheckedAt,
  };
  // For manual installs we still want a doc URL surfaceable in the GUI.
  if (source === 'unknown') target.manualUrl = MANUAL_URL;
  return target;
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
