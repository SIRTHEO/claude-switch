// src/contract-versions.ts
// Versions / update-availability surface of the CLI↔GUI boundary contract,
// split out of contract.ts so that file stays under the size budget.
//
// SAME INVARIANT as contract.ts: this module is IMPORT-FREE and every type is
// self-contained, because the GUI contract generator
// (scripts/gen-gui-contract.mjs) concatenates this file's type body verbatim
// after contract.ts's. Do not add an `import` here — inline any shared shape.

/** How the binary was installed on this machine. Drives both the latest-version
 *  lookup channel and the eventual update command. */
export type VersionSource = 'npm' | 'brew' | 'manual' | 'unknown';

/** One row in the versions report — same shape for all three targets so the
 *  GUI table renders uniformly. */
export interface VersionTarget {
  /** Installed version (no leading `v`), or null when not installed / not
   *  detected. The `gui` target is always null here — the GUI overrides it
   *  with its own `package.json` version in the hook layer (the CLI has no
   *  reliable way to know which GUI build the user is running). */
  current: string | null;
  /** Latest known version from the source registry (no leading `v`), or null
   *  when the registry was unreachable / not applicable. */
  latest: string | null;
  /** Where the binary lives — drives the upgrade channel. `unknown` means
   *  the install method couldn't be sniffed; `manual` means it was sniffed
   *  but we don't automate updates for that channel in v1. */
  source: VersionSource;
  /** True when `current` and `latest` are both set and `latest` is strictly
   *  semver-greater than `current`. Pre-releases never count as upgrades. */
  upgradable: boolean;
  /** ISO timestamp of the last successful registry lookup feeding `latest`.
   *  Lets the GUI render "checked 12 min ago". */
  lastCheckedAt: string;
  /** Human-readable URL to consult when `source === 'manual'` (or when
   *  automated upgrade is otherwise unavailable). Omitted otherwise. */
  manualUrl?: string;
}

/** Shape of `claude switch versions --json`. */
export interface VersionsReport {
  claude: VersionTarget;
  switch: VersionTarget;
  gui: VersionTarget;
}

/** The three things `claude switch update <target>` can act on. */
export type UpdateTarget = 'claude' | 'switch' | 'gui';

/** Shape of `claude switch update <target> --json` — one line the GUI consumes.
 *  A discriminated union over the five emit paths so a field rename in the
 *  command handler breaks the compiler instead of silently drifting from the
 *  GUI parser. `from`/`to` are versions (no leading `v`), null when unknown. */
export type UpdateResult =
  | { ok: true; target: UpdateTarget; from: string | null; to: string | null }
  | { ok: true; target: UpdateTarget; check: true; command: string; from: string | null; to: string | null }
  | { ok: true; target: UpdateTarget; manualUrl: string; from: string | null; to: string | null }
  | { ok: false; target: UpdateTarget; error: string; exitCode: number | null }
  | { ok: false; target: UpdateTarget; error: string; source: VersionSource; manualUrl: string; exitCode: number };
