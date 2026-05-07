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

## Marketing GIFs

Three GIFs live under `docs/images/` and tell the README story:

| File | Storyboard | What it shows |
|---|---|---|
| `dashboard.gif` | `scripts/demo.tape` | the menu — Accounts, Account actions, General |
| `switch.gif` | `scripts/demo-switch.tape` | open menu → Up → Enter → active account flips |
| `profiles.gif` | `scripts/demo-profiles.tape` | open menu → `p` → Profiles screen |

All three are rendered from a synthetic `$HOME` so no real account
credentials ever leak into the recorded frames. To regenerate every
GIF:

```bash
brew install vhs    # one-time
npm run gif         # renders all three tapes
```

To re-render a single tape (faster iteration), pass it through:

```bash
bash scripts/render-demo.sh scripts/demo-switch.tape
```

Files involved:

- `scripts/demo-fixture.mjs` — builds the synthetic `~/.claude` tree
  (accounts `sirtheo.work@example.com` + `sirtheo.personal@example.com`,
  one demo profile, fake usage cache, aliases, `.user-prefs.json` with
  `defaultAutoLaunchOnSwitch=false` so the menu-driven switch demo
  doesn't accidentally spawn the real `claude` binary).
- `scripts/demo*.tape` — the three VHS storyboards.
- `scripts/render-demo.sh` — wraps fixture + build + vhs and tears the
  synthetic `$HOME` down on exit.

A few non-obvious gotchas if you edit a tape:

- The dashboard's account cursor starts on the **active** row. To land
  on the other account use `Up` (or `Down`, depending on which row is
  active in the fixture) — `Enter` on the active row only re-opens it.
- Inside the dashboard, **don't** `Type "claude switch"` again — the
  `c` is bound to `Re-authenticate` and will trigger an OAuth flow.
  Let the TUI re-render itself after a `'switched'` action.
- End each tape with a long `Sleep` on the informative TUI frame, not
  after a `q`. The GIF loops, and a bare shell prompt as the resting
  frame looks broken.

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`, `ci:`). release-please uses these to derive semver bumps.
- TypeScript strict mode, no `any` outside narrow boundaries.
- Comments answer **why**, not **what**. The code answers what.
- Tests use `node:test` + tmpdir-based fixtures, no global state.

## License

MIT.
