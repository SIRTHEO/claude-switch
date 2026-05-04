---
_harness_template: "CLAUDE.md.template"
_harness_version: "4.3.3"
---

# CLAUDE.md - Claude Code Instructions

> **Project**: claude-switch
> **Created**: 2026-05-04
> **Setup locale**: it

---

## Read This First

Read `AGENTS.md` before starting work.

- Development flow overview
- Role boundaries
- Prohibited actions

This file contains only Claude Code-specific instructions.

---

## 1. Claude Code Scope

### Work You Own

- Implement changes that span 4+ files or more than 100 lines
- Commit and push scoped changes
- Confirm CI is green, with up to 3 automatic fix attempts

### Work You Must Not Do

- Do not deploy directly to production. PM owns that decision.
- Do not work outside the requested scope.
- Do not change security settings unless explicitly requested.

---

## 2. Project Context

`claude-switch` is a Node.js/TypeScript CLI that wraps the official `claude` binary to support multiple accounts (OAuth + API key fallback). Active research branch: per-terminal isolation via `CLAUDE_CONFIG_DIR` / `HOME` override (see `EXPERIMENT.md`).

- Build: `npm run build` (tsc → `dist/`)
- Test: `npm test` (node --test on `dist/test/*.test.js`)
- Release: managed by release-please (do **not** use `/harness-release`)
- Plans: `Plans.md` is the SSOT for task tracking. `EXPERIMENT.md` is reference for the per-terminal isolation hypotheses.

---

## 3. Commit Message Convention

Conventional Commits (release-please consumes them):

```text
feat: add a new feature
fix: fix a bug
docs: update documentation
refactor: refactor code
test: add or update tests
chore: maintenance work
```

Scope optional, e.g. `feat(profiles): isolate per-terminal HOME`.

---

## 4. CI Failure Handling

CI not yet configured (no `.github/workflows/`). When added: detect → read log → fix → commit → rerun. After 3 failed attempts, escalate.

---

## 5. Session Routine

### At Session Start

```bash
git status -sb
cat Plans.md
```

### At Completion

```bash
npm test
git add <specific files>
git commit -m "<conventional message>"
```

---

## 6. Available Commands

| Command | Purpose |
|---------|---------|
| `/harness-plan` | Manage `Plans.md` |
| `/harness-work` | Execute tasks |
| `/harness-sync` | Detect drift between Plans.md and code |
| `/harness-review` | Review changes |

---

## 7. Troubleshooting

| Symptom | Action |
|---------|--------|
| Task not found | Check `Plans.md` |
| CI keeps failing | Try 3 fixes, then escalate |
| Scope unclear | Ask user |
