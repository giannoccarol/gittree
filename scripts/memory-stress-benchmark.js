/* global document, requestAnimationFrame, requestIdleCallback, window */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { createElectronFixture } = require('../test/helpers/electron-fixture');

const projectRoot = path.resolve(__dirname, '..');

function readArgument(name, fallback = '') {
  const prefix = `--${name}=`;
  const argument = process.argv.find(value => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function numberArgument(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(readArgument(name, String(fallback)));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function summarize(values) {
  const safe = values.filter(Number.isFinite);
  if (!safe.length) return null;
  return {
    average: safe.reduce((sum, value) => sum + value, 0) / safe.length,
    min: Math.min(...safe),
    max: Math.max(...safe)
  };
}

async function waitForIdle(page) {
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(resolve, { timeout: 1000 });
      } else {
        resolve();
      }
    }));
  }));
}

async function readMemory(application, page, cdp, label) {
  const runtime = await application.evaluate(({ app }) => ({
    main: process.memoryUsage(),
    processes: app.getAppMetrics().map(metric => ({
      type: metric.type,
      name: metric.name || null,
      workingSetMb: (metric.memory?.workingSetSize || 0) / 1024,
      privateMb: Number.isFinite(metric.memory?.privateBytes)
        ? metric.memory.privateBytes / 1024
        : null
    }))
  }));
  const renderer = await page.evaluate(() => ({
    heapUsedMb: performance.memory
      ? performance.memory.usedJSHeapSize / (1024 * 1024)
      : null,
    heapTotalMb: performance.memory
      ? performance.memory.totalJSHeapSize / (1024 * 1024)
      : null,
    domNodes: document.getElementsByTagName('*').length,
    graphRows: document.querySelectorAll('.graph-row').length,
    diffLines: document.querySelectorAll('.diff-line').length,
    agentCards: document.querySelectorAll('.agent-card').length
  }));
  const dom = await cdp.send('Memory.getDOMCounters');
  const privateValues = runtime.processes.map(process => process.privateMb)
    .filter(Number.isFinite);
  const tab = runtime.processes.find(process => process.type === 'Tab');
  return {
    label,
    totalWorkingSetMb: runtime.processes.reduce((sum, process) => sum + process.workingSetMb, 0),
    totalPrivateMb: privateValues.length
      ? privateValues.reduce((sum, value) => sum + value, 0)
      : null,
    rendererWorkingSetMb: tab?.workingSetMb ?? null,
    rendererPrivateMb: tab?.privateMb ?? null,
    mainHeapUsedMb: runtime.main.heapUsed / (1024 * 1024),
    rendererHeapMb: renderer.heapUsedMb,
    rendererHeapTotalMb: renderer.heapTotalMb,
    dom: { ...dom, ...renderer },
    processes: runtime.processes
  };
}

function delta(after, before) {
  const difference = (left, right) => Number.isFinite(left) && Number.isFinite(right)
    ? left - right
    : null;
  return {
    totalWorkingSetMb: difference(after.totalWorkingSetMb, before.totalWorkingSetMb),
    totalPrivateMb: difference(after.totalPrivateMb, before.totalPrivateMb),
    rendererWorkingSetMb: difference(after.rendererWorkingSetMb, before.rendererWorkingSetMb),
    rendererPrivateMb: difference(after.rendererPrivateMb, before.rendererPrivateMb),
    rendererHeapMb: difference(after.rendererHeapMb, before.rendererHeapMb),
    domNodes: difference(after.dom.nodes, before.dom.nodes),
    graphRows: difference(after.dom.graphRows, before.dom.graphRows),
    diffLines: difference(after.dom.diffLines, before.dom.diffLines),
    agentCards: difference(after.dom.agentCards, before.dom.agentCards)
  };
}

function buildOptions() {
  const profile = readArgument('profile', 'aggressive');
  const presets = {
    normal: { commits: 10000, subjectBytes: 64, refsPerCommit: 1, diffLines: 0, agentCards: 50, terminalLines: 6000 },
    aggressive: { commits: 30000, subjectBytes: 2048, refsPerCommit: 3, diffLines: 30000, agentCards: 200, terminalLines: 20000 },
    extreme: { commits: 60000, subjectBytes: 8192, refsPerCommit: 6, diffLines: 60000, agentCards: 500, terminalLines: 50000 }
  };
  const preset = presets[profile] || presets.aggressive;
  return {
    profile,
    commits: numberArgument('commits', preset.commits, { min: 1, max: 100000 }),
    subjectBytes: numberArgument('subject-bytes', preset.subjectBytes, { min: 0, max: 32768 }),
    refsPerCommit: numberArgument('refs-per-commit', preset.refsPerCommit, { min: 0, max: 12 }),
    diffLines: numberArgument('diff-lines', preset.diffLines, { min: 0, max: 100000 }),
    diffMode: ['unified', 'split'].includes(readArgument('diff-mode', 'unified'))
      ? readArgument('diff-mode', 'unified')
      : 'unified',
    navigateFile: readArgument('navigate-file', 'true') !== 'false',
    agentCards: numberArgument('agent-cards', preset.agentCards, { min: 0, max: 1000 }),
    terminalLines: numberArgument('terminal-lines', preset.terminalLines, { min: 0, max: 100000 }),
    scenario: readArgument('scenario', 'all')
  };
}

