# API key fallback — state machine

**Status**: living document
**Last updated**: 2026-05-04
**Source modules**: `src/fallback.ts`, `src/auto-fallback.ts`, `src/apikey.ts`, `src/fallback-env.ts`

## Why fallback exists

Claude Code authenticates via OAuth against the user's Max/Pro subscription by default. When the subscription is rate-limited, every claude invocation returns 429 until the window resets. claude-switch lets the user opt into a **fallback** path: when fallback is ON, the spawned `claude` process gets `ANTHROPIC_API_KEY` injected into its environment, and Anthropic bills usage to the saved API key instead of the subscription.

Two pieces of state govern this:

1. **Fallback marker** (`<accountsDir>/.fallback-enabled`) — a 0-byte file whose presence means fallback is currently ON. Read by `isFallbackEnabled`, written by `setFallbackEnabled`.
2. **Auto-fallback config** (`<accountsDir>/.auto-fallback.json`) — opt-in policy for automatic transitions.

The marker drives the *current* behaviour. The config drives the *transition rules*.

## State + transitions

```
            ┌─────────────────────┐
            │  fallback OFF       │  ← default state
            │  marker absent      │
            │  spawn claude with  │
            │  no API key in env  │
            └─────────────────────┘
                  ▲           │
                  │           │ ① user runs `claude switch fallback on`
                  │           │   (or auto-engage triggers — Phase 4)
   ② cached usage │           ▼
      drops below ┌─────────────────────┐
      revertThres │  fallback ON        │
      AND auto-   │  marker present     │
      revert is   │  spawn claude with  │
      enabled     │  ANTHROPIC_API_KEY  │
                  └─────────────────────┘
                  │
                  ① user runs `claude switch fallback off`
```

## Transition table

| From | To | Trigger | Implemented by |
|------|----|---------|----------------|
| OFF | ON | User: `claude switch fallback on` | `setFallbackEnabled(true)` directly |
| ON | OFF | User: `claude switch fallback off` | `setFallbackEnabled(false)` directly |
| ON | OFF | **Auto-revert**: cached `five_hour.utilization` AND `seven_day.utilization` both `< revertThreshold` | `maybeAutoDisableFallback` |
| OFF | ON | **Auto-engage** (currently parked WIP): cached usage crosses `engageThreshold` upward AND active account has saved API key | `maybeAutoEngageFallback` (function defined in `src/auto-fallback.ts`, never called from `bin/cli.ts`) |

## Auto-fallback config schema

```ts
interface AutoFallbackConfig {
  enabled: boolean;       // master switch for auto-revert
  threshold: number;      // 1-100, default 80 — auto-revert fires below this
  engageEnabled: boolean; // master switch for auto-engage (parked)
  engageThreshold: number;// 1-100, default 95 — auto-engage fires at/above this
}
```

**Invariant**: `engageThreshold > threshold` (strictly). Enforced by `setAutoFallbackConfig` — throws on violation. Prevents oscillation where a single utilization reading would simultaneously trigger both auto-engage and auto-revert.

## Auto-revert decision logic (`maybeAutoDisableFallback`)

Pre-conditions, all required:

1. `getAutoFallbackConfig(accountsDir).enabled === true` (master switch ON)
2. `isFallbackEnabled(accountsDir) === true` (currently fallback-ing)
3. `readUsageCacheFor(accountsDir, currentEmail)` returns a payload (per-account cache hit)
4. **No active rate-limit back-off** in the cache (`rateLimitedUntil` not in the future)
5. Cache is fresh enough that we trust the numbers (TTL governed by `usage.ts`)
6. Both `payload.five_hour.utilization` AND `payload.seven_day.utilization` are present AND strictly `< threshold`

If all true → `setFallbackEnabled(false)`, return `{ disabled: true, fivePct, sevenPct }`.

Why "both, strictly less, with both present":

- 5h alone is not enough — quota windows differ; can drop below 5h cap while 7d still saturated.
- Strict `<` (not `≤`) so threshold value `80` does not flap exactly at 80%.
- Both must be present — partial cache (5h known, 7d missing) defers to next refresh rather than guessing.

## Auto-engage (parked, NOT shipped)

