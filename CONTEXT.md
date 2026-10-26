# GitTree — Context

GitTree is a desktop Git client (Electron) that presents a local repository's
history as a multi-lane graph and runs **explicit, reversible git operations**.
Privacy-first: no accounts, no telemetry, no repository upload.

## Domain language

- **Main Application** — the import-safe composition root in
  `main-application.js`; it constructs services, registers IPC, owns windows and
  exposes deterministic `start()`/`stop()`. `main.js` only injects Electron and
  starts it.
- **Application runtime** — the host lifecycle and deep-link readiness policy in
  `application-runtime.js`; it owns Electron event subscriptions, not services.
- **Repository** — a git working tree registered in the workspace (the app only
  operates on registered repositories; `assertManagedRepo`).
- **Repository workspace** — the main-process capability that owns Repository
  admission, canonical identity, active/persisted entries, GitService reuse and
  queue identity. Renderer paths are admitted only after a native directory
  selection, an approved scan, clone completion or a validated deep link.
- **Repository session** — the internal Git unit that owns a normalized path,
  the `simple-git` Adapter and one per-repository queue while `GitService`
  remains the stable public Interface. The Adapter's network commands go
  through the Remote transport.
- **Repository workspace controller** — the renderer lifecycle owner for one
  Repository activation. It restores view state, gives the graph first visual
  priority, coordinates supporting reads and prevents stale tab loads from
  publishing after a newer activation.
- **Workspace state controller** — the renderer owner of history/changes/review
  modes, sidebar and inspector visibility, accessibility attributes and their
  persisted state. Motion and realtime resize remain separate collaborators.
- **Shortcut controller** — the renderer owner of platform-specific shortcut
  labels and global keyboard dispatch. It ignores editable and modal contexts
  and removes its document listener deterministically.
- **Repository history** — the read-only Git capability for log, graph, refs,
  commit comparisons and commit diff/detail queries within one Repository
  session.
- **Graph snapshot** — the history graph for one refs state, identified by a
  fingerprint of the walked refs, the HEADs of the repository's worktrees and
  the shallow boundary. Repository
  history caches its topological order and immutable commit metadata, so graph
  pages are slices instead of fresh walks; callers pass the snapshot id back to
  keep paging on one ordering and to learn whether a refresh changed anything
  (ADR-0010).
- **Repository working tree** — the Git capability that observes status,
  creates Working tree snapshots and owns safe file/hunk stage, unstage and
  discard operations.
- **Remote transport** — the Git capability that runs the Repository session
  Adapter's network commands (`fetch`, `pull`, `push`, `ls-remote`, also
  through `raw`) with `GIT_TERMINAL_PROMPT=0` and an inactivity timeout
  (`gittree.networkTimeout`, default 300 s), so a silent remote cannot hold
  the per-repo queue forever.
- **Repository operations** — the Git capability that owns the complete
  preflight, execution, conflict and recovery cycle for merge, rebase and
  cherry-pick, including operation-state detection and conflict resolution.
- **Working tree snapshot** — a content-addressed fingerprint (sha256 of branch,
  per-file status, sizes, mtimes and index state) that guards stage/unstage/
  discard operations against concurrent changes.
- **Operation state** — an in-progress merge/rebase/cherry-pick detected from
  git state files; blocks destructive actions until continued, skipped or aborted.
- **Per-repo queue** — every async git operation on a `GitService` runs
  serialized through a promise chain keyed by the common Git directory;
  linked worktrees therefore share ref serialization while unrelated
  repositories stay parallel. `AsyncLocalStorage` keeps nested calls re-entrant.
- **Conflict block** — a `<<<<<<<`/`=======`/`>>>>>>>` region parsed from a
  conflicted file for the visual resolver.
- **Hosting provider adapter** — the provider-specific Implementation of the
  normalized pull-request Interface. GitHub, GitLab and Azure endpoint details,
  payloads and fallbacks stay behind this Seam.
- **AI capability** — the main-process capability that generates commit
  messages and pull-request descriptions through a user-configured provider
  (OpenAI-compatible, Anthropic or the local OpenCode CLI). Keys live in the
  encrypted vault, requests happen only on explicit user action, prompts are
  diff-bounded and outputs are parsed from a strict `TITLE:`/`BODY:` format.

## Architecture

- **Main process** (`src/main/`) — `main.js` is a side-effect-only entry point;
  `main-application.js` is the tested composition root, `application-runtime.js`
  owns host lifecycle, and domain handlers live in `src/main/ipc/`.
  `RepositoryWorkspace` owns admission and GitService
  identity. `GitService` and `HostingService` are stable Interfaces
  over deeper internal Modules and provider Adapters.
- **Git implementation** — `git-service.js` exposes the public capability while
  `src/main/git/` owns Repository sessions, Repository history, Repository
  working tree, Repository operations and cohesive Implementations. Git
  commands use `simple-git` or `execFile` argv arrays, never a shell string.
- **Hosting implementation** — `hosting-service.js` orchestrates credentials,
  authentication, retries and normalized errors. `src/main/hosting/providers/`
  owns provider-specific pull-request behavior.
- **AI implementation** — `src/main/ai/` owns the AiService facade, provider
  adapters, prompt building, output parsing and agent environment export;
  `ai-service.js` is the stable public Interface.
- **Preload** (`src/preload.js`) — the only bridge: an explicit, whitelisted
  `window.gitTree` API. The inspector window uses a dedicated minimal preload.
- **Renderer** (`src/renderer/`) — bento workspace with components per surface
  and small controller Modules for repository loading, remote operations,
  workspace state and motion. Prefer `textContent`; when markup is required,
  use the shared HTML encoder. CSP is `default-src 'self'`.
- **IPC contract** — handlers return `{ error }` instead of rejecting with
  strings; every git/hosting/terminal handler validates the repository path
  against the registered repo set.

The contributor-facing ownership map and dependency direction live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Conventions

- Conventional Commits (`feat`/`fix`/`perf`/`refactor`/`style` bump; `feat` and
  breaking → minor on the 0.x line, the rest → patch).
- ESLint flat config, error-level rules, enforced in CI.
- Every feature ships English + Italian i18n keys (enforced by
  `test/i18n-parity.test.js`).
- Design rules live in `DESIGN.md` and are audited by `npm run audit:design`
  (opaque surfaces, semantic tokens, transform/opacity-only motion).
- Refactors start with characterization tests, move one complete capability at
  a time, and end with `npm run quality`. Each checkpoint must remain
  independently revertible.
- Decision records: `docs/adr/`.
