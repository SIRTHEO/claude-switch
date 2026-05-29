// src/setup/semver.ts
//
// Tiny semver helpers shared by the update-banner code path
// (setup/update-check.ts) and the multi-target versions report
// (setup/versions/registry.ts). Both used to keep their own copy of
// `isNewer` — the duplication was flagged in review and
// consolidated here so a fix in one place propagates to all callers.
//
// The GUI's hook layer keeps a parallel copy by necessity (cross-repo,
// no shared package); it imports nothing from this file. When the GUI's
// `useVersions` overlay grows non-trivial semver logic, lift the rule
// into a separate dist artifact — not before.

/** True when `v` looks like a pre-release version (`x.y.z-rc.1`,
 *  `1.0.0-beta`, etc.). */
function isPreRelease(v: string): boolean {
  return v.replace(/^v/, '').includes('-');
}

/** Split a semver-ish string into `[major, minor, patch]`. Non-numeric
 *  segments default to 0, so `2.3` reads as `2.3.0`. */
function parseTriplet(v: string): number[] {
  const base = v.replace(/^v/, '').split('-')[0] ?? '';
  return base.split('.').map((n) => parseInt(n, 10) || 0);
}

/**
 * Returns true if `latest` is strictly newer than `current`.
 *
 * We never propose pre-release versions (`x.y.z-rc.1`, `x.y.z-beta`) as
 * updates — users running stable should not be auto-bumped to a
 * pre-release. A pre-release `current` IS less than its matching stable
 * (1.0.0-rc.1 < 1.0.0), so rc users still get notified when stable lands.
 */
export function isNewer(current: string, latest: string): boolean {
  if (isPreRelease(latest)) return false;
  const [ca = 0, cb = 0, cc = 0] = parseTriplet(current);
  const [la = 0, lb = 0, lc = 0] = parseTriplet(latest);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  if (lc !== cc) return lc > cc;
  return isPreRelease(current) && !isPreRelease(latest);
}
