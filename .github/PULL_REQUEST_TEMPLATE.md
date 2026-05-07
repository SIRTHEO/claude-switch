<!--
Thanks for the PR! Please skim the checklist below and tweak/delete
sections as appropriate. Tiny PRs (one-line fixes, doc tweaks) can
collapse this to a one-line title — no ceremony required.
-->

## What this changes

<!-- One sentence per change, "why" first when it isn't obvious from
"what". Bullet points if multiple unrelated tweaks. -->

## Why this is the right change

<!-- Trade-offs you considered, alternatives you rejected, or
benchmarks if relevant. Skip if obvious from the code. -->

## How it was tested

- [ ] `npm test` passes locally
- [ ] `npm run lint` clean
- [ ] `npx tsc --noEmit` clean
- [ ] Manual smoke (when relevant — describe what you did)

## Risk / blast radius

<!-- For touches to: src/profiles.ts · src/api-proxy.ts · src/keychain.ts ·
     anything in src/commands/ that mutates credentials.
     Otherwise delete this section. -->

- Could this break the live OAuth ↔ API-key fallback path? How was that verified?
- Could this affect `claude switch` muscle-memory commands users have built into scripts?
- Does this require a follow-up migration on existing users' `~/.claude/`?
