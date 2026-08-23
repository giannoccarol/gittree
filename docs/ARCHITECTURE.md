# GitTree architecture

GitTree runs on a TypeScript, native DOM stack with no framework and no
bundler. The goal is not to create more layers: it is to make ownership
obvious, keep public contracts stable and place volatile details behind
narrow Seams.

The TypeScript migration (ADR-0008) is complete: every module under `src/`
is strict `.mts` except the documented exception `src/renderer/i18n.js`, a
classic script that carries translation resources plus the loader. Shared
contracts live in `src/shared/`; renderer modules are emitted as ES modules
and main-process modules as CommonJS-compatible output by `tsc` into
`dist/`.

## Dependency direction

```text
Electron entry point
  -> Main Application
    -> Application runtime
    -> domain IPC registration
      -> stable service Interface
        -> internal Module or provider Adapter

Renderer entry point
  -> lifecycle and operation controllers
    -> feature views
      -> pure helpers and shared primitives

Preload whitelist
  -> named IPC channels only
```

Dependencies point inward toward stable Interfaces. An Implementation may know
its Interface; the Interface must not depend on provider payloads, Electron
globals or renderer state.

## Contributor map

| Capability | Primary owner | Verification |
| --- | --- | --- |
| Dependency composition, windows, IPC ownership and teardown | `src/main/main-application.js`; `main.js` is the minimal entry point | `test/main-application.test.js` and Electron E2E |
| Electron host lifecycle and deep-link readiness | `src/main/application-runtime.js` | `test/application-runtime.test.js` |
| IPC registration and error envelopes | `src/main/ipc/` plus `src/preload.js` | IPC handler, parity and preload contract tests |
| Repository admission, persistence, service reuse and queue identity | `src/main/repository-workspace.js` with `repo-manager.js` as storage Adapter | `test/repository-workspace.test.js`, repository IPC and RepoManager tests |
| Git public operations | `src/main/git-service.js` | `test/git-service*.test.js` with deterministic real repositories |
| Repository history, graph, refs and commit diff | `src/main/git/repository-history.js` behind `GitService` | `test/git-history-repository-contracts.test.js` and graph integration tests |
| Repository status, snapshots, file and hunk operations | `src/main/git/repository-working-tree.js` plus the pure patch parser | working-tree contracts, integration tests and hardening tests |
| Merge, rebase, cherry-pick, conflicts and recovery | `src/main/git/repository-operations.js` behind `GitService` | `test/repository-operations-contracts.test.js` and focused Git integration tests |
| Repository path, Git Adapter and common-directory serialization | `src/main/git/repository-session.js` and `repository-queue.js` | Repository session and linked-worktree workspace tests |
| Hosting credentials, auth, retry and error policy | `src/main/hosting-service.js` and the credential vault | hosting service and IPC contract tests |
| Provider list, detail and diff behavior | `src/main/hosting/providers/` | `test/hosting-provider-adapters.test.js` and `test/hosting-provider-read-contracts.test.js` |
| AI settings, keys, prompts and provider requests | `src/main/ai/ai-service.js` with provider adapters, output parsing and agent environment export | `test/ai-service.test.js`, provider contracts and the AI performance benchmark |
| Repository activation, readiness and stale-load cancellation | `src/renderer/repository-workspace-controller.js`; `repository-load-session.js` deduplicates reads inside one activation | `test/repository-workspace-controller.test.js`, load-session tests and Electron E2E |
| Remote operation feedback | `src/renderer/remote-operation-controller.js` | `test/remote-operation-controller.test.js` and Electron E2E |
| Keyboard commands and platform-specific shortcut presentation | `src/renderer/shortcut-controller.js` | `test/shortcut-controller.test.js` and semantic Electron E2E |
| Workspace modes, panel visibility and persisted navigation state | `src/renderer/workspace-state-controller.js`; motion and resize remain separate collaborators | `test/workspace-state-controller.test.js`, motion/resize tests and renderer benchmark |
| Workspace resize and panel motion | `src/renderer/workspace-resize-controller.js`, `src/renderer/workspace-panel-motion.js` | controller tests, performance benchmarks and `docs/MOTION.md` |
| Visual rules and localization | `DESIGN.md`, renderer styles and i18n resources | design audit, i18n parity and Electron E2E |
| Packaging and release integrity | `.github/workflows/`, release scripts and electron-builder config | release contract tests and package checks |

