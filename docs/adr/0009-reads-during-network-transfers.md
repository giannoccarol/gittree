# ADR-0009 — Let repository reads proceed during network transfers

- Status: proposed
- Date: 2026-10

## Context

ADR-0001 serializes every async `GitService` method through one queue per
common Git directory. Network commands therefore hold the queue for their whole
transfer: while a fetch, pull or push runs, the 2 s working-tree poll, the
graph, branch metadata and diffs all wait, and the repository shows as loading.
Before the remote transport existed, a stalled remote held the queue forever.

The Repository session now sends its adapter's network commands (`fetch`,
`pull`, `push`, `ls-remote`, also through `raw`) through the remote transport
(`src/main/git/remote-transport.mts`), which bounds that wait. Each one runs
with `GIT_TERMINAL_PROMPT=0` and an inactivity timeout
(`gittree.networkTimeout`, default 300 s, `0` disables it). Submodule
initialization and update stay outside it: `GIT_ALLOW_PROTOCOL=file` limits
them to local `file://` URLs, so they cannot stall on a remote. Git prints
nothing while a transfer is healthy unless `--progress` is requested, so the
default has to be long enough for a large silent fetch. The repository can
still look busy for up to five minutes when the remote is unreachable, and the
renderer's auto-fetch runs repositories one after another, so one stalled
remote also delays auto-fetch for the others.

Not every network command needs the whole queue:

- `fetch`, `fetchBranch` and the pull-request fetch write only
  `refs/remotes/*`, `refs/tags/*` (with `--tags`), `FETCH_HEAD` and new pack
  files. Git updates each ref through a lockfile and an atomic rename and
  writes packs before their index, so a concurrent reader sees either the old
  or the new value of a ref, never a torn one. Fetch never touches the index or
  the working tree, so Working tree snapshots stay valid.
- `push`, `pushTags`, `deleteRemoteBranch` and `deleteRemoteTag` read local
  objects and update a remote-tracking ref only after the remote accepts.
- `pull` runs a fetch followed by a merge or rebase that rewrites `HEAD`, the
  index and the working tree. That phase must stay exclusive.
- A ref mutation (branch or tag create/delete, `fetch --prune`) that runs
  during a fetch can fail on `packed-refs.lock` or a ref lock. Git reports the
  failure and does not corrupt the repository, but the user sees an error.

Letting reads run during a transfer therefore breaks the ADR-0001 decision
("every async method runs serialized") and its consequence ("mutating and
reading operations are strictly serialized"). That is a contract change, so it
is recorded here and not implemented together with the timeout.

## Decision (proposed)

Replace the single exclusive lane with three explicit access modes on
`RepositoryQueue`, keyed by the same common Git directory:

1. **Exclusive** — today's behavior and the default: every mutation, `pull`,
   merge, rebase, cherry-pick, checkout, stash, conflict resolution and every
   method not yet classified.
2. **Transfer** — `fetch`, `fetchBranch`, the pull-request fetch, `push`,
   `pushTags`, `deleteRemoteBranch` and `deleteRemoteTag`. At most one transfer
   runs at a time; it waits for exclusive work and blocks new exclusive work.
3. **Read** — status, working tree snapshot, log and graph pages, refs, branch
   metadata, diffs, blame, tags, stashes, worktrees and the operation state.
   Reads run concurrently with each other and with a transfer and wait only for
   exclusive work.

`bindMethodsToQueue` would read an explicit method table instead of wrapping
every async method as exclusive. `AsyncLocalStorage` would record the current
mode, so a nested call runs inline when the held mode covers it and an upgrade
(a read calling an exclusive method) fails in tests instead of deadlocking.

Implementation steps, each its own checkpoint:

1. Characterization tests that a read completes while a fake transfer is
   stalled and that a mutation still waits for it.
2. The three-mode queue with the existing exclusive behavior as default.
3. Classification of the transfer and read methods, with a contract test that
   every `GitService` async method appears in the table.
4. Renderer: run auto-fetch per repository in parallel instead of one after
   another.

## Consequences

- During a fetch or push the graph, branches, status and diffs stay live; the
  user still cannot commit, check out or merge until the transfer ends.
- The default network timeout could then become shorter, because a long
  transfer would no longer freeze the repository view.
- Reads during a fetch can briefly mix refs from before and after the fetch;
  the refresh that follows every remote operation corrects them.
- `pull` keeps blocking reads for its whole duration unless it is split into a
  transfer phase and an exclusive merge phase, which would change how GitTree
  honors `pull.rebase` and `pull.ff`; that needs its own decision.
- Related limitation: the timeout stops only the Git process GitTree started.
  `git pull` runs an inner `git fetch` that Git does not stop with it, so after
  a pull timeout that fetch keeps retrying until its connection fails. Stopping
  the whole process tree would need a transport that spawns Git in its own
  process group (or uses `taskkill /T` on Windows), which simple-git does not
  offer.
