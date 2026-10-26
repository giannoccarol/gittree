# GitTree performance

Performance is a product requirement, not a reason to remove behavior or motion. GitTree keeps its current features, 140/220 ms interaction language, and `prefers-reduced-motion` support while reducing avoidable JavaScript, layout, paint, Git, and IPC work.

## Reproducible renderer benchmark

`npm run perf:renderer` launches its own isolated Electron application, temporary Git repository, and temporary `userData` directory through Playwright. It does not use the developer's repositories or persistent application data.

The benchmark records:

- process launch, first-window, and repository-ready time;
- Electron process working set and renderer JavaScript heap;
- initial rendering of 10,000 synthetic commits;
- virtualized DOM row count;
- synchronous viewport rendering and real animation-frame latency for both progressive scrolling and distant history jumps;
- in-place commit selection cost and DOM preservation;
- workspace and history-column resize preview cost;
- resize contracts: transform-only preview and one persisted commit on release.
- Branches and Inspector open/close trigger cost and animation-frame cadence on the 10,000-commit graph.

Run a quick local sample:

```powershell
npm run test:performance
```

Record five runs for a baseline or comparison:

```powershell
node scripts/renderer-perf-benchmark.js --runs=5 --output=performance-results/renderer.json
node scripts/workspace-perf-benchmark.js --runs=3 --output=performance-results/workspace.json
```

For memory investigation with deliberately oversized renderer fixtures, use:

```powershell
npm run perf:memory -- --profile=aggressive --scenario=all --runs=3
```

The stress benchmark measures graph retention, rendered diff lines, agent cards
and terminal scrollback separately. It records renderer working set, JavaScript
heap and DOM counters before stress, after clearing the surfaces, and after an
explicit diagnostic garbage collection. `normal`, `aggressive` and `extreme`
profiles are reproducible presets; individual dimensions can be overridden with
`--commits`, `--subject-bytes`, `--diff-lines`, `--agent-cards` and
`--terminal-lines`, plus `--diff-mode=unified|split` and
`--navigate-file=true|false` for diff navigation coverage. These measurements
are investigation aids, not functional quality gates.

The workspace benchmark uses two real isolated Git repositories and a local bare remote to measure repeated tab switching at three milestones: graph data ready, primary workspace interactive, and all supporting panels settled. It also measures a real Fetch and verifies that the operation does not trigger a global repository reload, enter the workspace-wide loading state, or replace an already visible graph row. Its memory protocol records a stable welcome baseline, one settled repository, two settled repositories, ten switches, and post-switch idle. It reports working set, Windows private bytes, JavaScript heaps, DOM counters, and Electron browser, renderer, GPU, and utility processes separately. `--diagnostic-gc=true` is an opt-in investigation aid and is never used by the application.

Timing values are observations, not functional assertions. The command fails only when a deterministic renderer contract is broken. Approved nightly baselines compare the same machine, operating system, build mode, fixture, and run count.

## Commit-history loading benchmark

`npm run perf:history` builds a synthetic repository with `git fast-import` in a temporary directory (by default 60,000 commits: a main line with merged feature branches, about 860 branch and remote refs, lightweight and annotated tags and 300 authors). It drives the real `GraphView`, through a minimal DOM harness, against the real `GitService`, structured-cloning every request and response as IPC does. It runs once without and once with a commit-graph and records:

- first page, paging through the whole history, per-call latency (how long one call holds the repository queue) and refs transferred;
- renderer work per appended page and rows whose lanes are rebuilt on a three-row scroll;
- filter, author and sort interactions with the whole history loaded, and a five-keystroke typing burst;
- a reload after a fetch that adds 25 remote commits with the viewport anchored at row 20,000, with a status probe waiting on the same queue;
- a reload after a fetch that changed nothing.

`--commits=N`, `--anchor=ROW`, `--commit-graph=never|only|both` and `--output=path` adjust the run. The results recorded for ADR-0010 are in `benchmark/history-perf-baseline.json` and `benchmark/history-perf-after.json` (Linux, Intel Core Ultra 7 155H, Git 2.56, 60,000 commits; values in ms unless noted):

| Measurement | Before, no commit-graph | After, no commit-graph | Before, commit-graph | After, commit-graph |
| --- | ---: | ---: | ---: | ---: |
| Page through the whole history (120 pages) | 62,318 | 2,620 | 17,073 | 1,564 |
| Page call p95 | 1,177 | 24 | 184 | 18 |
| Refs transferred (count) | 111,720 | 931 | 111,720 | 931 |
| Renderer work for all appended pages | 1,477 | 137 | 920 | 93 |
| Lane SVGs rebuilt on a three-row scroll (count) | 64 | 3 | 64 | 3 |
| Sort 60,000 rows by author | 3,794 | 58 | 3,524 | 57 |
| Filter passes for a five-keystroke burst (count) | 5 | 1 | 5 | 1 |
| Reload after fetch, anchored at row 20,000 | 21,665 | 340 | 6,625 | 164 |
| Longest status wait behind that reload | 962 | 297 | 220 | 107 |
| Reload after a fetch that changed nothing | 19,441 | 26 | 5,516 | 30 |

The first page stays within run-to-run noise (about 270–520 ms without a commit-graph, 70–110 ms with one).

## Optimization loop

1. Record at least five baseline runs.
2. Select one measured bottleneck.
3. Add a functional characterization test when behavior could change.
4. Make one focused optimization without removing UI states, animations, or Git capabilities.
5. Record the same benchmark again on the same machine.
6. Accept the change only when the target metric improves without a material regression elsewhere.

Investigate a nightly regression above 20% against the approved median. Do not hide it with retries or by lowering a functional gate.

## Non-negotiable contracts

- Keep fewer than 100 commit rows in the DOM for the 10,000-commit fixture.
- Update selection in place; do not rebuild the commit list.
- Refresh Fetch, Pull, and Push incrementally without blanking the workspace or losing viewport and filters.
- Serve graph pages as slices of the cached snapshot order (ADR-0010); never walk the history again per page with `--skip`.
- Send the known snapshot on refresh: an unchanged history costs one request and keeps every row.
- Preview panel and history-column resize with `transform` only.
- Commit and persist a resized width once, on pointer release.
- Animate only `transform` and `opacity`, using the design-system durations.
- Open and close Branches and Inspector with compositor-only motion; never animate workspace grid columns.
- Preserve all loading, empty, error, disabled, focus, keyboard, theme, and language states.
