// Measures commit-history loading on a synthetic repository built with
// `git fast-import`: the real GraphView (with a minimal DOM harness) is wired to
// the real GitService, with structured cloning standing in for IPC.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { GitService } = require('../src/main/git-service.mts');
const { GraphView } = require('../src/renderer/components/graph-view.mts');
const { createRepository, git } = require('../test/helpers/git-repository');
const { writeSyntheticHistory } = require('../test/helpers/synthetic-history');
const { createGraphViewHarness } = require('../test/helpers/graph-view-harness');

const projectRoot = path.resolve(__dirname, '..');
const ROW_HEIGHT = 38;
const HEADER_HEIGHT = 36;

function readArgument(name, fallback = '') {
  const prefix = `--${name}=`;
  const argument = process.argv.find(value => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values) {
  const safe = values.filter(Number.isFinite);
  if (!safe.length) return null;
  return {
    totalMs: safe.reduce((sum, value) => sum + value, 0),
    averageMs: safe.reduce((sum, value) => sum + value, 0) / safe.length,
    p50Ms: percentile(safe, 0.5),
    p95Ms: percentile(safe, 0.95),
    maxMs: Math.max(...safe),
    samples: safe.length
  };
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function addRemoteCommits(repository, count) {
  let parent = git(repository, 'rev-parse', 'refs/remotes/origin/main');
  const tree = git(repository, 'rev-parse', `${parent}^{tree}`);
  const base = Math.floor(Date.now() / 1000);
  for (let index = 0; index < count; index += 1) {
    parent = execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', `remote change ${index}`], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Remote Dev',
        GIT_AUTHOR_EMAIL: 'remote@example.test',
        GIT_COMMITTER_NAME: 'Remote Dev',
        GIT_COMMITTER_EMAIL: 'remote@example.test',
        GIT_AUTHOR_DATE: `${base + index} +0000`,
        GIT_COMMITTER_DATE: `${base + index} +0000`
      }
    }).trim();
  }
  git(repository, 'update-ref', 'refs/remotes/origin/main', parent);
}

function countCalls(target, name, run) {
  const original = target[name];
  let calls = 0;
  target[name] = function counted(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    run();
  } finally {
    target[name] = original;
  }
  return calls;
}

async function probeQueue(service, until) {
  const samples = [];
  while (!until()) {
    const startedAt = performance.now();
    await service.getStatus();
    samples.push(performance.now() - startedAt);
    await wait(10);
  }
  return summarize(samples);
}

