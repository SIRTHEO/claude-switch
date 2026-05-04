# Contributing to claude-switch

## Releases

This repo uses [release-please](https://github.com/googleapis/release-please) to automate version bumps, changelog entries, git tags, and npm publishes. **You don't pick the version number.** It is derived from your commit messages.

### Workflow

1. Land commits on `main` using [Conventional Commits](https://www.conventionalcommits.org) (see types below).
2. release-please opens a "release PR" that bumps `package.json`, updates `CHANGELOG.md`, and previews the next version.
3. When you merge that PR:
   - The bot creates a git tag (`v2.x.y`) and a GitHub Release.
   - A separate workflow runs `npm publish --provenance --access public` using `NPM_TOKEN`.

You never run `npm version`, `git tag`, or `npm publish` by hand.

### Commit types

| Prefix      | Triggers release | Section in CHANGELOG       |
|-------------|------------------|----------------------------|
| `feat:`     | minor            | Features                   |
| `fix:`      | patch            | Bug Fixes                  |
| `perf:`     | patch            | Performance Improvements   |
| `security:` | patch            | Security                   |
| `ux:`       | patch            | User Experience            |
| `ui:`       | patch            | User Experience            |
| `refactor:` | no release       | Refactors                  |
| `docs:`     | no release       | Documentation              |
| `test:`     | no release       | (hidden)                   |
| `build:`    | no release       | (hidden)                   |
| `ci:`       | no release       | (hidden)                   |
| `chore:`    | no release       | (hidden)                   |

### Breaking changes

Add `!` after the type, or include a `BREAKING CHANGE:` footer. release-please will bump the **major** version:

```
feat!: drop support for Node 18

BREAKING CHANGE: minimum supported Node.js is now 20.12 (Node 18 EOL).
```

### Examples

```
feat: smart-switch — auto-disable fallback when subscription has room
fix: race condition between save() and load() in addAccount
security: validate alias names against shell-safe allowlist
docs: rewrite README for v2.4.0
ci: drop Node 18 from matrix
```

### One-time setup (maintainers only)

1. Add the `NPM_TOKEN` secret to the GitHub repo settings (Settings → Secrets and variables → Actions). Use a **Granular Access Token** scoped to this package only.
2. In Settings → Actions → General → Workflow permissions, allow GitHub Actions to "create and approve pull requests" so release-please can open the release PR.

That's it. From here on every push to `main` is evaluated by release-please.