async function applyStress(page, options) {
  return page.evaluate(async configuration => {
    const graph = document.querySelector('.graph-view');
    const graphView = window.app.components.graphView;
    const scenario = configuration.scenario;
    const result = {};
    const repeat = (character, length) => character.repeat(length);
    const syntheticCommits = Array.from({ length: configuration.commits }, (_, index) => ({
      hash: `stress-${String(index).padStart(12, '0')}`,
      subject: `Stress commit ${index} ${repeat('x', configuration.subjectBytes)}`,
      authorName: `Stress author ${index % 32} ${repeat('a', Math.min(256, configuration.subjectBytes))}`,
      authorEmail: `stress-${index % 32}@fixture.example.com`,
      date: '2026-01-01T00:00:00.000Z',
      parents: index === configuration.commits - 1
        ? []
        : [`stress-${String(index + 1).padStart(12, '0')}`]
    }));

    if (scenario === 'all' || scenario === 'graph') {
      const refs = new Map();
      for (let index = 0; index < syntheticCommits.length; index += 1) {
        refs.set(syntheticCommits[index].hash, Array.from(
          { length: configuration.refsPerCommit },
          (_, refIndex) => ({
            fullName: `refs/stress/${index}/${refIndex}`,
            shortName: `stress-${index}-${refIndex}-${repeat('r', 32)}`,
            type: refIndex === 0 ? 'branch' : 'tag'
          })
        ));
      }
      const layout = window.GraphLayout.layoutGraph(syntheticCommits);
      graphView.rows = layout.rows;
      graphView.visibleRows = layout.rows;
      graphView.hashes = new Set(syntheticCommits.map(commit => commit.hash));
      graphView.refsByHash = refs;
      graphView.hasMore = false;
      graphView.layoutState = layout.nextState;
      graphView.laneCount = layout.laneCount;
      graphView.renderedRange = [-1, -1];
      graph.scrollTop = 0;
      graphView.applyFilter();
      graphView.renderViewport(true);
      graph.getBoundingClientRect();
      result.graph = {
        commits: syntheticCommits.length,
        rows: graphView.rows.length,
        refs: configuration.commits * configuration.refsPerCommit,
        renderedRows: graphView.layer.querySelectorAll('.graph-row').length
      };
    }

    if ((scenario === 'all' || scenario === 'diff') && configuration.diffLines > 0) {
      const lines = ['diff --git a/stress.txt b/stress.txt', '--- a/stress.txt', '+++ b/stress.txt', '@@ -1 +1 @@'];
      for (let index = 0; index < configuration.diffLines; index += 1) {
        const marker = index % 2 === 0 ? '+' : '-';
        lines.push(`${marker}line ${index} ${repeat('d', Math.min(512, configuration.subjectBytes))}`);
      }
      const diff = lines.join('\n');
      const viewer = window.app.components.diffViewer;
      viewer.currentDiff = diff;
      viewer.fileSummaries = viewer.extractFileSummaries(diff);
      viewer.mode = configuration.diffMode;
      viewer.render(diff);
      viewer.body.getBoundingClientRect();
      result.diff = {
        lines: configuration.diffLines,
        bytes: diff.length,
        mode: configuration.diffMode,
        renderedLines: viewer.body.querySelectorAll('.diff-line').length,
        files: viewer.fileSummaries.length,
        scrollToFile: configuration.navigateFile ? viewer.scrollToFile('stress.txt') : null
      };
    }

    if (scenario === 'all' || scenario === 'agents') {
      const panel = window.app.components.worktreeAgents;
      panel.worktrees = Array.from({ length: configuration.agentCards }, (_, index) => ({
        path: `C:\\stress\\worktree-${index}`,
        branch: `agent/stress-${index}`
      }));
      panel.tasks = panel.worktrees.map((worktree, index) => ({
        id: `stress-${index}`,
        worktreePath: worktree.path,
        title: `Stress task ${index} ${repeat('t', Math.min(256, configuration.subjectBytes))}`,
        adapterId: ['codex', 'claude', 'opencode'][index % 3],
        status: index % 7 === 0 ? 'attention' : 'running',
        needsAttention: index % 7 === 0,
        wip: index % 5,
        ahead: index % 3,
        behind: 0,
        updatedAt: new Date(Date.now() - index * 1000).toISOString()
      }));
      panel.renderAgents();
      await panel.ensureTerminal();
      for (let index = 0; index < configuration.terminalLines; index += 1) {
        panel.terminal?.write(`terminal ${index} ${repeat('o', Math.min(256, configuration.subjectBytes))}\r\n`);
      }
      result.agents = {
        cards: document.querySelectorAll('.agent-card').length,
        terminalLines: panel.terminal?.buffer.active.length || 0
      };
    }
    return result;
  }, options);
}

