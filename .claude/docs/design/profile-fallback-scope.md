# Should the fallback marker live per-profile?

**Status**: decided
**Date**: 2026-05-04
**Plans.md task**: 4.7
**See also**: `fallback-state-machine.md`

## Decision

**Keep fallback config global** (per accountsDir, NOT per profile).

Concretely: `<accountsDir>/.fallback-enabled` and `<accountsDir>/.auto-fallback.json` continue to live in `~/.claude/accounts/`, not duplicated under each `~/.claude/profiles/<name>/`.

## Reasoning

### Why we considered per-profile

A user could plausibly want:

- Profile **work** (billing-sensitive client account): never use API fallback, always OAuth or fail loud
- Profile **personal** (own subscription): auto-engage at 95%, auto-revert at 80%

A single global toggle forces both profiles to share one policy.

### Why global wins

1. **API key is per-account, not per-profile.** `getApiKey(email)` reads `<accountsDir>/<email>.json._apiKey`. The same email signed into two different profiles still has one API key. So even with a per-profile fallback toggle, the actual *credential* used during fallback is shared. Per-profile toggle without per-profile API key is policy without enforcement.

2. **Profiles already isolate the OAuth identity.** The reason a user picks Profile work is to pin THIS terminal to a specific account. The API-key fallback decision can be expressed via the regular per-account API key controls: don't save an API key for the work account → fallback engaging is impossible (the spawn-time helper `fallbackEnvFor` returns null when no key is saved). This is the correct enforcement boundary, and it's already in place.

3. **Auto-fallback policy is about the user's billing posture, not about what they're typing into.** "I want auto-revert at 80%" is a one-time setting; "right now I'm on the work profile" is a per-terminal decision. Mixing the two layers makes config harder to reason about (4 booleans × N profiles × 2 thresholds).

4. **Migration risk.** Splitting into per-profile config would require migrating existing users without surprising them. The current behaviour after upgrade is "settings carry over" — if 4.7 had decided per-profile, we'd need either a default-from-global migration or an opt-in per-profile override. Both are non-trivial UX decisions for a marginal benefit.

### When this decision should be revisited

If a user reports a concrete scenario where global config breaks them — most likely shape: "I have a paid API key on personal but I do NOT want it ever used while I'm on the work profile, even though I do save the key on personal." Today they can avoid this by not saving the key on the personal account *with the same email* used in work. If profiles ever diverge from the email-keyed account model, revisit.

## Implementation impact

**None.** Current code is correct under this decision. No tests to add, no code to change.

What this DOES enable: when 3b.1 (Profiles submenu) ships, a user managing the work profile in the menu sees "no API key saved" status — a clear visual that fallback is impossible for that profile, without needing a per-profile fallback toggle in the UI.

## Closure

4.7 closed by decision. Documents the reasoning so a future contributor doesn't re-debate it without new evidence.
