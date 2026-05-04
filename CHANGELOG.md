# Changelog

## [2.7.0](https://github.com/SIRTHEO/claude-switch/compare/v2.6.1...v2.7.0) (2026-05-04)


### Features

* **fallback:** distinguish auto-engaged from manual fallback in statusline (4.6) ([f064a21](https://github.com/SIRTHEO/claude-switch/commit/f064a215b847d15c3ebf845908518994a2310b70))
* **fallback:** wire auto-engage to flip ON before hitting cap ([d0adc4c](https://github.com/SIRTHEO/claude-switch/commit/d0adc4cf292e0b06b5044cf76533d24866aa6800))
* **fallback:** wire auto-engage to flip ON before hitting cap ([#5](https://github.com/SIRTHEO/claude-switch/issues/5)) ([12589dd](https://github.com/SIRTHEO/claude-switch/commit/12589dd55539684277504a6615fc0aacc055f1f4))
* per-terminal isolation via profiles + auto-engage fallback (2.7.0) ([a9ed414](https://github.com/SIRTHEO/claude-switch/commit/a9ed4146392ac929814aebf0b9096289949803c4))
* per-terminal isolation via profiles + auto-engage fallback (2.7.0) ([a9ed414](https://github.com/SIRTHEO/claude-switch/commit/a9ed4146392ac929814aebf0b9096289949803c4))
* **tui:** auto-fallback settings submenu with auto-engage exposure (4.5) ([05f288b](https://github.com/SIRTHEO/claude-switch/commit/05f288bea9c5537ebeb3a33895e75293c2b0b2ee))
* **tui:** profiles submenu + statusline profile badge (3b.1, 3b.3, 3b.4, 3b.5) ([c6d9634](https://github.com/SIRTHEO/claude-switch/commit/c6d96347ca0e9650a31695d56916e3a2fe9b2cd8))
* **ui:** add notify.ts helpers (notifyError/Ok/Info/Warn) (5.4) ([33203be](https://github.com/SIRTHEO/claude-switch/commit/33203bec20abb6a2016ca2a3e7c76c7c7467845f))


### Bug Fixes

* **statusline:** honour NO_COLOR env var (5.5) ([e745554](https://github.com/SIRTHEO/claude-switch/commit/e7455541707abc73867d39e8c6f99da0480f375f))


### Refactors

* enable noUncheckedIndexedAccess + fix 19 type errors (0.4) ([376deb5](https://github.com/SIRTHEO/claude-switch/commit/376deb5ce1214d30c13df0ca081ecd72be573a91))
* **switcher:** inject spawnSync/ask/exit for testability (0.6b) ([a03ac74](https://github.com/SIRTHEO/claude-switch/commit/a03ac74689097b82083a3f9c51dccb6358771ba2))
* **ui:** extract status panel + alt-buffer helpers from main-menu (5.2) ([c758a51](https://github.com/SIRTHEO/claude-switch/commit/c758a5167fef516635509e6d38e7635998b0917d))


### Documentation

* **coverage:** test coverage audit + new follow-up tasks (0.5) ([997722d](https://github.com/SIRTHEO/claude-switch/commit/997722d0c391f4e406dcd7557004080408534bad))
* design specs + plans batch — 4.7, 2.2, 6.3 closed ([1bfc406](https://github.com/SIRTHEO/claude-switch/commit/1bfc406a635f692aa93a9aa51e6042d8af7b56b1))
* **fallback:** map state machine + auto-revert/engage decision logic (4.1) ([445f08a](https://github.com/SIRTHEO/claude-switch/commit/445f08ab785eedc4c2f58302cfb460a804072f33))
* FAQ entry for mid-session rate limit + reflect auto-engage unpark ([1ae6eb9](https://github.com/SIRTHEO/claude-switch/commit/1ae6eb99c02a22bf7fee54c43c12a9129a7c17f8))
* **plans:** close 1.3 — profile scripts stay local (CI covered by unit tests) ([003c060](https://github.com/SIRTHEO/claude-switch/commit/003c060c3e549f4d93561f38d4e59a9bb332060c))
* **plans:** close 2.1 — release-please config audit (no-op) ([5a8c451](https://github.com/SIRTHEO/claude-switch/commit/5a8c45106a0408df36c286a09c1b481b21fb349d))
* **plans:** close 2.4 (badges no-op) + 2.6 (SLSA verified) ([699c3d0](https://github.com/SIRTHEO/claude-switch/commit/699c3d00e3adbcb4cc8326190a6f4581782d0f24))
* **plans:** close 2.5 + 3b.2 (help text already lists profile commands) ([6fd2252](https://github.com/SIRTHEO/claude-switch/commit/6fd2252457e2c4ffeda903980bf934df309a642f))
* **plans:** close 2.7 — predicted next release 2.7.0 (minor, 2 feat) ([88350c2](https://github.com/SIRTHEO/claude-switch/commit/88350c2c7094df468bd17c2bff125777dac20cae))
* **plans:** close 4.2 — all fallback modules at 100% line coverage ([3eadf0a](https://github.com/SIRTHEO/claude-switch/commit/3eadf0a7f8531c3c1bd4497d8167c3f1fab656fe))
* **plans:** mark 3a.4 complete [0363150] ([4d9623e](https://github.com/SIRTHEO/claude-switch/commit/4d9623eae75e217f96927d404e94d542497ddc74))
* **plans:** mark 6.4 complete — PR[#7](https://github.com/SIRTHEO/claude-switch/issues/7) opened ([db5d4e8](https://github.com/SIRTHEO/claude-switch/commit/db5d4e8317cff9ed8bfb125dece1225e4f4584d0))
* **profiles:** concurrency behaviour analysis + Plans.md cleanup (3a.5) ([d258a1d](https://github.com/SIRTHEO/claude-switch/commit/d258a1d9f3485057fc52730b48e6e33c4508d047))
* **profiles:** Linux behaviour spike — no Keychain, tokens in .claude.json (3a.4) ([0363150](https://github.com/SIRTHEO/claude-switch/commit/0363150d20c014b1ccc37f8082af5ee4cf51fe9e))
* **profiles:** MCP sub-process env inheritance — closed by static analysis (3a.6) ([dcdae17](https://github.com/SIRTHEO/claude-switch/commit/dcdae174c8a59791756b1acf0c1b6f249360883f))
* **profiles:** non-interactive macOS smoke report (3a.1a/3a.2/3a.3) ([87b3966](https://github.com/SIRTHEO/claude-switch/commit/87b3966b8384e98fafdd7c309c5c7fa49660f82a))
* **readme:** add Profiles section + rewrite multi-terminal FAQ (6.1, 6.2) ([42c8122](https://github.com/SIRTHEO/claude-switch/commit/42c81223d5e74716b765f5b0b416348e91bb8eb7))
* **readme:** inline TOC + Profiles bullet + What's-new freshness (2.3) ([a07a72b](https://github.com/SIRTHEO/claude-switch/commit/a07a72bb3554662f97c064eae323958befc60660))
* **readme:** keyboard shortcuts cheatsheet (5.6) ([f7f80ec](https://github.com/SIRTHEO/claude-switch/commit/f7f80ecc03f94cb9c0a641b5fbe3a9f823ca45b3))
* **tui:** static audit of main-menu.ts + sub-screens (5.1) ([a19b276](https://github.com/SIRTHEO/claude-switch/commit/a19b276ec823728d8ddc1e2dde5b4d8806a81b24))

## [2.6.1](https://github.com/SIRTHEO/claude-switch/compare/v2.6.0...v2.6.1) (2026-05-04)


### Bug Fixes

* **active-sessions:** null check before platform check ([#3](https://github.com/SIRTHEO/claude-switch/issues/3)) ([6fb6cb1](https://github.com/SIRTHEO/claude-switch/commit/6fb6cb1bc4c0e139fe8b89f85cc7a3833f460e05))

## [2.6.0](https://github.com/SIRTHEO/claude-switch/compare/v2.5.2...v2.6.0) (2026-04-30)


### Features

* **switch:** warn when other claude sessions are running ([f9be1c7](https://github.com/SIRTHEO/claude-switch/commit/f9be1c7a299bf3481d86be634b15a96e0ff2738f))

## [2.5.2](https://github.com/SIRTHEO/claude-switch/compare/v2.5.1...v2.5.2) (2026-04-30)


### Bug Fixes

* republish with updated README and additional smart-feature tests ([d062740](https://github.com/SIRTHEO/claude-switch/commit/d0627407cc2819af41ae479c4ff9131d4492ece0))


### Documentation

* kill the contradiction between "one command" claim and FAQ commands ([8f03581](https://github.com/SIRTHEO/claude-switch/commit/8f03581bc7b668d35361beba1f58f8019d6d2b96))
* rewrite README — wrapper-first framing, FAQ for AI search, kid-simple install ([82268c3](https://github.com/SIRTHEO/claude-switch/commit/82268c3bf2ecf29e5d6c3bab0bbd288952f77c75))

## Changelog

All notable changes to this project will be documented in this file.
Generated automatically by [release-please](https://github.com/googleapis/release-please)
from [Conventional Commit](https://www.conventionalcommits.org) messages on `main`.

For releases prior to v2.5.2 see the GitHub Releases page:
https://github.com/SIRTHEO/claude-switch/releases
