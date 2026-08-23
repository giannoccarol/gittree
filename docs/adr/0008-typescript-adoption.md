# ADR-0008 — Incremental TypeScript adoption with targeted architecture cleanup

- Status: accepted
- Date: 2026-08

## Context

GitTree's stack is deliberately vanilla: JavaScript, CommonJS, Electron, native
DOM, no bundler and no TypeScript. That rule protected the project while the
architecture stabilized. The codebase now has ~25,400 lines across ~94 source
files, a stable service layer (`GitService`, `HostingService`), domain-grouped
IPC registration and a dense characterization test suite (~90 files,
`node --test`, contract tests for IPC parity and the preload bridge).

The remaining risk is not structure but contracts: IPC envelopes `{ error }`,
channel names, `window.gitTree` bridge methods and domain states (operation
state, working-tree snapshots, conflicts) are conventions guarded only at
runtime. Four concrete weaknesses also remain:

1. `GitService` wraps all its async methods through prototype monkey-patching
   (`git-service.js:1213-1221`) — a hidden queue invariant that cannot be
   typed or statically verified.
2. `app.js` is a 935-line god-object whose state and event emitter are reached
   into by components (`app.state`, `app.emit`).
3. Main-to-renderer pushes are scattered raw `webContents.send` calls across
   four files; renderer components poll on timers.
4. The largest renderer files (`settings-view.js` 1328 lines, `i18n.js`
   1677 lines) mix responsibilities; domain data travels as ad-hoc plain
   objects with no shared model layer.

TypeScript would move these contracts to compile time, but adopting it is a
product decision that overrides the vanilla-stack rule, so it must be recorded
here together with the boundaries it will protect.

## Decision

We adopt TypeScript incrementally, file by file, behind the existing test
suite, per the roadmap in `docs/typescript-migration-plan.md`. The decision
points:

- **D1 — Toolchain**: `tsc` only. No bundler, no alternative transpiler. The
  "no bundler" invariant survives: TypeScript is a typechecker first and a
  transpiler second, emitting one output file per source file.
- **D2 — Module system**: converted main-process and shared modules use ES module syntax
  with the `.mts` extension. Node's native type stripping executes them directly during the
  migration (verified on Electron 43 / Node 24.18), `require(esm)` interop lets the
  not-yet-converted CommonJS modules import them synchronously, and tsc emits `.mjs` at the
  packaging flip. Unconverted modules remain CommonJS until their own conversion. The
  original "main stays CommonJS" choice was revised after spike evidence showed tsc cannot
  type CommonJS-style exports in `.ts` modules without non-erasable syntax.
- **D3 — Renderer modules**: renderer becomes native ES modules loaded via
  `<script type="module">`, emitted per-file by tsc. This replaces the dual
  `/* exported */` + `module.exports` pattern and is the only structural
  loading change of the migration.
- **D4 — Strictness**: every converted file lands with `strict: true`; until
  conversion completes, a CI ratchet forbids the total TypeScript error count
  from rising.
- **D5 — Test execution**: tests run on sources via Node type stripping where
  available and on compiled `dist/` output in CI. If stripping proves
  unstable, tests always run on `dist/`.
- **D6 — Shared contracts**: `src/shared/` is the single home for IPC channel
  names, the `{ error }` envelope type, the `GitTreeBridge` interface and the
  domain models used by main, preload and renderer.

The migration preserves every public behavior: IPC channels, envelopes,
storage keys, keyboard behavior and persisted formats do not change. The
`{ error }` envelope shape is typed as a discriminated union but its runtime
form is frozen; changing it requires a new ADR.

Together with the typing work, seven targeted architecture cleanups are
approved (catalog and scheduling in the migration plan):

- **A1** — Replace the `GitService.prototype` monkey-patching with explicit
  queue wrapping at construction, characterized by tests before the change.
- **A2** — Decompose `app.js` into collaborators (`ToastService`, `StashView`,
  window-chrome and toolbar controllers) following the component lifecycle
  rules already in AGENTS.md; `app.js` remains the composition root.
- **A3** — Formalize event flow: a minimal typed event bus in the renderer
  replacing direct `app.emit`/`app.state` reach-ins, and a single
  `RendererNotificationsPort` in the main process consolidating all
  `webContents.send` push channels.
- **A4** — Componentize `settings-view.js` into section sub-components.
- **A5** — Split `i18n.js` into a pure resources module and a small loader
  with typed keys; `i18n-parity` remains the runtime guard.
- **A6** — Event-driven refresh instead of polling (backlog, post-migration).
- **A7** — Type the `{ error }` envelope without altering it.
- **A8** — Introduce `src/shared/models/`: pure typed domain entities
  (`CommitSummary`, `Branch`, `Ref`, `WorktreeSnapshot`, `OperationState`,
  `PullRequest`, `RepositoryEntry`, `ConflictFile`), each with a
  `parse(unknown)` normalizer so IPC input validation (ADR-0004) and types
  are the same mechanism. Types and guards only — no ORM, no schema library.

Sequencing rule: domains that get restructured are refactored before they are
typed; stable shared contracts are typed before anything else. Architectural
cleanup and `.js`→`.ts` conversion never share a commit.

Explicitly out of scope: dependency-injection frameworks, state-management
libraries, reactive frameworks, and replacing any existing pattern (facades,
adapter registries, session/queue) that already fits.

## Consequences

- AGENTS.md, `CONTEXT.md` and the gittree skills must be updated during M0:
  the blanket "no TypeScript" rule becomes "no new JavaScript in converted
  directories".
- Every milestone keeps `npm run quality:full` green; the packaging flip to
  `dist/` (M7) must follow a stable release because it is the least trivially
  revertible step.
- Build gains a deterministic tsc step; CI gains a typecheck gate with an
  error-count ratchet and a no-new-JS check for converted directories.
- Coverage scopes and c8 globs need recalibration when sources emit to
  `dist/`.
- The typed event bus and notification port add two small seams; both replace
  implicit coupling that exists today, so net complexity decreases.
- Rollback strategy is per-milestone tags; abandoning the migration after any
  milestone leaves a working JavaScript tree plus useful shared type
  documentation.