`maybeAutoEngageFallback` is defined in `src/auto-fallback.ts` but **never called** from `bin/cli.ts`. Its WIP wiring lives in `.claude/docs/wip-patches/auto-engage-2026-05-04.patch`.

Intended logic (when un-parked):

1. `engageEnabled === true` AND `isFallbackEnabled() === false`
2. `getApiKey(currentEmail)` returns a non-empty key (no API key → can't engage)
3. Cache fresh + per-account match
4. `payload.five_hour.utilization` OR `payload.seven_day.utilization` `≥ engageThreshold`

Then → `setFallbackEnabled(true)`. Together with auto-revert this forms a **hysteresis loop**: engage at 95%, revert at 80%, no flapping at the boundaries.

Pre-requisites for un-parking (Plans.md tasks):

- 0.8 ✅ usage.ts coverage ≥ 80% (rate-limit + freshness logic verified)
- 4.3 fill auto-engage tests (5h + 7d crossings, no API key, already-engaged no-op, persistence)
- 4.4 hysteresis test (95% → 80% → no flapping)
- 4.7 decide per-profile vs global config

## Interaction with profiles (per-terminal isolation)

**Open question**: should `.fallback-enabled` and `.auto-fallback.json` live in the **per-profile** config dir (each profile has its own toggle and policy), or stay **global** to the user's `~/.claude/accounts/`?

Argument for per-profile:

- Profile A may be a billing-sensitive account where the user always wants fallback OFF; Profile B a personal account where auto-engage is welcome. A global toggle forces one choice.

Argument for global:

- Simpler mental model. Avoids per-profile config drift. The API key is per-account, not per-profile, so per-profile fallback policy depends on the profile's currently-active account anyway.

**Decision deferred to Phase 4 task 4.7.**

## Spawn-time injection (`fallback-env.ts`)

Pure helper: `fallbackEnvFor(email, accountsDir)` returns either an env object containing `ANTHROPIC_API_KEY` (when fallback is ON and a key is saved for the account) or `null`. The caller — `runTemporarySwitch` and the main spawn paths in `bin/cli.ts` — passes this to `buildSpawnArgs` which merges it into `process.env` for the spawned `claude`.

This keeps the policy decision (`fallbackEnvFor`) separate from the side-effect (process spawn), which is why `fallback-env.ts` has 100% test coverage even though the spawn paths it feeds do not.

## Files at a glance

| File | Role |
|---|---|
| `src/fallback.ts` | Marker file r/w. Tiny, 100% covered. |
| `src/auto-fallback.ts` | Config r/w + auto-revert decision (+ parked auto-engage). 97.94% covered. |
| `src/fallback-env.ts` | Spawn-time env helper. 100% covered. |
| `src/apikey.ts` | Per-account API key storage. 100% covered. |
| `src/usage.ts` | Cached subscription usage; the input to auto-* decisions. 80.45% covered. |
| `bin/cli.ts` (`fallback-*` actions) | User-facing CLI surface (`fallback on/off/status/auto`). |

## Surprises and gotchas

1. **Per-account cache key**: `readUsageCacheFor` requires the cache's `account` field to match. A pre-account-aware cache (no `account` field) is treated as "unknown account → don't trust" — refuses to feed auto-revert. This is correct (avoids cross-account quota leakage) but means the FIRST cached usage after a `claude switch` won't trigger auto-revert until the next refresh.
2. **429 backoff stops auto-revert**: when the cache has `rateLimitedUntil` in the future, auto-revert refuses to fire. Reason: we can't trust stale-during-backoff numbers. This means a user can sit in fallback for the duration of a 429 window even if their usage technically dropped — the next successful refresh corrects it.
3. **TTL freshness vs rate-limit barrier**: `fetchUsageCached`'s `force=true` skips the TTL check but NOT the rate-limit barrier. Meaning even `force` returns the rate-limited cache as-is.
4. **`bin/cli.ts:1073` env merge**: `extraEnv = fallbackEnvFor(...)` is called BEFORE `runTemporarySwitch`. If the user toggles fallback during a `--as` session, the new state takes effect on the NEXT spawn, not the current one (the env is captured at spawn time).
