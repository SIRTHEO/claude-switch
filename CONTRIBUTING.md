# Contributing to claude-switch

Thanks for taking the time. Quick orientation:

## Local setup

```bash
git clone https://github.com/SIRTHEO/claude-switch.git
cd claude-switch
npm install
npm test
```

`npm test` runs the full matrix in ~2s. CI exercises the same suite on
Linux + macOS + Windows × Node 20/22/24.

## Quality gates

Before opening a PR, the local equivalents of CI must be green:

```bash
npx tsc --noEmit         # typecheck (strict)
npm run lint             # biome
npm test                 # 540+ tests, no failures
npm audit --audit-level=high --omit=dev
```

CI also enforces a 56% line-coverage floor (current ~58%). New code
without tests will likely drag the number under the floor and fail.

## Pre-release smoke (manual, macOS only)

For releases that touch `src/profiles.ts`, `src/keychain.ts`, or any of
the OAuth-handling code, run a real-claude integration once before
tagging — no automated test covers the live spawn path:

```bash
# Pick any account you have saved already (replace YOUR_EMAIL).
claude switch profile import YOUR_EMAIL
PROFILE_DIR=$(claude switch profile status $(echo YOUR_EMAIL | cut -d@ -f1) | grep '^Path:' | awk '{print $2}')
CLAUDE_CONFIG_DIR="$PROFILE_DIR" claude --print "say OK and exit"
# Should print "OK" or similar — NOT "Not logged in · Please run /login".
```

If it asks for login, the OAuth refresh / Keychain layout has drifted
from production claude. Investigate before tagging.

## Marketing GIF

The dashboard GIF in `docs/images/dashboard.gif` is rendered from a
synthetic `$HOME` so no real account credentials ever leak into the
recorded frames. To regenerate:

```bash
brew install vhs   # one-time
npm run gif
```

`scripts/demo-fixture.mjs` builds the synthetic accounts (`alex.designer@acme.com`,
`alex.personal@example.com`); `scripts/demo.tape` is the VHS storyboard;
`scripts/render-demo.sh` glues them together and tears the fixture down
on exit. Edit any of the three to change the demo.

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`, `ci:`). release-please uses these to derive semver bumps.
- TypeScript strict mode, no `any` outside narrow boundaries.
- Comments answer **why**, not **what**. The code answers what.
- Tests use `node:test` + tmpdir-based fixtures, no global state.

## License

MIT.
