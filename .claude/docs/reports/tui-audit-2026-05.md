# TUI audit — 2026-05

**Branch**: `experiment/per-terminal-isolation` @ HEAD
**LOC inventory**: `src/ui/main-menu.ts:658`, plus 6 sub-screens (1361 LOC total)
**Plans.md task**: 5.1

## Method

Static code review of `src/ui/main-menu.ts` + `src/ui/select-account.ts` + `src/ui/setup-wizard.ts` + helpers. Focus on architecture, friction, and gaps that should be addressed before more features are layered on (Phase 3b "Profiles submenu", 4.5 "Auto-fallback settings menu").

## Findings

### F1 — `main-menu.ts` is too big and mixes layers (658 LOC)

The file mixes:
- menu state machines (`pickAction`, `pickAdvancedAction`, `pickManageAction`)
- per-action handlers (the giant `switch (action)` from line 355 onwards)
- side-effect helpers (`buildStatusLines`, `buildAccountInfo`)
- alt-buffer lifecycle + signal handling

**Recommendation (Phase 5.2)**: split into:
- `src/ui/menu/screens/{main,advanced,manage}.ts` — the `pickX` selectors
- `src/ui/menu/actions/{switch,reauth,fallback,…}.ts` — one file per action handler
- `src/ui/menu/status.ts` — `buildStatusLines`, `buildAccountInfo`
- `src/ui/menu/lifecycle.ts` — alt-buffer + signal handling
- `src/ui/main-menu.ts` becomes a thin orchestrator (~150 LOC)

### F2 — Status header refreshes on every menu iteration

Lines 326-338 fetch usage on entry; line 346 calls `buildStatusLines` on every iteration of the menu loop. `buildStatusLines` reads `~/.claude.json`, the Keychain, the API key file, the alias file, the auto-fallback config — that's ~6 disk reads per redraw.

In practice the menu loop redraws on every action, so the user typing 4 actions = 24 redundant disk reads. None of them are slow individually, but the pattern is wasteful and noisy in `dtruss` traces.

**Recommendation**: cache the status snapshot at top of `runMainMenu`; invalidate after any action that mutates state (`switch`, `apikey`, `fallback`, etc.). Pure UX wins: no perf catastrophe today, but lays the groundwork for richer status (e.g. profile name in 3b.3) without paying redraw tax.

### F3 — Auto-buffer flow has correct lifecycle but it's brittle

Lines 296-316 set up:
- `restoreBuffer` (idempotent via `cleaned` flag)
- `process.once('exit', restoreBuffer)`
- `process.on('SIGINT'/'SIGTERM', restoreBuffer + exit code)`

This is correct, but `process.on` (not `once`) for the signals means handlers stay registered until the menu exits cleanly via `try { … }` finally (which the file has). If the menu's catch-all `try` swallows an unexpected error and exits via thrown-from-handler, signal handlers leak.

**Recommendation**: convert signal handlers to `once`, or extract a dedicated `withAltBuffer(handler)` HOF that owns full lifecycle including handler removal in `finally`.

### F4 — "Switch" action's auto-launch is correct but undocumented

Lines 357-376: when the user picks "Switch account" and the active account actually changed, the menu spawns `claude` and exits. Rationale (in the inline comment) is solid: "the user came here to use that account; making them exit and type `claude` again is friction."

This behaviour is **invisible from outside the file**. README + help don't mention it. A user reading help would not know that "Switch account" via the menu boots them straight into a claude session, while CLI `claude switch <email>` does NOT. Asymmetry by design but undocumented.

**Recommendation**: add a one-line note in README ("Switching from the menu launches claude immediately; switching from the CLI just updates state.") OR change CLI `claude switch <email>` to launch claude too (and use `--no-launch` for the current "just-state-update" behaviour). The asymmetry is the friction, not the auto-launch.

### F5 — Inconsistent error rendering

Five distinct error patterns in `main-menu.ts`:

```ts
p.note('Could not find claude binary — run setup first.', 'Setup needed');
p.note((e as Error).message, 'Re-authentication failed');
p.note('No active account.', 'Cannot continue');
p.note(removed ? 'API key removed.' : 'No key was saved.', 'Done');
process.stderr.write(`Error: could not launch claude: ${result.error.message}\n`);
```

Three different "title" conventions ("Setup needed" / "Re-authentication failed" / "Cannot continue"), one mixes success and failure into one bucket (`'Done'`), and one uses raw stderr. Inconsistent for a user, harder for a future contributor to know which to use.

**Recommendation (5.4)**: introduce one helper `notifyError(title, message, suggestion?)` and one `notifyOk(message)` — the rest funnel through them.

### F6 — `pickAccount` has dead "exclude" code path

Line 215: `pickAccount(prompt, accountsDirPath, exclude?)`. The `exclude` parameter is never passed by any caller in the current code. Either remove it or add a TODO comment for whoever's planning to use it.

### F7 — Setup wizard duplicates findClaude logic

`setup-wizard.ts` (195 LOC) re-derives the claude binary path with its own logic instead of calling `findClaudeBinary`. Drift risk: if `find-claude.ts` changes (e.g., adds the future Profile-aware lookup), the wizard's path picker won't follow.

**Recommendation**: setup wizard should DELEGATE to `findClaudeBinary` for the suggestion, then let the user override.

### F8 — "Manage account" submenu (line 240+) does too many small things

Operations inside `pickManageAction`:
- show account info
- remove API key (with confirm)
- set alias
- list aliases
- remove alias

All wrapped behind two confirms and a sub-pick. The depth is "main → manage → pick account → pick action → pick alias → confirm" — five levels deep. Cognitive load for what should be 2-3 clicks.

**Recommendation**: flatten alias management into the main flow ("Aliases…" as a top-level entry), keep "Manage account" focused on per-account actions only. Defer to 5.2 when splitting the file.

## What works well (don't break in 5.2 refactor)

- The intro/exit through alt-buffer keeps the user's scrollback clean. Many TUIs don't bother — this one does.
- The "actions surface conditionally" pattern (re-auth only shows when token broken AND no API key fallback masks it) is sharp UX. Keep it.
- The auto-fallback hint string includes the threshold (`armed: fallback OFF when 5h+7d < ${autoCfg.threshold}%`). Good practice — surface the active threshold next to the toggle so the user knows what it means.
- The single-action auto-spawn (`switch` → boot claude) is the right call for daily-driver flow.
- @clack/prompts is a fine choice — narrow API surface, predictable, no over-engineered TUI framework.

## Action items for 5.x phases

| Priority | Task | Maps to |
|---|---|---|
| High | Split `main-menu.ts` into per-screen + per-action modules | 5.2 |
| High | Funnel all errors through `notifyError`/`notifyOk` | 5.4 |
| Medium | Cache status snapshot, invalidate on mutation | 5.3 (loading states) tangent |
| Medium | Profiles submenu (entry + sub-screen) | 3b.1 |
| Medium | Theme audit for `NO_COLOR=1` + ssh tty | 5.5 |
| Low | Document the menu-vs-CLI asymmetry on Switch | 6.2 (README) |
| Low | Remove `exclude` dead parameter from `pickAccount` | hygiene |
| Low | Setup wizard ↔ findClaudeBinary consolidation | 5.7 |

## Closure

5.1 closed. The audit's findings inform Phase 5 prioritisation. Recommend starting with 5.4 (`notifyError`) before 5.2 (split) — the helper makes the split cleaner because each screen module wraps its own errors uniformly from the outset.