async function clearStress(page) {
  await page.evaluate(() => {
    const graphView = window.app.components.graphView;
    graphView.rows = [];
    graphView.visibleRows = [];
    graphView.hashes.clear();
    graphView.refsByHash.clear();
    graphView.layoutState = { lanes: [] };
    graphView.hasMore = false;
    graphView.renderedRange = [-1, -1];
    graphView.renderViewport(true);
    window.app.components.diffViewer.clear();
    const panel = window.app.components.worktreeAgents;
    panel.worktrees = [];
    panel.tasks = [];
    panel.renderAgents();
    panel.terminal?.clear?.();
  });
}

async function runBenchmark(options) {
  const fixture = createElectronFixture();
  let application;
  try {
    application = await electron.launch({
      args: [projectRoot, '--no-sandbox', '--enable-precise-memory-info', `--user-data-dir=${fixture.userData}`, fixture.deepLink],
      cwd: projectRoot
    });
    const page = await application.firstWindow();
    const cdp = await page.context().newCDPSession(page);
    await page.locator('.repo-tab.active').waitFor({ timeout: 60000 });
    await page.locator('.graph-row').first().waitFor({ timeout: 60000 });
    await waitForIdle(page);
    const baseline = await readMemory(application, page, cdp, 'baseline');
    const stressStartedAt = Date.now();
    const applied = await applyStress(page, options);
    await waitForIdle(page);
    const stressed = await readMemory(application, page, cdp, 'stressed');
    await clearStress(page);
    await waitForIdle(page);
    const cleared = await readMemory(application, page, cdp, 'cleared-before-gc');
    await cdp.send('HeapProfiler.collectGarbage');
    await waitForIdle(page);
    const afterGc = await readMemory(application, page, cdp, 'cleared-after-gc');
    return {
      options,
      applyMs: Date.now() - stressStartedAt,
      applied,
      snapshots: { baseline, stressed, cleared, afterGc },
      deltas: {
        stress: delta(stressed, baseline),
        cleared: delta(cleared, baseline),
        gcReclaim: delta(cleared, afterGc),
        residualAfterGc: delta(afterGc, baseline)
      }
    };
  } finally {
    if (application) await application.close().catch(() => {});
    fixture.cleanup();
  }
}

async function main() {
  const options = buildOptions();
  const runs = numberArgument('runs', 1, { min: 1, max: 5 });
  const results = [];
  for (let index = 0; index < runs; index += 1) {
    results.push(await runBenchmark(options));
  }
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      electron: require('electron/package.json').version,
      cpu: os.cpus()[0]?.model || 'unknown',
      totalMemoryMb: os.totalmem() / (1024 * 1024)
    },
    options,
    summary: {
      applyMs: summarize(results.map(result => result.applyMs)),
      stressRendererWorkingSetMb: summarize(results.map(result => result.deltas.stress.rendererWorkingSetMb)),
      stressRendererHeapMb: summarize(results.map(result => result.deltas.stress.rendererHeapMb)),
      residualRendererWorkingSetMb: summarize(results.map(result => result.deltas.residualAfterGc.rendererWorkingSetMb)),
      residualRendererHeapMb: summarize(results.map(result => result.deltas.residualAfterGc.rendererHeapMb)),
      residualDomNodes: summarize(results.map(result => result.deltas.residualAfterGc.domNodes)),
      gcReclaimRendererWorkingSetMb: summarize(results.map(result => result.deltas.gcReclaim.rendererWorkingSetMb))
    },
    runs: results
  };
  const output = readArgument('output');
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