## Stable Seams

- `window.gitTree` exposes named, whitelisted methods. Do not add a generic
  `invoke(channel, ...)` escape hatch.
- IPC handlers preserve the existing argument/result contract, return
  `{ error }`, and validate managed repositories at the boundary.
- `RepositoryWorkspace` is the only admission and GitService registry Seam.
  Native selection and scan results create narrow, one-use path capabilities;
  renderer strings alone cannot expand the workspace.
- `MainApplication` is import-safe and owns every composed resource. Its
  `stop()` removes IPC/process/Electron listeners, cancels provider sessions,
  stops updater timers and destroys owned windows.
- `GitService` is the public Interface. Every asynchronous repository operation
  continues through the same per-repository queue.
- `RepositoryOperations` owns one complete mutation cycle: preflight,
  execution, conflict state and recovery. It uses the session's Git Adapter
  and path but never creates a second queue.
- `HostingService` owns cross-provider policy. Provider Adapters own endpoint,
  payload and normalized provider behavior.
- Renderer Modules receive bridge, translation, storage and callbacks
  explicitly. Do not add new reads from `window.app`.
- `RepositoryWorkspaceController` owns one complete renderer activation: it
  restores the workspace mode, prioritizes the graph, coordinates supporting
  views, rejects obsolete load publication and exposes interactive/settled
  readiness. `GitTreeApp.openRepo()` remains the compatibility entry point.
- `WorkspaceStateController` owns workspace modes, sidebar/inspector visibility,
  accessibility state and their storage keys. It delegates animation execution
  to `WorkspacePanelMotion` and never rebuilds Repository views while panels move.
- Use `textContent` for plain data and the shared encoder only when markup is
  necessary.
- Do not introduce a framework, bundler or TypeScript.

## What makes a good Module

A Module should provide one complete capability through a small Interface. It
earns its boundary through Depth: callers get useful behavior without knowing
the volatile Implementation. Prefer high Leverage and Locality over many
one-line wrappers.

Before extracting a Module, answer these questions:

1. What complete capability does it own?
2. Which dependencies are injected, and who owns their lifecycle or teardown?
3. Can its behavior be characterized through the intended Interface?
4. Does deleting the old path break the capability, proving that there is one
   source of truth?
5. Can the checkpoint be reverted without changing public behavior or user
   data?

## Change protocol

1. Add characterization tests at the narrowest meaningful public Seam.
2. Move one behavior group without changing names, arguments or results.
3. Run the focused tests while iterating.
4. Run lint, contract tests and `npm run quality` before committing.
5. Run Electron E2E when wiring or user workflows change; run performance
   benchmarks when renderer scheduling, DOM volume or memory can change.
6. Commit an independently reviewable and revertible checkpoint.

## Current consolidation state

- The Main Application, host runtime and domain IPC registration are covered
  through a fake Electron Adapter without launching Electron.
- Hosting provider Adapters own the complete normalized pull-request capability:
  list, detail, diff, thread resolution, review submission and creation.
  `HostingService` retains validation, authenticated transport, vault ownership
  and the retry journal without exposing credentials to an Adapter.
- `GitService` remains intentionally stable. Repository history, Repository
  working tree and Repository operations are cohesive internal Modules; all
  calls continue through the existing Repository session and common-directory
  queue shared by linked worktrees.
- `GitTreeApp` is still a large renderer coordinator. New work should deepen
  existing controller Modules instead of adding more responsibilities to it.

This section is a status map, not permission for a broad rewrite. Behavior and
public Interfaces stay stable throughout the consolidation program.
