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

## Pre-push validation

A shell-based git hook (`scripts/git-hooks/pre-push`) runs `npm run build`
followed by the full test suite before every `git push`. It catches regressions
locally — before CI has a chance to — and saves a round trip.

**Why it exists**: CI is the authoritative gate, but a red CI pipeline blocks
everyone sharing the branch. The hook gives the author one last chance to catch
obvious breakage on their own machine before the push lands.

**Install once** (per local clone):

```bash
npm run install-hooks
```

This copies `scripts/git-hooks/pre-push` into `.git/hooks/pre-push` and makes
it executable. Safe to re-run if the hook changes upstream.

**Verify installation:**

```bash
ls -la .git/hooks/pre-push
```

**Bypass** (`--no-verify`) is available but strongly discouraged. Per project
policy, no push reaches `main` without explicit maintainer approval — skipping
the hook increases the risk that a broken commit slips through.

## Release readiness check

Before pushing to `main`, run the release readiness script to verify all
gates in one shot:

```bash
npm run verify-release
```

This runs five checks:

| # | Check | Pass condition |
|---|-------|----------------|
| 1 | `npm run build` | TypeScript compiles without errors |
| 2 | `npm test` | 0 failing tests |
| 3 | `npx knip` | No unused files or devDependencies |
| 4 | `npm run lint` | No lint errors (warnings allowed) |
| 5 | Conventional commits | All commits since last tag match `<type>: description` |

Exit 0 = `🟢 GO` (safe to push). Exit 1 = `🔴 NO-GO` with per-check details.

The script also prints an informative bump estimate (minor/patch/major) based
on commit types since the last tag, or the explicit `Release-As:` footer if
present.

## Release cadence policy

Questa sezione codifica le regole operative per decidere quando e come rilasciare
una nuova versione su `main`. Completa le sezioni precedenti su hook (Phase 17.1),
snapshot security (Phase 17.2) e release readiness check (Phase 17.3).

### Soglia "troppi commit non rilasciati"

Se il numero di commit su `main` non ancora coperti da un tag supera **5**, la
release è urgente. Verifica con:

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline | wc -l
```

Un numero ≥ 5 è il segnale che il batch è abbastanza grande da giustificare un
release-coordination commit immediato.

### Ogni Phase chiusa = 1 release-coordination commit

Al termine di ogni milestone (Phase), aggiungere un commit con il footer
`Release-As:` per forzare il bump scelto invece di lasciare che release-please
inferisca da soli i commit:

```
chore(release): coordinate Phase N release

<riepilogo breve dei task inclusi>

Release-As: X.Y.Z
```

Il footer `Release-As: X.Y.Z` è l'unico modo garantito per sovrascrivere il bump
automatico. Usarlo solo per bundle di milestone — non per singoli commit.

### Bump decision matrix

| Tipo commit dominante | Bump automatico | Esempio |
|-----------------------|-----------------|---------|
| `feat:` | minor (x.Y.0) | 3.6.0 → 3.7.0 |
| `fix:` | patch (x.y.Z) | 3.6.0 → 3.6.1 |
| `feat!:` / `fix!:` | major (X.0.0) | 3.6.0 → 4.0.0 |
| `refactor:`, `docs:`, `test:`, `chore:` | nessuno (bloccato) | — |

Override via `Release-As:` footer — raro, riservato a bundle milestone. Per la
corrispondenza `<type>` → bump vedere la sezione **Conventional commits** sopra.

### Pre-push checklist obbligatoria

Prima di ogni push a `main`, verificare nell'ordine:

1. `npm run verify-release` (Phase 17.3) restituisce `🟢 GO`
2. Working tree pulito (`git status` → nothing to commit)
3. Nessun task `cc:WIP` non-spike rimasto aperto in Plans.md
4. `npm run install-hooks` eseguito almeno una volta nel clone (Phase 17.1)

```bash
# Verifica readiness in un colpo solo
npm run verify-release

# Output GO → pronti per push (dopo OK esplicito del maintainer)
git push origin main

# release-please apre la PR entro 1-2 minuti — visualizzala con:
gh pr list --label autorelease:pending
```

### Push solo dopo OK esplicito del maintainer

Per policy (vedi `CLAUDE.md` sezione "Release"), **nessun push a `main` senza
approvazione esplicita**. Anche con `🟢 GO` da `verify-release`, il push va
atteso fino alla conferma. La violazione bypassa release-please e può pubblicare
su npm versioni non esaminate.

### Cosa succede dopo il push

1. release-please apre automaticamente una PR `chore(main): release X.Y.Z`
   con CHANGELOG completo ricalcolato dai commit.
2. La PR rimane aperta fino al merge manuale del maintainer.
3. Al merge: tag `vX.Y.Z` automatico → `npm publish` (se il workflow è
   configurato).

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

## Architecture

For an overview of the three layers (dispatcher / commands / domain),
the proxy lifecycle, the lock-discipline invariants, and the on-read
migration pattern, see [`docs/internal/architecture.md`](docs/internal/architecture.md).
For error-handling patterns + the audit predicate that flags new
silent catches, see [`docs/internal/error-handling.md`](docs/internal/error-handling.md).

## Conventional commits

Every commit reachable from a PR targeting `main` is validated by CI
(`commitlint.yml`). The message must match:

```
<type>[optional scope][optional !]: <description>
```

**Allowed types**

| Type | When to use |
|------|-------------|
| `feat` | New user-facing feature |
| `fix` | Bug fix |
| `chore` | Tooling, dependencies, config (no prod code change) |
| `docs` | Documentation only |
| `refactor` | Code restructure without behaviour change |
| `test` | Test additions or corrections |
| `perf` | Performance improvement |
| `build` | Build system or bundler changes |
| `ci` | CI workflow changes |
| `revert` | Reverts a previous commit |

**Breaking changes**: append `!` before the colon (`feat!:` / `fix!:`).
This triggers a major semver bump via release-please.

**Yes (valid)**

```
feat: add oauth refresh
fix(keychain): handle missing entry gracefully
feat(profiles): CLAUDE_SWITCH_DEBUG_PROFILES diagnostic flag
chore(release): coordinate Phase 17 release
feat!: drop Node 18 support
ci: auto-merge release-please PRs
```

**No (invalid)**

```
add oauth refresh          # missing type prefix
Fixed the bug              # missing type prefix
WIP                        # missing type prefix
feat - add something       # dash instead of colon
```

**Scope** is optional but recommended for larger code areas
(`keychain`, `profiles`, `proxy`, `ui`, `cli`, `ci`, `release`, etc.).

release-please reads these prefixes to decide the semver bump: `feat` →
minor, `fix` → patch, `!` → major, everything else → no release bump.

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`, `ci:`). release-please uses these to derive semver bumps.
- TypeScript strict mode, no `any` outside narrow boundaries.
- Comments answer **why**, not **what**. The code answers what.
- Tests use `node:test` + tmpdir-based fixtures, no global state.

## License

MIT.
