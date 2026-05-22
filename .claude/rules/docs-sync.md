# Docs sync — keep the README honest with the code

The README is a public contract: users on npmjs.com and GitHub decide whether
to trust the tool based on it. When the code drifts from the README, the README
lies. This rule makes "update the docs" part of the change, not a follow-up.

**Core rule:** any code change that touches something the README *cites* must
update that citation in the **same** branch/PR. A change is not done until the
README is true again.

## What counts as a README citation (the citation surface)

The README references the code in several concrete ways. Each is a citation
that can rot:

1. **File-path tags** — `(src/atomic-write.ts)`, `(src/lock.ts)`, etc. If you
   rename, move, split, or delete a referenced file, fix or drop the tag.
2. **Function / symbol names** — `withLock(accountsDirPath)`,
   `accounts.load()`, `syncActiveSnapshotIfStale`, `captureLiveCredentials...`.
   Renaming a referenced symbol must update the prose.
3. **Numeric defaults and thresholds** — `Node.js 20.12+`, fallback engage at
   `≥95%`, auto-revert below `80%`, lock `30s` stale reclaim, file mode `0600`,
   proxy body cap `32 MB`, `>2-3` flush count, cache TTL claims. Change the
   constant in code → change the number in the README.
4. **Command and flag names** — `claude switch`, `claude switch profile use`,
   `claude switch route add`, `claude switch cache-health`, `claude --as`,
   `--json`, `--session`. Renaming/removing a command or flag means the
   Install / Features / FAQ / Troubleshooting examples are now wrong.
5. **Platform / runtime support** — the `macOS · Linux · Windows` line, the
   per-platform credential-store claims, and the CI badge all imply a support
   matrix. If `ci.yml` changes the OS or Node version matrix, reconcile the
   README.
6. **Security controls** — the entire `## 🔐 Security model` section is a set
   of claims about the code. Adding, weakening, or removing a control (atomic
   write, symlink safety, lock, Keychain rollback, silent-billing purge, proxy
   Origin/Host/body-cap defenses) must be reflected here. Under-claiming is a
   missed-credit bug; over-claiming is a trust/security bug — both are drift.
7. **License references** — the license badge, the FAQ "X-licensed" line, the
   footer link, and `NOTICE` must all agree with `LICENSE` and the
   `package.json` `license` field.

## Detecting drift before you commit

When you change a symbol, path, constant, command, or flag, grep the README for
it before you call the change done:

```bash
# Did I just rename/move/delete something the README cites?
grep -nF 'oldSymbolName' README.md SECURITY.md
grep -nF 'src/old-path.ts' README.md

# A changed numeric default? grep the literal value.
grep -nE '0600|32 MB|20\.12|95%|80%|30s' README.md
```

If a grep hits, the README needs the matching edit in this branch.

## Events that require a README edit ("other possible events")

| Event in the code/repo | README section to reconcile |
|---|---|
| New CLI subcommand or flag | Features / Install examples / FAQ; add `--json` note if GUI-consumed (see commits-and-privacy + the JSON-contract rule) |
| Renamed / removed command or flag | every example that used it (Install, Features, Troubleshooting, FAQ) |
| Changed threshold / default / timeout / perms | the cited number (§3 above) |
| Renamed / moved / split / deleted `src/*` file | the `(src/file.ts)` tag and any symbol name |
| Security control added / changed / removed | `## 🔐 Security model` (both "protected ✅" and "not protected ⚠️") |
| Platform or Node-version matrix change in `ci.yml` | `macOS · Linux · Windows` line, requirements callout, CI badge |
| New release tagged | add a `What's new` bullet (only for versions that actually shipped — verify against `CHANGELOG.md`; release-please may skip a number) |
| License change | badge + FAQ line + footer + `NOTICE` + `package.json` |
| A "not protected ⚠️ / on the roadmap" item gets implemented | move it from "not protected" to "protected", drop the roadmap phrasing |
| Anchor target heading renamed | every in-page link (`[text](#anchor)`) and the top nav row |

## npm-rendering compatibility (hard constraint)

The README renders on **both** GitHub and npmjs.com. npm uses plain Markdown —
it does **not** support GitHub-flavored alert blocks:

```md
> [!NOTE] / [!IMPORTANT] / [!TIP] / [!WARNING] / [!CAUTION]
```

These show up as literal `[!IMPORTANT]` text on the npm package page. Use a
portable blockquote instead:

```md
> ❗ **Important** — …
> 💡 **Tip** — …
```

Same caution for anything GitHub-only: collapsible `<details>` works on both,
but emoji-variant-selector anchors (e.g. a heading starting with `⚖️`) produce
fragile slugs that some renderers drop — prefer plain-text anchors for nav
links, or verify the link resolves on the npm-rendered page.

## Link & badge integrity

- Every top-nav link and in-page `[text](#anchor)` must resolve. If you remove
  a section, remove its nav entry in the same edit.
- Badges must be self-consistent in **style** (this README uses shields.io
  `style=for-the-badge` for all badges — do not mix in a native GitHub Actions
  `badge.svg`, which renders at a different size).
- A version-specific claim in prose (not the live npm badge) must match a
  released version in `CHANGELOG.md`.

## Pre-PR doc-sync check

Before opening a PR that changed `src/`, ask explicitly: *did this change any
value, name, path, command, flag, control, or support claim the README cites?*
If yes and the README wasn't touched, the PR is incomplete. The privacy gate
already runs on every commit (see [`commits-and-privacy.md`](./commits-and-privacy.md));
treat doc-sync as the same kind of non-optional pre-PR gate.
