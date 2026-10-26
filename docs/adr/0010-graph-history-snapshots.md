# ADR-0010 — Graph history snapshots

- Status: accepted
- Date: 2026-10

## Context

The history graph is paged: the renderer asks for 500 commits at a time and
asks for more while the user scrolls. Each page ran
`git log --all --topo-order --date-order --skip=N`, plus `for-each-ref` and
`rev-parse HEAD`, and returned every ref again. A topological walk cannot
start in the middle, so every page paid for a full walk of the history:
about 0.45 s per page on a 60,000-commit repository without a commit-graph,
62 s to page through it, with the per-repository queue (ADR-0001) blocked for
each page. After Fetch, Pull and Push the renderer restarted from offset 0 and
requested pages one by one until the viewport anchor was loaded again, so a
refresh deep in the history cost tens of seconds and kept Changes and diffs
waiting behind the queue.

## Decision

`RepositoryHistory` owns a `GraphHistoryIndex` per repository session:

- A **snapshot** is the graph for one refs state. Its id is a fingerprint of
  every walked ref, HEAD, the HEAD of every linked worktree (which `--all`
  also walks) and the shallow boundary. Notes and the stash are not walked and
  do not change the id.
- The first page of a snapshot uses a bounded walk, as before, for a fast
  first paint. The first page past it builds the complete order once with
  `git rev-list` and checks that the refs did not move meanwhile. Later pages
  are slices of that order.
- Commit metadata is immutable for a commit id, so it is cached (bounded) and
  read with one `git log --no-walk=unsorted --stdin` call for the ids missing
  from the cache. Replace refs or a shallow change clear the cache.

`getGraphPage(repoPath, { offset, limit, snapshot? })` keeps its channel,
arguments, queue and `{ error }` envelope. The result gains `snapshot`. The
optional `snapshot` option is forwarded by the preload only when it is a
string and is validated again in main:

- With the current snapshot id, a continuation page is served from that
  snapshot, so later pages never mix two histories, and `refs` is empty
  because the caller already holds them.
- A first page with the caller's snapshot id tells it that nothing changed.
- Without a token, or with a stale one, the page reflects the current refs
  and carries them, exactly as before. A caller can detect a stale token
  because the returned id differs.

The renderer keeps the snapshot id of the history it shows. A refresh that
preserves the viewport sends it: an unchanged history keeps every row and
costs one request; a changed one is staged in 1000-commit slices up to the
viewport anchor while the old rows stay visible, then swapped in once.

## Consequences

- Paging is O(page) after one O(history) walk per refs state; the full walk is
  a single `rev-list` instead of one walk per page.
- A refresh after a fetch reads metadata only for new commits and keeps the
  queue free between short calls.
- Main memory grows with the cached order (about 41 bytes per commit in one
  string) and with up to 200,000 cached commit records.
- Callers that do not send a token, such as the repository dashboard, keep
  the previous semantics and payloads.
- Commits reachable only from `refs/notes/*` or `refs/stash` no longer appear
  as unlabeled graph rows.