async function runScenario({ commits, commitGraph, anchorRow }) {
  const repo = createRepository();
  try {
    const buildStartedAt = performance.now();
    writeSyntheticHistory(repo.repository, { commits, seed: 7, authors: 300 });
    if (commitGraph) git(repo.repository, 'commit-graph', 'write', '--reachable');
    const buildMs = performance.now() - buildStartedAt;

    const service = new GitService(repo.repository);
    const calls = [];
    const bridge = {
      async getGraphPage(repoPath, options = {}) {
        const request = structuredClone(options);
        const startedAt = performance.now();
        const result = await service.getGraphPage(
          request.offset || 0,
          request.limit || 500,
          ...(request.snapshot ? [request.snapshot] : [])
        );
        const response = structuredClone(result);
        calls.push({
          offset: request.offset || 0,
          limit: request.limit || 500,
          ms: performance.now() - startedAt,
          commits: result.commits?.length || 0,
          refs: result.refs?.length || 0
        });
        return response;
      }
    };
    const harness = createGraphViewHarness(GraphView, { bridge, clientHeight: 900 });
    const { view, container, controls } = harness;
    try {
      // 1. First paint.
      let startedAt = performance.now();
      await view.load(repo.repository);
      const firstPageMs = performance.now() - startedAt;

      // 2. Scroll-driven paging until the whole history is loaded.
      const pageSamples = [];
      const rendererAppendSamples = [];
      startedAt = performance.now();
      while (view.hasMore) {
        const before = calls.length;
        const pageStartedAt = performance.now();
        const loaded = await view.loadNextPage();
        const pageMs = performance.now() - pageStartedAt;
        if (!loaded) break;
        pageSamples.push(pageMs);
        const bridgeMs = calls.slice(before).reduce((sum, call) => sum + call.ms, 0);
        rendererAppendSamples.push(Math.max(0, pageMs - bridgeMs));
      }
      const fullHistoryMs = performance.now() - startedAt + firstPageMs;
      const loadedRows = view.rows.length;
      const refsTransferred = calls.reduce((sum, call) => sum + call.refs, 0);
      const pageCalls = calls.splice(0, calls.length);

      // 3. Row virtualization: progressive scroll by three rows.
      container.scrollTop = HEADER_HEIGHT + ROW_HEIGHT * 1000;
      view.renderViewport(true);
      container.scrollTop += ROW_HEIGHT * 3;
      const svgBuildsOnScroll = countCalls(view, 'createGraphSvg', () => view.renderViewport());

      // 4. Filter and sort interactions with the whole history loaded.
      const interactions = {};
      const measure = (name, mutate) => {
        mutate();
        const interactionStartedAt = performance.now();
        view.commitHistoryState();
        interactions[name] = performance.now() - interactionStartedAt;
      };
      measure('queryFilterMs', () => { view.filters.query = 'fix'; });
      measure('authorFilterMs', () => { view.filters = { query: '', author: 'dev3@example.test', ref: 'all' }; });
      measure('sortByAuthorMs', () => { view.filters.author = ''; view.sortMode = 'author'; });
      measure('sortByDateMs', () => { view.sortMode = 'date-desc'; });
      measure('topologyMs', () => { view.sortMode = 'topology'; });

      const queryInput = controls['history-filter-query'];
      const typingStartedAt = performance.now();
      const typingFilterCalls = await (async () => {
        const original = view.applyFilter;
        let filterCalls = 0;
        view.applyFilter = function countedApplyFilter(...args) {
          filterCalls += 1;
          return original.apply(this, args);
        };
        try {
          for (const value of ['g', 'gr', 'gra', 'grap', 'graph']) {
            queryInput.value = value;
            queryInput.dispatch('input');
          }
          await wait(250);
          harness.flushFrames();
        } finally {
          view.applyFilter = original;
        }
        return filterCalls;
      })();
      const typingBurstMs = performance.now() - typingStartedAt;
      queryInput.value = '';
      queryInput.dispatch('input');
      await wait(250);
      view.filters.query = '';
      view.commitHistoryState();

      // 5. Reload after a fetch that brought new remote commits, anchored deep.
      const anchor = Math.min(anchorRow, view.visibleRows.length - 1);
      container.scrollTop = HEADER_HEIGHT + ROW_HEIGHT * anchor;
      view.renderViewport(true);
      const anchorHash = view.visibleRows[anchor].commit.hash;
      addRemoteCommits(repo.repository, 25);
      let reloadDone = false;
      startedAt = performance.now();
      const reload = view.load(repo.repository, { preserveViewport: true })
        .finally(() => { reloadDone = true; });
      const queueDuringReload = await probeQueue(service, () => reloadDone);
      await reload;
      const reloadAfterFetchMs = performance.now() - startedAt;
      const reloadCalls = calls.splice(0, calls.length);
      const viewportRow = Math.floor((container.scrollTop - HEADER_HEIGHT) / ROW_HEIGHT);
      const anchorPreserved = view.visibleRows[viewportRow]?.commit.hash === anchorHash;

      // 6. Reload after a fetch that changed nothing.
      startedAt = performance.now();
      await view.load(repo.repository, { preserveViewport: true });
      const reloadUnchangedMs = performance.now() - startedAt;
      const unchangedCalls = calls.splice(0, calls.length);

      return {
        commits,
        commitGraph,
        buildMs,
        firstPageMs,
        fullHistory: {
          totalMs: fullHistoryMs,
          loadedRows,
          bridgeCalls: pageCalls.length + 0,
          refsTransferred,
          bridgeCall: summarize(pageCalls.map(call => call.ms)),
          pageLoad: summarize(pageSamples),
          rendererAppend: summarize(rendererAppendSamples)
        },
        svgBuildsOnScroll,
        interactions,
        typingBurst: { applyFilterCalls: typingFilterCalls, totalMs: typingBurstMs },
        reloadAfterFetch: {
          totalMs: reloadAfterFetchMs,
          anchorRow: anchor,
          anchorPreserved,
          bridgeCalls: reloadCalls.length,
          bridgeCall: summarize(reloadCalls.map(call => call.ms)),
          queueProbeDuringReload: queueDuringReload
        },
        reloadUnchanged: {
          totalMs: reloadUnchangedMs,
          bridgeCalls: unchangedCalls.length,
          bridgeCall: summarize(unchangedCalls.map(call => call.ms))
        }
      };
    } finally {
      harness.restore();
    }
  } finally {
    repo.cleanup();
  }
}

async function main() {
  const commits = Math.max(1000, Number(readArgument('commits', '60000')) || 60000);
  const anchorRow = Math.max(0, Number(readArgument('anchor', '20000')) || 20000);
  const variants = readArgument('commit-graph', 'both');
  const scenarios = [];
  if (variants !== 'only') scenarios.push(await runScenario({ commits, commitGraph: false, anchorRow }));
  if (variants !== 'never') scenarios.push(await runScenario({ commits, commitGraph: true, anchorRow }));
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
      cpu: os.cpus()[0]?.model || 'unknown',
      logicalCpus: os.cpus().length
    },
    scenarios
  };
  const output = readArgument('output', process.env.GITTREE_HISTORY_PERF_OUTPUT || '');
  if (output) {
    const outputPath = path.resolve(projectRoot, output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
