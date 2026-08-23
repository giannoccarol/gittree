---
name: gittree-vanilla-architecture
description: Design, refactor, and review GitTree's Electron main process, preload bridge, vanilla DOM renderer, services, and components for cohesive boundaries and explicit dependencies. Use when adding or extracting modules, componentizing renderer code, changing GitTreeApp, GitService, HostingService, IPC registration, lifecycle ownership, shared utilities, or evaluating maintainability without introducing a framework, bundler, or TypeScript.
---

# GitTree Vanilla Architecture

Improve structure without changing the product contract or replacing the vanilla stack.

## Establish the contract

1. Read `CONTEXT.md` and the ADRs that touch the change.
2. Identify public behavior: preload methods, IPC channels, service results, DOM events, storage keys and user-visible states.
3. Add characterization tests before moving behavior that is not already protected.
4. Name the domain responsibility being extracted. Do not create a module whose only purpose is reducing a line count.

Read [architecture-boundaries.md](references/architecture-boundaries.md) when choosing a destination module, defining a renderer component, or reviewing dependency direction.

## Preserve the vanilla stack

- Use CommonJS for main-process and test code.
- Keep renderer modules directly loadable by `index.html`. Use the repository's existing script-compatible export pattern when Node tests also need the module. During the TypeScript migration (ADR-0008), converted renderer modules become tsc-emitted ES modules loaded via `<script type="module">`.
- Do not add a framework, bundler or decorator system. TypeScript is adopted incrementally per ADR-0008 and `docs/typescript-migration-plan.md`: in converted directories new files are `.ts` with `strict` typing, never new `.js`; `.js`→`.ts` conversions never share a commit with behavior changes or architectural extractions; shared contracts and domain models live in `src/shared/`.
- Prefer platform APIs and existing dependencies. Justify every new dependency against a small local module.

## Create deep boundaries

- Keep bootstrap modules responsible for composition, lifecycle and teardown only.
- Group IPC registration by domain and validate renderer-controlled input at that seam.
- Keep `GitService` and `HostingService` as stable facades. Move cohesive implementations behind them without widening their interfaces.
- Make one module own one complete capability, including its invariants and error normalization.
- Avoid pass-through classes, generic managers, service locators and utility dumping grounds.
- Keep asynchronous Git work on the existing per-repository queue.

## Componentize the renderer

- Let `GitTreeApp` compose features; move repository lifecycle, workspace state, shortcuts, notifications and remote operations behind explicit collaborators.
- Give a component one UI responsibility and one state owner.
- For a new or extracted stateful component, prefer this lifecycle:
  - `mount(container)` creates DOM and subscribes once;
  - `update(state)` renders an explicit state without hidden global reads;
  - `destroy()` removes listeners, timers, observers and subscriptions.
- Inject a dependency object such as `{ bridge, t, storage, dialogs, onSelect }` through a constructor or factory.
- Do not add `window.app` reads. Restrict `window.gitTree` and other globals to composition roots or legacy code not yet migrated.
- Use callbacks or narrow interfaces for communication. Do not let sibling components reach into one another's DOM.
- Use `textContent` unless markup is required; then use `HtmlEncoder.encode` for untrusted values.

## Control scope

- Extract one behavior group per checkpoint.
- Keep public names, arguments, results, storage formats and keyboard behavior stable.
- Do not combine a refactor with a new Git feature or visual redesign.
- Prefer deleting duplication after equivalence tests exist.
- If the clean boundary requires a compatibility break, stop and propose an ADR before implementing it.

## Validate

Run the narrow tests for the touched domain, then:

```powershell
npm run lint
npm test
npm run test:contracts
```

For renderer UI changes, also use `gittree-design-system` and run its visual and performance gates. Finish the checkpoint with `npm run quality`.
