# Changelog

<!-- Phase 14.3 note: the untracked-apiKey warning added in this release is
     transitional and will be removed in the next minor release. -->

## Unreleased

### Features

* **statusline:** cache-health badge for Claude Code billing-bug visibility (Phase 15.4) ([baa415c](https://github.com/SIRTHEO/claude-switch/commit/baa415c))
* **cli:** claude switch cache-health subcommand for billing-bug diagnostics (Phase 15.5) ([c65b171](https://github.com/SIRTHEO/claude-switch/commit/c65b171))

## [3.8.0](https://github.com/SIRTHEO/claude-switch/compare/v3.7.0...v3.8.0) (2026-05-20)


### Features

* **cli:** --json contract for list and profile list ([3bc0564](https://github.com/SIRTHEO/claude-switch/commit/3bc0564615348d09d20415b52c7c7711dd954c56))
* **cli:** --json on `route test` ([508fb9e](https://github.com/SIRTHEO/claude-switch/commit/508fb9e6b02d9a84af12fec814fcc92b9e2fdee0))
* **cli:** --json on alias-list, fallback status, route-list ([35005dc](https://github.com/SIRTHEO/claude-switch/commit/35005dca8a3718ee80d8989239a0b12a6d64c818))
* **cli:** per-account usage refresh — works for any saved account ([df2ce7e](https://github.com/SIRTHEO/claude-switch/commit/df2ce7e1f06f6fc9d71076392dc37bb26a34ab5a))
* **cli:** per-profile launch in any detected terminal emulator ([793d90b](https://github.com/SIRTHEO/claude-switch/commit/793d90b2a0e7fd4029d4ec9c42e0df2dcdda751d))
* **statusline:** embedded format supersedes ccstatusline chain ([eb68d4e](https://github.com/SIRTHEO/claude-switch/commit/eb68d4e36aa62479fc576478fb4be4b642bbb8d8))
* **usage:** per-account snapshot command ([952c204](https://github.com/SIRTHEO/claude-switch/commit/952c2044b8794e50a2628244d5a9739a677fa489))


### Bug Fixes

* **profiles:** unblock isolated profile launch on Claude Code 2.x ([61a96f4](https://github.com/SIRTHEO/claude-switch/commit/61a96f4cf8755fa3ef1ec064ec1989d3a42b0d77))
* **security:** warn once when Keychain disable flag leaks into prod ([a1cd275](https://github.com/SIRTHEO/claude-switch/commit/a1cd275b6bf20434541d9c163adec3109439b6a3))


### Security

* atomic-write symlink safety ([022e0ba](https://github.com/SIRTHEO/claude-switch/commit/022e0bab9111f8d4c368be6629a6aae91193cbf3))


### Documentation

* **readme:** promote profile flow + crisper top, add Discord contact ([c853172](https://github.com/SIRTHEO/claude-switch/commit/c85317267aea75c6aa12375ebca6daf95d573505))
* **readme:** rewrite with honest competitor comparison and security trade-offs ([1a3d557](https://github.com/SIRTHEO/claude-switch/commit/1a3d557221736d476afdcef9f0569fabb111e28c))
* restore README images + drop dev-process phrasing in keychain.ts ([b303c13](https://github.com/SIRTHEO/claude-switch/commit/b303c13ec7c785b340c3116dd0314f790b269935))

## [3.7.0](https://github.com/SIRTHEO/claude-switch/compare/v3.5.1...v3.7.0) (2026-05-15)


### Features

* **cache-health:** findActiveSessionJsonl helper for active Claude Code session lookup ([43de1c4](https://github.com/SIRTHEO/claude-switch/commit/43de1c470d50795ef0bb630823c213515f209620))
* **cache-health:** JSONL parser + summary for Claude Code billing-bug visibility ([88bbbfa](https://github.com/SIRTHEO/claude-switch/commit/88bbbfaa94373c835b83327e72bee6c09735dd7a))
* **cache-health:** loadActiveSessionHealth glue with 1s in-process cache ([875c377](https://github.com/SIRTHEO/claude-switch/commit/875c377bfa722dfda4ae81baa23e8f434338f3d4))
* **cli:** claude switch cache-health subcommand for billing-bug diagnostics ([ecf3685](https://github.com/SIRTHEO/claude-switch/commit/ecf3685befd3b051526144b74adc51b235416039))
* **passthrough:** warn on untracked apiKey in claude.json (transitional) ([f33ae73](https://github.com/SIRTHEO/claude-switch/commit/f33ae73750ae972a4f547d043406988d8975832a))
* **profiles:** CLAUDE_SWITCH_DEBUG_PROFILES diagnostic flag (part A) ([ba7c39b](https://github.com/SIRTHEO/claude-switch/commit/ba7c39bee338befb17ab6954f28e2d678cf01c39))
* **proxy:** realtime usage push from upstream rate-limit headers ([0f97e0f](https://github.com/SIRTHEO/claude-switch/commit/0f97e0fafaf51f33790ef68088815ad96fc8557d))
* **statusline:** cache-health badge for Claude Code billing-bug visibility ([cd4ea38](https://github.com/SIRTHEO/claude-switch/commit/cd4ea38c1af0a98e8b25ea9928d9b7039743607c))
* **statusline:** realtime account/profile/usage  ([a319d84](https://github.com/SIRTHEO/claude-switch/commit/a319d8429255bc2da8279104c07dd8d915f26ed1))
* **statusline:** reflect proxy runtime mode ([71f0310](https://github.com/SIRTHEO/claude-switch/commit/71f03106ac2533701e9b53fe9cf933ac353adaa0))
* **usage:** tighten cache TTL constants ([41f0f80](https://github.com/SIRTHEO/claude-switch/commit/41f0f802b561216f3b044af1f15cfe5694914cd3))


### Bug Fixes

* **passthrough:** wire accountsDirPath+account into startFallbackProxy  ([eb18276](https://github.com/SIRTHEO/claude-switch/commit/eb182765d8604626d9ae27425036d1f733787fea))
* **profiles:** live Keychain capture for active-account isolated ([f4c1181](https://github.com/SIRTHEO/claude-switch/commit/f4c118172aa1853b3e9f6d33a1fc6fadf8174fca))
* **review:** address findings from post-quality push review ([c8da529](https://github.com/SIRTHEO/claude-switch/commit/c8da529805433046d7332f738c7166636993c658))
* **scripts:** resolve bare filenames in graph:task fallback ([a0b2656](https://github.com/SIRTHEO/claude-switch/commit/a0b265608ffd5317fde15d8008417e0effde38dc))
* **security:** prevent silent API-key billing via untracked claude.json snapshot ([7e55cf8](https://github.com/SIRTHEO/claude-switch/commit/7e55cf82df90bc3eb2553b4a1966393d4e4b68f3))
* **setup-wizard:** complete useEffect dependency array ([fd2c8b4](https://github.com/SIRTHEO/claude-switch/commit/fd2c8b441e07ccc9046754e3b92ba8cbb3fab910))
* **test:** set USERPROFILE alongside HOME for Windows os.homedir() isolation ([a361db5](https://github.com/SIRTHEO/claude-switch/commit/a361db5c8e5bd879fb4df0218cedbff577479837))
* **test:** skip statusline cache-health E2E scenarios on Windows ([7fe23ef](https://github.com/SIRTHEO/claude-switch/commit/7fe23eff158e4919128f25c67aff4a7afeba5714))
* **test:** Windows compatibility for E2E + skip POSIX-only tests ([ff00290](https://github.com/SIRTHEO/claude-switch/commit/ff0029073861ac19985fc9311f4de6ed2a060f62))
* **test:** Windows EBUSY on rmSync + skip POSIX-only shell binary check ([10e3fe2](https://github.com/SIRTHEO/claude-switch/commit/10e3fe2bcc5106e6b302d0e4f16ccdbc9e5f5e14))


### Refactors

* **cli:** consolidate shared arg-parsing helper with commands/_helpers ([f0e1277](https://github.com/SIRTHEO/claude-switch/commit/f0e12779df3440b9e83afa0152da5a30ee591ef5))
* **profiles:** consolidate refreshLegacySnapshotIfStale inside ensureProfileForAccount ([595b20a](https://github.com/SIRTHEO/claude-switch/commit/595b20ae4ea0a518f2ac3129ab5b009923c3a252))
* **proxy:** extract upstream usage header parsing helper ([0b8904c](https://github.com/SIRTHEO/claude-switch/commit/0b8904cb175380156cf0068bd8bef007bda68067))
* **types:** audit and tighten 'as' casts in domain modules ([c6e4441](https://github.com/SIRTHEO/claude-switch/commit/c6e44417edced7daf564a385798f5b1265e37f69))
* **ui:** apply ExitError pattern to handleSwitched (16.2 follow-up) ([ac92bc7](https://github.com/SIRTHEO/claude-switch/commit/ac92bc79929646c22eef151ea44178597fecb0d6))
* **ui:** centralize Ink screen await via awaitInkScreen helper ([ebda74a](https://github.com/SIRTHEO/claude-switch/commit/ebda74a9b56ae49a5f95d3ed4c3e41cb08043e17))
* **ui:** replace process.exit with ExitError in profiles.tsx spawn handler ([71e9838](https://github.com/SIRTHEO/claude-switch/commit/71e98383a2caadf29bad81bfdc4f4d26a97e0440))


### Documentation

* **contributing:** release cadence policy + bump decision matrix ([69647de](https://github.com/SIRTHEO/claude-switch/commit/69647de8d7e6b4c02db4671269c76be1d6286cd5))
* integrate understand-anything graph with /harness-work flow ([61666e3](https://github.com/SIRTHEO/claude-switch/commit/61666e3624798e79f463fa50d55af6c0e8c9d9df))
* **internal:** document Ink screen reject path and ExitError pattern ([c0db564](https://github.com/SIRTHEO/claude-switch/commit/c0db564c902ea19933b2b291b522ffd03a496d72))
* **readme:** add CI status badges ([07d023b](https://github.com/SIRTHEO/claude-switch/commit/07d023bc78c59c1283629068f2f34f8f9735d386))
* **readme:** cache-health visibility section + CHANGELOG entries ([7b0d171](https://github.com/SIRTHEO/claude-switch/commit/7b0d1714877712e7761946c1e0ba7d04ff6800ca))
* **security:** document silent API-key risk and 14.2/14.3 mitigations ([97b466a](https://github.com/SIRTHEO/claude-switch/commit/97b466ad5812e436a70f7772bcadf10d198ad61f))


### Chores

* **release:** coordinate multi-phase release ([e942389](https://github.com/SIRTHEO/claude-switch/commit/e942389f32f4431886b83f487a3d879310560d37))

## [3.5.1](https://github.com/SIRTHEO/claude-switch/compare/v3.5.0...v3.5.1) (2026-05-08)


### Bug Fixes

* **switcher:** make auto-flip fallback OAuth-aware (Phase 11.10) ([8a6d0c3](https://github.com/SIRTHEO/claude-switch/commit/8a6d0c3e00d2dd1395ce2d88ca4ad8d7a310bf29))


### Refactors

* **errors:** introduce errMessage / errnoCode helpers, drop 22 type casts (Phase 11.7) ([23f3f4e](https://github.com/SIRTHEO/claude-switch/commit/23f3f4ea48b583b4cf089eb36bea581edb2cae9c))
* **ui:** split home.tsx sub-components into per-file modules (Phase 11.6) ([17b2b39](https://github.com/SIRTHEO/claude-switch/commit/17b2b397cb0b7d580d3d7051a15f7445fc48b983))
* **ui:** split profiles.tsx menu metadata + pick-list helper (Phase 11.5) ([9117ed0](https://github.com/SIRTHEO/claude-switch/commit/9117ed012fb8d66194e95434410ae30c2e239074))


### Documentation

* **internal:** architecture overview (Phase 11.8) ([66a3d9d](https://github.com/SIRTHEO/claude-switch/commit/66a3d9d978a0945d9163fa5a183711a6a3edb37c))
* **internal:** error-handling audit + policy (Phase 11.4) ([ef466a1](https://github.com/SIRTHEO/claude-switch/commit/ef466a195071f5dabcf5197013a40f7d79606888))

## [3.5.0](https://github.com/SIRTHEO/claude-switch/compare/v3.4.1...v3.5.0) (2026-05-07)


### Features

* ship v3.5 bundle (PR [#20](https://github.com/SIRTHEO/claude-switch/issues/20) squashed without conventional prefix) ([#26](https://github.com/SIRTHEO/claude-switch/issues/26)) ([5f02338](https://github.com/SIRTHEO/claude-switch/commit/5f0233833f71e2f2f4a48a6d662bf653f9e05bfb))

## [3.4.1](https://github.com/SIRTHEO/claude-switch/compare/v3.4.0...v3.4.1) (2026-05-06)


### Refactors

* **ui:** consolidate multi-step workflows behind domain helpers ([b5a01c7](https://github.com/SIRTHEO/claude-switch/commit/b5a01c7a1ae48ff5e7851814cc4f05f8bf87eb31))

## [3.4.0](https://github.com/SIRTHEO/claude-switch/compare/v3.3.0...v3.4.0) (2026-05-06)


### Features

* **security:** store API keys in macOS Keychain ([9116c00](https://github.com/SIRTHEO/claude-switch/commit/9116c00fb4f85882ab2c8eeff2da41fa161ea9b4))
* **storage:** unify ephemeral state into state.json with on-read migration ([8362122](https://github.com/SIRTHEO/claude-switch/commit/83621227192185fba2be3dec4871e022f9a48b40))


### Refactors

* **cli:** drop unused helpers after handler extraction ([deb15e7](https://github.com/SIRTHEO/claude-switch/commit/deb15e73aaeba5e4ff6d60712212980c884016c1))
* **cli:** extract per-command handlers, bin/cli.ts 1226→981 LOC ([e93e889](https://github.com/SIRTHEO/claude-switch/commit/e93e889281784bf33b655f542142909d3819cee3))
* **cli:** extract profile + passthrough handlers, bin/cli.ts 789→487 LOC ([866f933](https://github.com/SIRTHEO/claude-switch/commit/866f933830342ec1a07c19b8602d1df28b10c9a4))
* **cli:** extract switch + statusline handlers, bin/cli.ts 938→789 LOC ([8fb71fd](https://github.com/SIRTHEO/claude-switch/commit/8fb71fd674ac9a8d23ba6b69a9de53eba9568092))

## [3.3.0](https://github.com/SIRTHEO/claude-switch/compare/v3.2.0...v3.3.0) (2026-05-06)


### Features

* **auth:** live OAuth ↔ API transitions, per-account authMode ([9e2b58e](https://github.com/SIRTHEO/claude-switch/commit/9e2b58e86596744ed7d4de70432c94f32e61a4ff))


### Documentation

* **readme:** add trademark notice clarifying community/non-affiliated status ([bc41b1b](https://github.com/SIRTHEO/claude-switch/commit/bc41b1ba61475c1c9d101e1948c9d8894183fa02))

## [3.2.0](https://github.com/SIRTHEO/claude-switch/compare/v3.1.2...v3.2.0) (2026-05-06)


### Features

* **cli:** rename `fallback auto` → `auto-revert`, keep `auto` as deprecated alias ([e24bfee](https://github.com/SIRTHEO/claude-switch/commit/e24bfee97a9ed12ce74d9e335065d2c21e6552ef))


### Bug Fixes

* **brand:** align hyphen baseline in logo wordmark ([cb581f0](https://github.com/SIRTHEO/claude-switch/commit/cb581f0ac8813a3125c9af2ecc368ad2a763a154))

## [3.1.2](https://github.com/SIRTHEO/claude-switch/compare/v3.1.1...v3.1.2) (2026-05-06)


### Documentation

* bundle transparent logo into npm release ([1523128](https://github.com/SIRTHEO/claude-switch/commit/15231280f559ea4d51279a3437942f5a809d5efe))
* **readme:** transparent logo with theme-aware fill ([88c4590](https://github.com/SIRTHEO/claude-switch/commit/88c45906f3ff1609666e60a8661a6fe72856063b))

## [3.1.1](https://github.com/SIRTHEO/claude-switch/compare/v3.1.0...v3.1.1) (2026-05-06)


### Bug Fixes

* **security:** close audit findings from post-3.1.0 review ([977b1d8](https://github.com/SIRTHEO/claude-switch/commit/977b1d8d73ef765978271dac506866c5c7fb584b))


### Documentation

* **readme:** redesign with logo + TL;DR + per-feature sections ([7e49a28](https://github.com/SIRTHEO/claude-switch/commit/7e49a28372831502bb15c46ed74c9da19053b1e9))
* **readme:** rename logo to wordmark.svg to bust camo cache ([9550539](https://github.com/SIRTHEO/claude-switch/commit/9550539fd814eb10e6f838e44d8dc3359c3f4fe8))
* **readme:** trim verbose sections, polish logo wordmark ([c800bac](https://github.com/SIRTHEO/claude-switch/commit/c800bac44b25e72294b9da00a469039f6d7cc1a4))

## [3.1.0](https://github.com/SIRTHEO/claude-switch/compare/v3.0.1...v3.1.0) (2026-05-06)


### Features

* **ui:** Ink dashboard PoC under \`claude switch dashboard\` ([d8e50e5](https://github.com/SIRTHEO/claude-switch/commit/d8e50e51978140e7358f885011fa1097f7853c23))
* **ui:** rebuild interactive TUI on Ink with per-account preferences ([e0170c2](https://github.com/SIRTHEO/claude-switch/commit/e0170c2e5125c7ab8b109b546ab10173122ac824))


### Bug Fixes

* **ui:** include src/ui/hooks/ in the build (gitignore was eating it) ([a42c694](https://github.com/SIRTHEO/claude-switch/commit/a42c6948ff74fe6216152ff356875abead06f351))

## [3.0.1](https://github.com/SIRTHEO/claude-switch/compare/v3.0.0...v3.0.1) (2026-05-06)


### Bug Fixes

* **proxy:** use async spawn so the local fallback proxy can serve requests ([f1dbcf5](https://github.com/SIRTHEO/claude-switch/commit/f1dbcf53bde71af826bc491ab143f4f773bc00ec))

## [3.0.0](https://github.com/SIRTHEO/claude-switch/compare/v2.8.1...v3.0.0) (2026-05-06)


### ⚠ BREAKING CHANGES

* rename package to claudeswitch

### Features

* add --as flag for temporary account switch with crash recovery ([2194ce6](https://github.com/SIRTHEO/claude-switch/commit/2194ce6a0d0d8c0243da7d73ed7eae688b9fee2d))
* add aliases module with CRUD and resolution ([6a0e3fd](https://github.com/SIRTHEO/claude-switch/commit/6a0e3fd257fe5da8bdfdf435952adca9e19ec052))
* add background update notifier ([74190b0](https://github.com/SIRTHEO/claude-switch/commit/74190b00996c6418e54a530c2a7ad4003505d3c5))
* add claude switch update command and interactive update prompt ([ed6ea20](https://github.com/SIRTHEO/claude-switch/commit/ed6ea2031b2269ec59128b25c9b1c200d044c9b4))
* add claudeBinFile() to paths ([b308331](https://github.com/SIRTHEO/claude-switch/commit/b30833173f4d55f6180c764dffb9a96412226215))
* add cross-platform paths module ([148c58c](https://github.com/SIRTHEO/claude-switch/commit/148c58c5a214e7a7135c8331b2e6dd372262c23e))
* add cross-platform proxy module ([580fbf0](https://github.com/SIRTHEO/claude-switch/commit/580fbf08738b215bbd52cd176535ee0292eda711))
* add ExitError and VERSION constants ([886e8ed](https://github.com/SIRTHEO/claude-switch/commit/886e8ed55afecc7973685eedd0ec30277d73ec4e))
* add fuzzy match for account switching ([7325e3d](https://github.com/SIRTHEO/claude-switch/commit/7325e3d35af0b8469feec0d933338237a7b4ec91))
* add getCurrent account reader ([eb74803](https://github.com/SIRTHEO/claude-switch/commit/eb748034931d348ece7d2f3ea8b8d9fc0f5db42e))
* add help command to claude switch ([f1cf584](https://github.com/SIRTHEO/claude-switch/commit/f1cf58459d8a8c019d2830714b1b40cb959337b3))
* add interactive switch menu and add-account flow ([9144ae4](https://github.com/SIRTHEO/claude-switch/commit/9144ae44e2e7e0f9f2295ed4ef6870b70028fa4e))
* add list and remove account operations ([38ee1c2](https://github.com/SIRTHEO/claude-switch/commit/38ee1c2bceef49103474b8014335bc899466781b))
* add postinstall entry point ([27fe755](https://github.com/SIRTHEO/claude-switch/commit/27fe7557751e35249b985c7248fd4fb7352b5525))
* add postinstall hook, bump to 2.1.2 ([e191a6c](https://github.com/SIRTHEO/claude-switch/commit/e191a6c48dc77ffe01aebd366b7968a93f0e21a2))
* add save and load account operations ([a223783](https://github.com/SIRTHEO/claude-switch/commit/a223783aa03e077b0fc103e2f4856e673d3e7858))
* add save_and_report helper for smart account messages ([ca7106a](https://github.com/SIRTHEO/claude-switch/commit/ca7106a71f90d98054cf6d53e9b7c4b71ac19b7d))
* add shell completions for bash, zsh, fish, PowerShell ([caf48be](https://github.com/SIRTHEO/claude-switch/commit/caf48be085a7f6583b07c600bf93e69bf978b311))
* add switchTo with auto-save of current account ([85380f1](https://github.com/SIRTHEO/claude-switch/commit/85380f147e98baeaa6ee38cb38f478a91c29983f))
* add three-tier binary resolver ([f9ea861](https://github.com/SIRTHEO/claude-switch/commit/f9ea8618542930eb248122a9458a95001d7b9ac8))
* add token health check module ([b9853fb](https://github.com/SIRTHEO/claude-switch/commit/b9853fb29d35839781d7767741144ba9ec74b0b4))
* background usage refresh keeps statusline near-live ([6ef0233](https://github.com/SIRTHEO/claude-switch/commit/6ef0233be82a45fee6f462eba181dfd407a50b49))
* claude switch statusline — one-line account/mode summary ([40ffbaa](https://github.com/SIRTHEO/claude-switch/commit/40ffbaac191feca6edcb42482b989a5d34720458))
* enhanced switch status with token health and aliases ([0bf5572](https://github.com/SIRTHEO/claude-switch/commit/0bf5572fd8e2158ee2a663597920c5d9e4a24ab2))
* **fallback:** auto-init smart fallback when API key is first saved ([41d69e7](https://github.com/SIRTHEO/claude-switch/commit/41d69e7ca32c0e432626d1c9d079c1d8d0bf877f))
* **fallback:** auto-sync fallback state when switching accounts ([3ca2e20](https://github.com/SIRTHEO/claude-switch/commit/3ca2e20227860728e11cbfc88093762acfe944a3))
* **fallback:** distinguish auto-engaged from manual fallback in statusline (4.6) ([f064a21](https://github.com/SIRTHEO/claude-switch/commit/f064a215b847d15c3ebf845908518994a2310b70))
* **fallback:** wire auto-engage to flip ON before hitting cap ([d0adc4c](https://github.com/SIRTHEO/claude-switch/commit/d0adc4cf292e0b06b5044cf76533d24866aa6800))
* **fallback:** wire auto-engage to flip ON before hitting cap ([#5](https://github.com/SIRTHEO/claude-switch/issues/5)) ([12589dd](https://github.com/SIRTHEO/claude-switch/commit/12589dd55539684277504a6615fc0aacc055f1f4))
* findClaude() reads saved bin, add switch setup command ([fd371b9](https://github.com/SIRTHEO/claude-switch/commit/fd371b966dd4a7020b32fe85d99bc13c5e82dcd7))
* implement CLI entry point with command routing ([935e512](https://github.com/SIRTHEO/claude-switch/commit/935e5123dfc5d0e1f2314e6fb3ec6842d5c47d3b))
* initial release of claude-switch wrapper ([0a3225f](https://github.com/SIRTHEO/claude-switch/commit/0a3225f9c32b8ef84fedd261d609b845d0719902))
* install Claude Code status-bar badge automatically ([fad9205](https://github.com/SIRTHEO/claude-switch/commit/fad920512449e0f6a636c8b6d8888c269c8edb5a))
* instant multi-account switching via Keychain token swap ([4bd9cb5](https://github.com/SIRTHEO/claude-switch/commit/4bd9cb58c1740c0a28b98e38d9a25069fba67695))
* integrate aliases into CLI — set, list, remove, resolve ([31f4eb2](https://github.com/SIRTHEO/claude-switch/commit/31f4eb2ea9e015d8f63194193ea11167b8ea58f1))
* Node.js rewrite v2.1.0 — cross-platform, aliases, --as, token health ([547da0f](https://github.com/SIRTHEO/claude-switch/commit/547da0fdf5b34860b20124189c7ba6c8a1eb35f5))
* per-account API key with manual fallback toggle ([9c090d4](https://github.com/SIRTHEO/claude-switch/commit/9c090d4a20ad8a20ca3b5c71bd276e80e5a0929b))
* per-terminal isolation via profiles + auto-engage fallback (2.7.0) ([a9ed414](https://github.com/SIRTHEO/claude-switch/commit/a9ed4146392ac929814aebf0b9096289949803c4))
* per-terminal isolation via profiles + auto-engage fallback (2.7.0) ([a9ed414](https://github.com/SIRTHEO/claude-switch/commit/a9ed4146392ac929814aebf0b9096289949803c4))
* **profiles:** import legacy accounts into isolated profiles without browser re-login ([55c041a](https://github.com/SIRTHEO/claude-switch/commit/55c041a734d1958612ff405050348dd3de0d7d73))
* **profiles:** isolated per-terminal profiles via CLAUDE_CONFIG_DIR ([eef0f0c](https://github.com/SIRTHEO/claude-switch/commit/eef0f0c0647b38141266a1530d06965eefb64cbe))
* **profiles:** one-step 'open account isolated' from menu ([0458801](https://github.com/SIRTHEO/claude-switch/commit/045880194518a2f56bdf353bd2339d740f152857))
* prompt for alias during switch add ([f6ee996](https://github.com/SIRTHEO/claude-switch/commit/f6ee99601f9e8a7c441ae938c949b3b35a2c2292))
* **proxy:** align startWithOAuth with fallbackOn flag for accurate statusline ([580f84f](https://github.com/SIRTHEO/claude-switch/commit/580f84f410ea45b026fa0a3d82495802c635626f))
* **proxy:** mid-session account rotation via local HTTP proxy ([da85815](https://github.com/SIRTHEO/claude-switch/commit/da8581543b36e76be735cca374ce423b2da6b5f1))
* read subscription usage via /api/oauth/usage endpoint ([ffdd80d](https://github.com/SIRTHEO/claude-switch/commit/ffdd80dddfb49a78fa4ae6cebeffdb824accf0ff))
* rename package to claudeswitch ([fac0dc2](https://github.com/SIRTHEO/claude-switch/commit/fac0dc2e7decf01c527c84e19e40172c30a83d49))
* replace postinstall hook with explicit setup command ([f2c6839](https://github.com/SIRTHEO/claude-switch/commit/f2c6839f61ac5081019cd49c57cf5a7f2e9fa5ed))
* scaffold Node.js project structure ([ba1e502](https://github.com/SIRTHEO/claude-switch/commit/ba1e5028571e674e6c33c93ba5404ce5718dfc87))
* serialize concurrent swaps with advisory lock ([6be01fa](https://github.com/SIRTHEO/claude-switch/commit/6be01fac3dfecd13cd2686653bcaf177f3c03b4d))
* setup logic — find real claude, save bin, patch shell configs ([b92b461](https://github.com/SIRTHEO/claude-switch/commit/b92b461570cfae3771f2b96fa1c1689e5e2d4180))
* smart add_account with email verification and retry ([6312a3d](https://github.com/SIRTHEO/claude-switch/commit/6312a3d6a6bd59a04d1124590f3f23b2725a9eac))
* smart-switch — auto-disable fallback when subscription has room ([f331f3c](https://github.com/SIRTHEO/claude-switch/commit/f331f3cc6b0544137b8af22d23c9695e2585f70f))
* **switch:** warn when other claude sessions are running ([f9be1c7](https://github.com/SIRTHEO/claude-switch/commit/f9be1c7a299bf3481d86be634b15a96e0ff2738f))
* translate messages to English, auto-detect account on first run ([69d4d4c](https://github.com/SIRTHEO/claude-switch/commit/69d4d4c993e05dae682f108636c29d7603881059))
* **tui:** auto-fallback settings submenu with auto-engage exposure (4.5) ([05f288b](https://github.com/SIRTHEO/claude-switch/commit/05f288bea9c5537ebeb3a33895e75293c2b0b2ee))
* **tui:** profiles submenu + statusline profile badge (3b.1, 3b.3, 3b.4, 3b.5) ([c6d9634](https://github.com/SIRTHEO/claude-switch/commit/c6d96347ca0e9650a31695d56916e3a2fe9b2cd8))
* **ui:** @clack/prompts wizards for setup, add, remove, apikey-set ([f45b12a](https://github.com/SIRTHEO/claude-switch/commit/f45b12a2d5ab0b6d815dc8c4596f962fdfc72256))
* **ui:** add notify.ts helpers (notifyError/Ok/Info/Warn) (5.4) ([33203be](https://github.com/SIRTHEO/claude-switch/commit/33203bec20abb6a2016ca2a3e7c76c7c7467845f))
* **ui:** main menu + per-account usage cache + Claude orange theme ([6451505](https://github.com/SIRTHEO/claude-switch/commit/6451505fd11ee5960ae5f9e9a2a6b6681d002aa4))
* **ui:** polished interactive picker for `claude switch` ([8ba0d2c](https://github.com/SIRTHEO/claude-switch/commit/8ba0d2cae93984549c41533915b60bbe0abdd155))
* **update:** auto-update in background on passthrough ([52cf892](https://github.com/SIRTHEO/claude-switch/commit/52cf89263240141443158854190e20f17dc6651f))


### Bug Fixes

* 2 multi-account race conditions on usage + passthrough ([302c149](https://github.com/SIRTHEO/claude-switch/commit/302c149ffbc4b7a0d43920787c406505c2afcea7))
* 2 regressions surfaced by historical-feature audit ([7e0ca9c](https://github.com/SIRTHEO/claude-switch/commit/7e0ca9c97e20583c8a1b8ed6751584b568c4deb5))
* 4 issues from UX audit (auto-launch, reauth, smart-switch) ([5ee391a](https://github.com/SIRTHEO/claude-switch/commit/5ee391a9ba98b535ee510eef61c45245882cfd94))
* 5 robustness issues from audit ([354cb4d](https://github.com/SIRTHEO/claude-switch/commit/354cb4d9008d660558b263c8d9908a1385d05a06))
* 6 issues from third audit round (cross-platform, retry-after, semver, etc.) ([67aad21](https://github.com/SIRTHEO/claude-switch/commit/67aad21a0ca2d0f2a3b99620d7c55d4646c7f8cd))
* **active-sessions:** null check before platform check ([#3](https://github.com/SIRTHEO/claude-switch/issues/3)) ([6fb6cb1](https://github.com/SIRTHEO/claude-switch/commit/6fb6cb1bc4c0e139fe8b89f85cc7a3833f460e05))
* add --version flag, replace process.exit with ExitError in CLI ([43ffb33](https://github.com/SIRTHEO/claude-switch/commit/43ffb332eb6094390f8096ba6156fdd6e72109b8))
* add JSON error handling and email sanitization ([fc87898](https://github.com/SIRTHEO/claude-switch/commit/fc87898f2e9868addd6bc5ee7f536b9ebde82c53))
* auto-save active account when not yet in saved accounts ([88e5502](https://github.com/SIRTHEO/claude-switch/commit/88e55020fc86519c09e35350eba051c4b843a965))
* bump engines.node to 20.12, drop Node 18 from CI matrix ([81c9f5e](https://github.com/SIRTHEO/claude-switch/commit/81c9f5ece8965118ead37d5ed353f25f2493d904))
* detect cancelled login when email unchanged after auth ([7857fde](https://github.com/SIRTHEO/claude-switch/commit/7857fdec6f19ba697133e0a458ca4186ac628dc0))
* exclude internal files from account list ([e35cf34](https://github.com/SIRTHEO/claude-switch/commit/e35cf34dbb9e6af6e27a49a74b388661f3d7aaea))
* handle Windows glob expansion in CI test step ([7342832](https://github.com/SIRTHEO/claude-switch/commit/7342832ce38db1ddf3b3112f7e6ede8bf67e28bf))
* improve update-check robustness ([02a8a3f](https://github.com/SIRTHEO/claude-switch/commit/02a8a3fc41ef8e73b011c7208c239d7df39ccebc))
* include keychain tokens in account save/load on macOS ([0e47831](https://github.com/SIRTHEO/claude-switch/commit/0e478313961c889b1aa7fcd501236154ed58f45a))
* log postinstall failures, pass correct cli selfPath to setup ([94378eb](https://github.com/SIRTHEO/claude-switch/commit/94378eb3c571ab9f0360e6bdce81ac3efbc8f3d4))
* prevent infinite loop in find_real_claude path resolution ([ae3b9c2](https://github.com/SIRTHEO/claude-switch/commit/ae3b9c2d96de982d6aa814cc3518708e575cc7f2))
* **proxy:** same-account OAuth→API key fallback on 429, no cross-account rotation ([3e1943c](https://github.com/SIRTHEO/claude-switch/commit/3e1943cde010d07c8b7d079d7524bbb82b7db2f0))
* replace process.exit with ExitError in switcher, improve first-account messaging ([8158a86](https://github.com/SIRTHEO/claude-switch/commit/8158a86018cb5304ec730ef7b9749e21fdcdd851))
* republish with updated README and additional smart-feature tests ([d062740](https://github.com/SIRTHEO/claude-switch/commit/d0627407cc2819af41ae479c4ff9131d4492ece0))
* sanitize npmBinDir in patchShellConfig, respect CLAUDE_SWITCH_BIN in findRealClaude ([6225331](https://github.com/SIRTHEO/claude-switch/commit/6225331f24f0e517ddfe1f05da02b7b3445723d4))
* security hardening and release improvements v2.1.1 ([30944d5](https://github.com/SIRTHEO/claude-switch/commit/30944d545f234b82d250ac7227a0e1fc298def80))
* show correct post-update message after self-update ([cd4c368](https://github.com/SIRTHEO/claude-switch/commit/cd4c368259b15f8556d692f26b1caeda4fdb483c))
* **statusline:** honour NO_COLOR env var (5.5) ([e745554](https://github.com/SIRTHEO/claude-switch/commit/e7455541707abc73867d39e8c6f99da0480f375f))
* switch via oauthAccount in .claude.json instead of Keychain ([51bdc1b](https://github.com/SIRTHEO/claude-switch/commit/51bdc1b9159ec064ec5e2cf574d244fa1df675f2))
* use node --test auto-discovery for cross-platform CI compatibility ([71f92ab](https://github.com/SIRTHEO/claude-switch/commit/71f92ab40c7343c817afe28a365979ba5ff7f0ba))
* use single glob for cross-platform node --test compatibility ([23506af](https://github.com/SIRTHEO/claude-switch/commit/23506af3e3716317435e3ba4940a91559b1de1b0))
* validate alias names + harden binary discovery ([5ba3c48](https://github.com/SIRTHEO/claude-switch/commit/5ba3c48bba794f2e2922389227496ae7573e1f3f))


### Security

* also wrap TUI setApiKey/remove in withLock ([2b17667](https://github.com/SIRTHEO/claude-switch/commit/2b176674db6c078e8d107fe512b38b1bcabcc77b))
* fix 5 audit findings (silent catch, race conditions, validation inconsistency) ([5782e0c](https://github.com/SIRTHEO/claude-switch/commit/5782e0c5a4ad319c9a10b9b7f6d1a193197f060d))
* fix 5 issues from second audit round ([8975f49](https://github.com/SIRTHEO/claude-switch/commit/8975f4987850ecb0e059f93192dddc35133d18d5))
* harden Keychain & account credential handling ([7437b25](https://github.com/SIRTHEO/claude-switch/commit/7437b25cbb893d71b7c2a0e1cca2e5616c79b820))


### User Experience

* alt-screen buffer + context-aware token messaging ([46643ab](https://github.com/SIRTHEO/claude-switch/commit/46643ab12230bdc2d4fcf8601dce3670fba8ad03))
* clearer apikey-set prompt + confirm-before-saving for invalid keys ([9d4f8de](https://github.com/SIRTHEO/claude-switch/commit/9d4f8de1fa3871b45e6f77001fa8322e455c2faa))
* confirm before overwriting an existing apikey ([f6c53ff](https://github.com/SIRTHEO/claude-switch/commit/f6c53ff251efd7022665fb1b9b0a7f083f0b39e5))
* in-menu re-auth + auto-launch claude after switch ([c697601](https://github.com/SIRTHEO/claude-switch/commit/c697601d4dfb199d53ddbaa6baaa0caa0414d6b0))
* rename smart-switch to "auto-revert to OAuth", add Manage account submenu ([03b05e8](https://github.com/SIRTHEO/claude-switch/commit/03b05e851333c96f3415fe09b0bfd5bff70193bd))
* smarter main menu after first-user feedback ([1dfc185](https://github.com/SIRTHEO/claude-switch/commit/1dfc185d11553370b4d37bf436e40ca4c7c12a3b))


### Refactors

* convert project to TypeScript ([b665516](https://github.com/SIRTHEO/claude-switch/commit/b6655169715dc24b56caed55c8bc024c43429a89))
* enable noUncheckedIndexedAccess + fix 19 type errors (0.4) ([376deb5](https://github.com/SIRTHEO/claude-switch/commit/376deb5ce1214d30c13df0ca081ecd72be573a91))
* extract writeJsonAtomic helper, share email validation ([cbc3a2e](https://github.com/SIRTHEO/claude-switch/commit/cbc3a2eb20c9725882206382c5ea587b204f224a))
* **switcher:** inject spawnSync/ask/exit for testability (0.6b) ([a03ac74](https://github.com/SIRTHEO/claude-switch/commit/a03ac74689097b82083a3f9c51dccb6358771ba2))
* **ui:** extract status panel + alt-buffer helpers from main-menu (5.2) ([c758a51](https://github.com/SIRTHEO/claude-switch/commit/c758a5167fef516635509e6d38e7635998b0917d))


### Documentation

* add smart add-account design spec ([9f18321](https://github.com/SIRTHEO/claude-switch/commit/9f183214394fb9d30611284798046f384d5eb370))
* add smart add-account implementation plan ([3852c04](https://github.com/SIRTHEO/claude-switch/commit/3852c045887655313e0cd369b142e6a5f6bad21b))
* **coverage:** test coverage audit + new follow-up tasks (0.5) ([997722d](https://github.com/SIRTHEO/claude-switch/commit/997722d0c391f4e406dcd7557004080408534bad))
* design specs + plans batch — 4.7, 2.2, 6.3 closed ([1bfc406](https://github.com/SIRTHEO/claude-switch/commit/1bfc406a635f692aa93a9aa51e6042d8af7b56b1))
* **experiment:** per-terminal isolation research log ([90c76ff](https://github.com/SIRTHEO/claude-switch/commit/90c76fffcfce868694d7e882befa08ed94eba4c1))
* **fallback:** map state machine + auto-revert/engage decision logic (4.1) ([445f08a](https://github.com/SIRTHEO/claude-switch/commit/445f08ab785eedc4c2f58302cfb460a804072f33))
* FAQ entry for mid-session rate limit + reflect auto-engage unpark ([1ae6eb9](https://github.com/SIRTHEO/claude-switch/commit/1ae6eb99c02a22bf7fee54c43c12a9129a7c17f8))
* focus README on claude switch first + auto-update banner ([0a30793](https://github.com/SIRTHEO/claude-switch/commit/0a307938a72b1041a07e75b71877724df18f3509))
* improve SEO — keywords, topics, first-paragraph density ([20735ae](https://github.com/SIRTHEO/claude-switch/commit/20735aeac8710c29a598e551ae28c72fb131837e))
* kill the contradiction between "one command" claim and FAQ commands ([8f03581](https://github.com/SIRTHEO/claude-switch/commit/8f03581bc7b668d35361beba1f58f8019d6d2b96))
* **plans:** add Phase 7 tasks for 2.8.0 (auto-update + one-step isolation) ([d1dd8c9](https://github.com/SIRTHEO/claude-switch/commit/d1dd8c9ee7a7662283b8570a5ff03715837ee123))
* **plans:** close 1.3 — profile scripts stay local (CI covered by unit tests) ([003c060](https://github.com/SIRTHEO/claude-switch/commit/003c060c3e549f4d93561f38d4e59a9bb332060c))
* **plans:** close 2.1 — release-please config audit (no-op) ([5a8c451](https://github.com/SIRTHEO/claude-switch/commit/5a8c45106a0408df36c286a09c1b481b21fb349d))
* **plans:** close 2.4 (badges no-op) + 2.6 (SLSA verified) ([699c3d0](https://github.com/SIRTHEO/claude-switch/commit/699c3d00e3adbcb4cc8326190a6f4581782d0f24))
* **plans:** close 2.5 + 3b.2 (help text already lists profile commands) ([6fd2252](https://github.com/SIRTHEO/claude-switch/commit/6fd2252457e2c4ffeda903980bf934df309a642f))
* **plans:** close 2.7 — predicted next release 2.7.0 (minor, 2 feat) ([88350c2](https://github.com/SIRTHEO/claude-switch/commit/88350c2c7094df468bd17c2bff125777dac20cae))
* **plans:** close 4.2 — all fallback modules at 100% line coverage ([3eadf0a](https://github.com/SIRTHEO/claude-switch/commit/3eadf0a7f8531c3c1bd4497d8167c3f1fab656fe))
* **plans:** mark 0.2/0.3/1.2 complete; record split decision ([c537760](https://github.com/SIRTHEO/claude-switch/commit/c537760a732c0505d68ed6ebb5efc61e14a3be68))
* **plans:** mark 3a.4 complete [0363150] ([4d9623e](https://github.com/SIRTHEO/claude-switch/commit/4d9623eae75e217f96927d404e94d542497ddc74))
* **plans:** mark 6.4 complete — PR[#7](https://github.com/SIRTHEO/claude-switch/issues/7) opened ([db5d4e8](https://github.com/SIRTHEO/claude-switch/commit/db5d4e8317cff9ed8bfb125dece1225e4f4584d0))
* **plans:** mark 6.5 complete — 2.7.0 published to npm ([7325c63](https://github.com/SIRTHEO/claude-switch/commit/7325c63625472f8b58fcd6fcfe44b146103444e8))
* **plans:** mark 7.6 complete — 2.8.0 published to npm ([9a430a2](https://github.com/SIRTHEO/claude-switch/commit/9a430a27aeba28369220ad6c2f4135364c103551))
* **profiles:** concurrency behaviour analysis + Plans.md cleanup (3a.5) ([d258a1d](https://github.com/SIRTHEO/claude-switch/commit/d258a1d9f3485057fc52730b48e6e33c4508d047))
* **profiles:** Linux behaviour spike — no Keychain, tokens in .claude.json (3a.4) ([0363150](https://github.com/SIRTHEO/claude-switch/commit/0363150d20c014b1ccc37f8082af5ee4cf51fe9e))
* **profiles:** MCP sub-process env inheritance — closed by static analysis (3a.6) ([dcdae17](https://github.com/SIRTHEO/claude-switch/commit/dcdae174c8a59791756b1acf0c1b6f249360883f))
* **profiles:** non-interactive macOS smoke report (3a.1a/3a.2/3a.3) ([87b3966](https://github.com/SIRTHEO/claude-switch/commit/87b3966b8384e98fafdd7c309c5c7fa49660f82a))
* **readme:** add Profiles section + rewrite multi-terminal FAQ (6.1, 6.2) ([42c8122](https://github.com/SIRTHEO/claude-switch/commit/42c81223d5e74716b765f5b0b416348e91bb8eb7))
* **readme:** inline TOC + Profiles bullet + What's-new freshness (2.3) ([a07a72b](https://github.com/SIRTHEO/claude-switch/commit/a07a72bb3554662f97c064eae323958befc60660))
* **readme:** keyboard shortcuts cheatsheet (5.6) ([f7f80ec](https://github.com/SIRTHEO/claude-switch/commit/f7f80ecc03f94cb9c0a641b5fbe3a9f823ca45b3))
* rewrite README - auto-setup flow, no em dashes ([174f1e8](https://github.com/SIRTHEO/claude-switch/commit/174f1e8c51068b34a6154355b438f881e1b09c13))
* rewrite README — wrapper-first framing, FAQ for AI search, kid-simple install ([82268c3](https://github.com/SIRTHEO/claude-switch/commit/82268c3bf2ecf29e5d6c3bab0bbd288952f77c75))
* rewrite README for Node.js cross-platform release ([5f6b898](https://github.com/SIRTHEO/claude-switch/commit/5f6b898048441b6e33a4294bab9abdf3158957cf))
* rewrite README for v2.3.0 with TUI, statusline, and usage monitoring ([1581144](https://github.com/SIRTHEO/claude-switch/commit/1581144f7adc99b787bcf371ed9858a1ffc5abbc))
* rewrite README with accurate auth flow and setup guide ([412f7e1](https://github.com/SIRTHEO/claude-switch/commit/412f7e1b3b58f36a27455fcc7c2d4dbced5eead5))
* rewrite README with cleaner structure and quick start guide ([c25e3af](https://github.com/SIRTHEO/claude-switch/commit/c25e3afd3d9ef48f2b964c8a2156da594b506236))
* SEO-tune README and package.json for npm/Google discoverability ([868b792](https://github.com/SIRTHEO/claude-switch/commit/868b792795ba306f7cb39ea292d478f9d37704e2))
* **seo:** keyword-optimize README headings and npm keywords ([9b3b84f](https://github.com/SIRTHEO/claude-switch/commit/9b3b84f5a89a438fcb6c924894118949c8ee998c))
* **tui:** static audit of main-menu.ts + sub-screens (5.1) ([a19b276](https://github.com/SIRTHEO/claude-switch/commit/a19b276ec823728d8ddc1e2dde5b4d8806a81b24))
* update README for smart add-account flow ([7ae948b](https://github.com/SIRTHEO/claude-switch/commit/7ae948b1d418026e5e319712d4a46c68d541617b))
* update README with aliases, --as, token health, VS Code; bump to v2.1.0 ([77bc698](https://github.com/SIRTHEO/claude-switch/commit/77bc698a1ad5712929c989c89ff09886d5d8a6b8))
* update README with v2.2.0 fix notice and new commands ([f36c39a](https://github.com/SIRTHEO/claude-switch/commit/f36c39a62539afa4c980f8142b77f60931a5d105))

## [2.8.0](https://github.com/SIRTHEO/claude-switch/compare/v2.7.0...v2.8.0) (2026-05-04)


### Features

* **profiles:** one-step 'open account isolated' from menu ([0458801](https://github.com/SIRTHEO/claude-switch/commit/045880194518a2f56bdf353bd2339d740f152857))
* **update:** auto-update in background on passthrough ([52cf892](https://github.com/SIRTHEO/claude-switch/commit/52cf89263240141443158854190e20f17dc6651f))


### Documentation

* focus README on claude switch first + auto-update banner ([0a30793](https://github.com/SIRTHEO/claude-switch/commit/0a307938a72b1041a07e75b71877724df18f3509))
* **plans:** add Phase 7 tasks for 2.8.0 (auto-update + one-step isolation) ([d1dd8c9](https://github.com/SIRTHEO/claude-switch/commit/d1dd8c9ee7a7662283b8570a5ff03715837ee123))
* **plans:** mark 6.5 complete — 2.7.0 published to npm ([7325c63](https://github.com/SIRTHEO/claude-switch/commit/7325c63625472f8b58fcd6fcfe44b146103444e8))

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
