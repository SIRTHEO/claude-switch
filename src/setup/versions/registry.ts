// src/setup/versions/registry.ts
//
// Tiny generic fetchers for the three latest-version sources we hit from
// the multi-target versions report. Each returns a sanitised semver string
// (no leading `v`) or null on any failure (network, parse, shape).
//
// Why not reuse setup/update-check.ts's helpers: those are pinned to one
// package (claude-switch) and one endpoint. Generalising them in-place
// would widen the surface of the file under the file-size gate; a small
// dedicated helper here is cheaper and keeps the legacy banner code path
// untouched.

import type { HttpPort } from '../../platform/http.js';
import { fetchHttpAdapter, readBodyCapped } from '../../platform/http.js';

/** Strip a leading `v` so `"v1.2.3"` and `"1.2.3"` both normalise to `1.2.3`.
 *  The shape gate below already accepts both. */
export function stripV(s: string): string {
  return s.startsWith('v') ? s.slice(1) : s;
}

/** Match a semver-ish string (optional pre-release). Defence-in-depth so a
 *  compromised/MITM registry can't sneak arbitrary content into our cache. */
function looksLikeVersion(v: unknown): v is string {
  return typeof v === 'string' && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);
}

interface FetchOpts {
  http?: HttpPort;
  /** Hard cap on response body — every endpoint here returns <2 KB in
   *  practice; anything larger is suspect. */
  maxBytes?: number;
  /** Per-request abort timeout in ms. */
  timeoutMs?: number;
}

async function fetchText(url: string, opts: FetchOpts, init: { headers?: Record<string, string> } = {}): Promise<string | null> {
  const http = opts.http ?? fetchHttpAdapter;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await http(url, { signal: controller.signal, headers: init.headers });
    if (!res.ok) return null;
    const { text, tooLarge } = await readBodyCapped(res, maxBytes);
    return tooLarge ? null : text;
  } catch {
    // network down, DNS, abort, TLS — caller treats null as "could not check"
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the `latest` dist-tag for a public npm package. */
export async function fetchNpmLatest(pkg: string, opts: FetchOpts = {}): Promise<string | null> {
  const url = `https://registry.npmjs.org/-/package/${encodeURIComponent(pkg)}/dist-tags`;
  const body = await fetchText(url, opts);
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const v = (parsed as Record<string, unknown>)['latest'];
    return looksLikeVersion(v) ? stripV(v) : null;
  } catch {
    return null;
  }
}

/** Fetch the latest release tag for a public GitHub repo (e.g. claude-switch-gui). */
export async function fetchGitHubReleaseLatest(
  owner: string,
  repo: string,
  opts: FetchOpts = {},
): Promise<string | null> {
  // Unauth path is rate-limited to 60/h per IP — same budget Linear/Discord
  // sit on for the same endpoint; the 6h cache (cache.ts) makes a single
  // user a non-issue.
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const body = await fetchText(url, opts, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-switch' },
  });
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const tag = (parsed as Record<string, unknown>)['tag_name'];
    return looksLikeVersion(tag) ? stripV(tag) : null;
  } catch {
    return null;
  }
}

/** Strictly-newer semver compare, ignoring pre-releases as upgrade targets
 *  (matches setup/update-check.ts isNewer; duplicated here to keep
 *  module-import graphs tidy — the older copy stays scoped to the banner). */
export function isNewer(current: string, latest: string): boolean {
  const isPre = (v: string): boolean => v.replace(/^v/, '').includes('-');
  if (isPre(latest)) return false;
  const parse = (v: string): number[] =>
    (v.replace(/^v/, '').split('-')[0] ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  const [ca = 0, cb = 0, cc = 0] = parse(current);
  const [la = 0, lb = 0, lc = 0] = parse(latest);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  if (lc !== cc) return lc > cc;
  // Same base — pre-release current is "less than" a matching stable.
  return isPre(current) && !isPre(latest);
}
