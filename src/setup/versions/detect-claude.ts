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

// Install-method detection for `claude`. Split intent:
//
//   - DETECTION is informative — we want the GUI row to read
//     "Claude Code · [brew]" / "[npm]" / "[manual]" so the user knows
//     where the binary actually lives. Probed by asking the relevant
//     package manager directly (NOT by sniffing the path prefix, which
//     lies when /opt/homebrew/bin/claude is a symlink to something
//     unrelated — e.g. our own claude-switch).
//
//   - EXECUTION is delegated — every install of Claude Code ships
//     `claude update`, and Anthropic knows their own matrix better
//     than we ever will (standalone Mach-O, brew cask, npm global,
//     future Windows Store / apt repo / whatever). install-commands.ts
//     therefore emits ['claude', 'update'] for the claude target
//     regardless of detected source. The detected source feeds the
//     label only, not the action.
//
// Net: smart UI + one-click reliable update.

/** Display-only install-method probe: which package manager (if any)
 *  knows about Claude Code on this machine. Drives the chip label on
 *  the GUI row; the upgrade action itself always goes through
 *  `claude update` (Anthropic's self-updater). See file header. */
function detectInstallMethod(proc: ProcessPort): VersionTarget['source'] {
  // brew cask: `brew list --cask claude-code` exits 0 only when the cask
  // is genuinely installed (different from "the binary lives under the
  // brew prefix", which is a symlink-aware false positive).
  const brew = proc.spawnSync('brew', ['list', '--cask', 'claude-code'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (brew.status === 0) return 'brew';
  // npm global: parseable mode prints the install path; empty stdout
  // means the package isn't actually globally installed even if the
  // command exits 0 (newer npm behaviour).
  const npmLs = proc.spawnSync(
    'npm',
    ['ls', '-g', '--depth=0', '--parseable', NPM_PACKAGE],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (npmLs.status === 0 && npmLs.stdout.toString('utf8').includes(NPM_PACKAGE)) {
    return 'npm';
  }
  // Anything else (standalone binary, Anthropic native installer, etc.)
  // is labelled 'manual'. The Update button still works — it delegates
  // to `claude update` which knows how to upgrade itself.
  return 'manual';
}

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
  const source = detectInstallMethod(proc);
  const latest = await fetchNpmLatest(NPM_PACKAGE, { http: deps.http });
  return {
    current,
    latest,
    source,
    upgradable: current !== null && latest !== null && isNewer(current, latest),
    lastCheckedAt,
    // The doc URL is the fallback when even `claude update` doesn't
    // exist (very old install) — UI surfaces it as a manual link.
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
