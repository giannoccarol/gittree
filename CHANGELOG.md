# [0.23.0](https://github.com/giannoccarol/gittree/compare/v0.22.3...v0.23.0) (2026-08-25)


### Features

* **merge:** redesign merge and conflict workflow with navigation and IDE refresh ([207ecd8](https://github.com/giannoccarol/gittree/commit/207ecd8333927adc4688a7b1139bcc1734f0ecf2))

## [0.22.3](https://github.com/giannoccarol/gittree/compare/v0.22.2...v0.22.3) (2026-08-23)


### Bug Fixes

* **git-service:** handle null branch argument in pull method and add test for tracked upstream branch pull ([2604130](https://github.com/giannoccarol/gittree/commit/2604130d38263696037b0b90448b7779f936120d))

## [0.22.2](https://github.com/giannoccarol/gittree/compare/v0.22.1...v0.22.2) (2026-08-23)


### Bug Fixes

* restore CommonJS preload and verbatim i18n for sandboxed renderer ([6eea4cb](https://github.com/giannoccarol/gittree/commit/6eea4cb79639966f15f01929e09f768e7d4d619e))

## [0.22.1](https://github.com/giannoccarol/gittree/compare/v0.22.0...v0.22.1) (2026-08-23)


### Bug Fixes

* **release:** compile TypeScript and package the compiled output ([34d6cd7](https://github.com/giannoccarol/gittree/commit/34d6cd75121a8f12f1c0dc8f5473e98039ef9067))

# [0.22.0](https://github.com/giannoccarol/gittree/compare/v0.21.4...v0.22.0) (2026-08-23)


### Bug Fixes

* **git:** handle localized merge-tree output and detect merge conflicts reliably ([b5d8e5d](https://github.com/giannoccarol/gittree/commit/b5d8e5da7c4b8fef0172b3404eedf63ac189ba0e))
* **types:** resolve agent service strict errors and add build tsconfig ([c6dadad](https://github.com/giannoccarol/gittree/commit/c6dadad400f618e807fa287f529a71e7f5aaf6b7))


### Features

* **shared:** add typed GitTreeBridge contract (M5) ([01b317e](https://github.com/giannoccarol/gittree/commit/01b317e7c384ce4c3b8675ef4d906fdbb81c6194))
* **shared:** add typed IPC contracts and convert pure leaves (M2) ([151a030](https://github.com/giannoccarol/gittree/commit/151a030f84724c8ac9be3242bfc9932d6b3db950))

## [0.21.4](https://github.com/giannoccarol/gittree/compare/v0.21.3...v0.21.4) (2026-08-20)


### Performance Improvements

* **renderer:** bound large workspace memory usage ([4d7d8e7](https://github.com/giannoccarol/gittree/commit/4d7d8e70fe5f38e081fede1810411467c47d0212))

## [0.21.3](https://github.com/giannoccarol/gittree/compare/v0.21.2...v0.21.3) (2026-08-20)


### Bug Fixes

* **graph:** preserve history connectors across rows ([c5dc6be](https://github.com/giannoccarol/gittree/commit/c5dc6be7e6e1db28887c19cf2a648f6aca2539ff))

## [0.21.2](https://github.com/giannoccarol/gittree/compare/v0.21.1...v0.21.2) (2026-08-20)

## [0.21.1](https://github.com/giannoccarol/gittree/compare/v0.21.0...v0.21.1) (2026-08-20)


### Bug Fixes

* **release:** install bsdtar for Pacman packaging ([6a9dfec](https://github.com/giannoccarol/gittree/commit/6a9dfeca74ad30570f34f55261af1660f7930ec5))

# [0.21.0](https://github.com/giannoccarol/gittree/compare/v0.20.4...v0.21.0) (2026-08-20)


### Features

* **packaging:** publish native Arch Pacman packages ([33d9bc0](https://github.com/giannoccarol/gittree/commit/33d9bc095fa4bdd8d0df51e5a03ae2168ed23609))

## [0.20.4](https://github.com/giannoccarol/gittree/compare/v0.20.3...v0.20.4) (2026-08-19)


### Bug Fixes

* **agents:** buffer terminal output until the terminal is attached ([762f66e](https://github.com/giannoccarol/gittree/commit/762f66e6a6d1523a2502572942d7a43e615eb42c))

## [0.20.3](https://github.com/giannoccarol/gittree/compare/v0.20.2...v0.20.3) (2026-08-18)


### Bug Fixes

* **tabs:** keep the app's custom scrollbar look on a much slimmer tab strip ([01d73e1](https://github.com/giannoccarol/gittree/commit/01d73e1bc2c2a19d22bee4454f13b0ba11559bd2))

## [0.20.2](https://github.com/giannoccarol/gittree/compare/v0.20.1...v0.20.2) (2026-08-18)


### Bug Fixes

* **tabs:** slim tab-strip scrollbar that no longer shifts tabs and remove hover lift ([ab11bb9](https://github.com/giannoccarol/gittree/commit/ab11bb9527018f1f50c9421765c7f396dbb5262a))

# [0.20.0](https://github.com/giannoccarol/gittree/compare/v0.19.0...v0.20.0) (2026-08-13)


### Features

* **ai:** blame-based file history narration ([a2dbfaa](https://github.com/giannoccarol/gittree/commit/a2dbfaa7baf4c24253e7c0e0cf6de79370d6e02b))
* **ai:** semantic history search with AI ([4ec3df7](https://github.com/giannoccarol/gittree/commit/4ec3df7aa87232e466f708444489aaa59b613adf))

# [0.19.0](https://github.com/giannoccarol/gittree/compare/v0.18.0...v0.19.0) (2026-08-13)


### Features

* **ai:** explain commits from the history context menu ([c268555](https://github.com/giannoccarol/gittree/commit/c2685554787fdf18de75040724530df7a7f6b3c2))

# [0.18.0](https://github.com/giannoccarol/gittree/compare/v0.17.0...v0.18.0) (2026-08-13)


### Features

* **pull-requests:** one-click AI-assisted PR draft ([6650af4](https://github.com/giannoccarol/gittree/commit/6650af4fc83db4ab1db89d7e315e53f5533e369d))

# [0.17.0](https://github.com/giannoccarol/gittree/compare/v0.16.0...v0.17.0) (2026-08-13)


### Features

* **agents:** prefill conflict prompt into agent sessions ([ee568a9](https://github.com/giannoccarol/gittree/commit/ee568a9e6dd936c4d583ac809cbc3931f0905c3c))
* **ai:** explain merge conflict blocks with AI ([fc69972](https://github.com/giannoccarol/gittree/commit/fc6997235e559644ee02ce9fcae0bfcfb0b8f1e6))

# [0.16.0](https://github.com/giannoccarol/gittree/compare/v0.15.1...v0.16.0) (2026-08-13)


### Features

* **ai:** explain working tree changes with AI ([acb6bca](https://github.com/giannoccarol/gittree/commit/acb6bca5ff665439aa42755801fd39c80b4f862f))

## [0.15.1](https://github.com/giannoccarol/gittree/compare/v0.15.0...v0.15.1) (2026-08-13)


### Performance Improvements

* **quality:** scope local quality and benchmarks to touched areas ([872edf0](https://github.com/giannoccarol/gittree/commit/872edf078ac1ab6b2fdc30bb8ea52f721a3b8754))

# [0.15.0](https://github.com/giannoccarol/gittree/compare/v0.14.1...v0.15.0) (2026-08-13)


### Features

* **ai:** generate commit messages from unstaged changes too ([44ec744](https://github.com/giannoccarol/gittree/commit/44ec74401e876046b83723d0d3d3e8a8ff09f304))

## [0.14.1](https://github.com/giannoccarol/gittree/compare/v0.14.0...v0.14.1) (2026-08-13)


### Bug Fixes

* **ai:** run opencode through a PTY and allow a model override ([39b4db6](https://github.com/giannoccarol/gittree/commit/39b4db661f3983f4b899b98c0c795a347fb63c8c))

# [0.14.0](https://github.com/giannoccarol/gittree/compare/v0.13.5...v0.14.0) (2026-08-13)


### Features

* **ai:** generate commit messages and PR descriptions locally ([f6b2605](https://github.com/giannoccarol/gittree/commit/f6b260569b7f57b8158b4e3259376945a3b8a988))

## [0.13.5](https://github.com/giannoccarol/gittree/compare/v0.13.4...v0.13.5) (2026-08-13)


### Bug Fixes

* **changes:** rebuild the file lists with a correct windowed renderer ([5f3780a](https://github.com/giannoccarol/gittree/commit/5f3780aaa552da057d9cc7dbf66119f14aea7a71))
* **perf:** open every modal instantly and hydrate slow data after ([380dc5d](https://github.com/giannoccarol/gittree/commit/380dc5d3fb76dc51c6679f25ddd9c8ff7eb608a2))
* **resize:** keep branch content visible while resizing panels ([12e3904](https://github.com/giannoccarol/gittree/commit/12e39046dcf73fcea7fd08cdbb979f8c75e7cb52))

## [0.13.4](https://github.com/giannoccarol/gittree/compare/v0.13.3...v0.13.4) (2026-08-13)


### Bug Fixes

* **modals:** resizable dialogs over a translucent backdrop ([687e6c0](https://github.com/giannoccarol/gittree/commit/687e6c01ec484f6b976d004f2bbfe689091e68cf))

## [0.13.3](https://github.com/giannoccarol/gittree/compare/v0.13.2...v0.13.3) (2026-08-13)


### Bug Fixes

* **settings:** render update state from check result and act on it ([2c9b910](https://github.com/giannoccarol/gittree/commit/2c9b91001c01c1a59b0e23321c05c00d7f565480))

## [0.13.2](https://github.com/giannoccarol/gittree/compare/v0.13.1...v0.13.2) (2026-08-13)


### Bug Fixes

* **pull-requests:** auto-fill Azure PR title, commits and work items ([a33fa4e](https://github.com/giannoccarol/gittree/commit/a33fa4e55782fcadea42b23bcbf912cdbf6272fc))

## [0.13.1](https://github.com/giannoccarol/gittree/compare/v0.13.0...v0.13.1) (2026-08-13)


### Bug Fixes

* stabilize cherry-pick and graph rendering ([b043830](https://github.com/giannoccarol/gittree/commit/b043830a71f397bf8e885bc2783ff3e5335ec4fb))

# [0.13.0](https://github.com/giannoccarol/gittree/compare/v0.12.0...v0.13.0) (2026-08-12)


### Features

* reorder and pin repository tabs ([07d72b7](https://github.com/giannoccarol/gittree/commit/07d72b7ed54fb1a49a205e0458e6bf6adf8bc2db))

# [0.12.0](https://github.com/giannoccarol/gittree/compare/v0.11.2...v0.12.0) (2026-08-12)


### Features

* redesign inspector workspace ([c99cb75](https://github.com/giannoccarol/gittree/commit/c99cb75a63d3bcc51315f43cbac4efad58747005))

## [0.11.2](https://github.com/giannoccarol/gittree/compare/v0.11.1...v0.11.2) (2026-08-12)


### Bug Fixes

* allow cloning repositories from tabs ([f786fac](https://github.com/giannoccarol/gittree/commit/f786facb564e06a7ef8e1506fcbc4ac061514e49))

## [0.11.1](https://github.com/giannoccarol/gittree/compare/v0.11.0...v0.11.1) (2026-08-12)


### Bug Fixes

* detect Windows agent CLI installations ([d4420c2](https://github.com/giannoccarol/gittree/commit/d4420c2663a99d6d28257f1d8d2309411d4e8f1c))

# [0.11.0](https://github.com/giannoccarol/gittree/compare/v0.10.0...v0.11.0) (2026-08-11)


### Bug Fixes

* preserve history viewport after remote actions ([1c966ff](https://github.com/giannoccarol/gittree/commit/1c966ffcaf152f900638668f334c042bbad074da))


### Features

* redesign settings and commit inspector ([5cb764e](https://github.com/giannoccarol/gittree/commit/5cb764ee273400dbb1c92fad9fe3aa66700b4aa9))

# [0.10.0](https://github.com/giannoccarol/gittree/compare/v0.9.19...v0.10.0) (2026-08-11)


### Features

* add worktree agent sessions control center ([24333e0](https://github.com/giannoccarol/gittree/commit/24333e0e127849c257a12ff5cfbae28e50f44e1f))

## [0.9.19](https://github.com/giannoccarol/gittree/compare/v0.9.18...v0.9.19) (2026-08-11)

## [0.9.18](https://github.com/giannoccarol/gittree/compare/v0.9.17...v0.9.18) (2026-08-11)

## [0.9.17](https://github.com/giannoccarol/gittree/compare/v0.9.16...v0.9.17) (2026-08-11)

## [0.9.16](https://github.com/giannoccarol/gittree/compare/v0.9.15...v0.9.16) (2026-08-11)


### Performance Improvements

* **renderer:** avoid permanent graph row layers ([fdc0761](https://github.com/giannoccarol/gittree/commit/fdc076154f27be5fd7f17aa1422a7cbfcb98499c))

## [0.9.15](https://github.com/giannoccarol/gittree/compare/v0.9.14...v0.9.15) (2026-08-11)


### Bug Fixes

* **release:** declare Linux audio dependency ([937efc9](https://github.com/giannoccarol/gittree/commit/937efc9ada06eedbaeb3b262387bc22217981a71))
* **renderer:** preserve workspace when sidebar closes ([8a3d012](https://github.com/giannoccarol/gittree/commit/8a3d0124926ec4d1b9913035d2d58d499b07f5c9))

## [0.9.14](https://github.com/giannoccarol/gittree/compare/v0.9.13...v0.9.14) (2026-08-11)


### Bug Fixes

* **workspace:** canonicalize repository aliases ([5eba8b3](https://github.com/giannoccarol/gittree/commit/5eba8b3686ffc12709e41df0b47640317693fd10))

## [0.9.13](https://github.com/giannoccarol/gittree/compare/v0.9.12...v0.9.13) (2026-08-11)


### Bug Fixes

* **ci:** make repository fixtures platform portable ([cb8b730](https://github.com/giannoccarol/gittree/commit/cb8b7303f5a4d98b9c7a8a87d9b807e9cc5ccb2a))

## [0.9.12](https://github.com/lorenzogit98/gittree/compare/v0.9.11...v0.9.12) (2026-08-11)


### Bug Fixes

* **renderer:** simplify the welcome workspace ([c403f86](https://github.com/lorenzogit98/gittree/commit/c403f866f509c3d225b5027e356626b586c09d0d))
* **workspace:** restore repositories after package rename ([156b4d7](https://github.com/lorenzogit98/gittree/commit/156b4d7508a3cfca2ad0342be32c7b22d499e0e4))

## [0.9.11](https://github.com/lorenzogit98/gittree/compare/v0.9.10...v0.9.11) (2026-08-11)

## [0.9.10](https://github.com/lorenzogit98/gittree/compare/v0.9.9...v0.9.10) (2026-08-11)


### Bug Fixes

* **security:** centralize repository workspace admission ([9aa8043](https://github.com/lorenzogit98/gittree/commit/9aa8043f09900b3c86557c5f117b524c5490c710))

## [0.9.9](https://github.com/lorenzogit98/gittree/compare/v0.9.8...v0.9.9) (2026-08-11)

## [0.9.8](https://github.com/lorenzogit98/gittree-minimal/compare/v0.9.7...v0.9.8) (2026-08-02)

## [0.9.7](https://github.com/lorenzogit98/gittree-minimal/compare/v0.9.6...v0.9.7) (2026-08-02)

## [0.9.6](https://github.com/lorenzogit98/gittree-minimal/compare/v0.9.5...v0.9.6) (2026-08-02)

## [0.9.5](https://github.com/lorenzogit98/gittree-minimal/compare/v0.9.4...v0.9.5) (2026-08-02)

## [0.9.4](https://github.com/lorenzogit98/gittree-minimal/compare/v0.9.3...v0.9.4) (2026-08-02)


### Performance Improvements

* **renderer:** resize workspace panels in realtime ([5894cfe](https://github.com/lorenzogit98/gittree-minimal/commit/5894cfe5028db381fa57826ea60101d29c626714))

## [0.9.3](https://github.com/lorenzogit98/gittree-minimal/compare/v0.9.2...v0.9.3) (2026-08-02)


### Bug Fixes

* accept Windows short paths for repository deep links ([3b421e3](https://github.com/lorenzogit98/gittree-minimal/commit/3b421e37f19b2ad8cc0f1282bbc1f311cd0471ce))

## [0.9.2](https://github.com/lorenzogit98/gittree-minimal/compare/v0.9.1...v0.9.2) (2026-08-02)


### Bug Fixes

* canonicalize repository paths before top-level comparison ([b4916d8](https://github.com/lorenzogit98/gittree-minimal/commit/b4916d8f1ab921d2356328a1fd96bca0d990c8c8))

## [0.9.1](https://github.com/lorenzogit98/gittree-minimal/compare/v0.9.0...v0.9.1) (2026-08-02)


### Performance Improvements

* **renderer:** benchmark panel motion without grid animation assumption ([6619d11](https://github.com/lorenzogit98/gittree-minimal/commit/6619d1149450c0af4e95da87b786ac00246ed23d))

# [0.9.0](https://github.com/lorenzogit98/gittree-minimal/compare/v0.8.3...v0.9.0) (2026-08-02)


### Features

* **renderer:** workspace panel motion with motion-preserving reload ([29aafb9](https://github.com/lorenzogit98/gittree-minimal/commit/29aafb9ab7f150f00fe1cac66948f06a70ba09d9))

## [0.8.3](https://github.com/lorenzogit98/gittree-minimal/compare/v0.8.2...v0.8.3) (2026-08-02)


### Performance Improvements

* **renderer:** accelerate distant history jumps ([5aff6eb](https://github.com/lorenzogit98/gittree-minimal/commit/5aff6eb55017eefc6e98534ab3efc6b11a05dd44))
* **renderer:** deduplicate repository activation reads ([09ddd83](https://github.com/lorenzogit98/gittree-minimal/commit/09ddd8345f8a6de4295a92c7321f85b52520c347))
* **renderer:** keep remote operations visually continuous ([0b4f443](https://github.com/lorenzogit98/gittree-minimal/commit/0b4f4437efb90bb8d00ffa7cbdc5963fe1d43e6e))
* **renderer:** make repository switches interactive sooner ([ab65131](https://github.com/lorenzogit98/gittree-minimal/commit/ab65131a761c1513ee03a5dcd72614f5cadd35f4))
* **renderer:** reuse visible rows and profile process memory ([6c11f9c](https://github.com/lorenzogit98/gittree-minimal/commit/6c11f9c9735d8850b808167eeaf732ccb241114d))

## [0.8.2](https://github.com/lorenzogit98/gittree-minimal/compare/v0.8.1...v0.8.2) (2026-08-02)


### Performance Improvements

* **renderer:** reuse graph rows during scrolling ([caeb4e0](https://github.com/lorenzogit98/gittree-minimal/commit/caeb4e083c431f3b7beaaa9ba32e0baf13bcc948))

## [0.8.1](https://github.com/lorenzogit98/gittree-minimal/compare/v0.8.0...v0.8.1) (2026-08-02)
