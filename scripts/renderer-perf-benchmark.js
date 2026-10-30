/* global cancelAnimationFrame, document, getComputedStyle, MutationObserver, PointerEvent, requestAnimationFrame, window */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { _electron: electron } = require('playwright');
const { createElectronFixture } = require('../test/helpers/electron-fixture');

const projectRoot = path.resolve(__dirname, '..');

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.find(value => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function summarize(values) {
  const safeValues = values.filter(Number.isFinite);
  if (!safeValues.length) return null;
  const total = safeValues.reduce((sum, value) => sum + value, 0);
  return {
    average: total / safeValues.length,
    p50: percentile(safeValues, 0.5),
    p95: percentile(safeValues, 0.95),
    max: Math.max(...safeValues),
    samples: safeValues.length
  };
}

async function measureRenderer(page) {
  return page.evaluate(async () => {
    const percentile = (values, ratio) => {
      const sorted = [...values].sort((left, right) => left - right);
      const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
      return sorted[index] || 0;
    };
    const summarize = values => {
      const total = values.reduce((sum, value) => sum + value, 0);
      return {
        averageMs: total / values.length,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        maxMs: Math.max(...values),
        over8ms: values.filter(value => value > 8).length,
        over16ms: values.filter(value => value > 16.7).length,
        samples: values.length
      };
    };
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const profileDistantJumps = (graph, graphView, maxScroll) => {
      const methodNames = ['createRow', 'updateRow', 'createGraphSvg', 'fmtDate'];
      const originals = Object.fromEntries(methodNames.map(name => [name, graphView[name]]));
      const timings = Object.fromEntries(methodNames.map(name => [name, { calls: 0, totalMs: 0 }]));
      for (const name of methodNames) {
        graphView[name] = function profileGraphMethod(...args) {
          const startedAt = performance.now();
          try {
            return originals[name].apply(this, args);
          } finally {
            timings[name].calls += 1;
            timings[name].totalMs += performance.now() - startedAt;
          }
        };
      }
      const startedAt = performance.now();
      try {
        for (let index = 0; index < 100; index += 1) {
          graph.scrollTop = maxScroll * (index / 99);
          graphView.renderViewport();
          graphView.layer.getBoundingClientRect();
        }
      } finally {
        for (const name of methodNames) graphView[name] = originals[name];
      }
      const totalMs = performance.now() - startedAt;
      const rowWorkMs = timings.updateRow.calls
        ? timings.updateRow.totalMs
        : timings.createRow.totalMs;
      const graphSvgMs = timings.createGraphSvg.totalMs;
      const dateFormattingMs = timings.fmtDate.totalMs;
      return {
        totalMs,
        averageJumpMs: totalMs / 100,
        attributionPerJumpMs: {
          dateFormatting: dateFormattingMs / 100,
          graphSvg: graphSvgMs / 100,
          remainingRowAssembly: Math.max(
            0,
            rowWorkMs - graphSvgMs - dateFormattingMs
          ) / 100,
          domCommitAndLayout: Math.max(0, totalMs - rowWorkMs) / 100
        },
        methods: Object.fromEntries(methodNames.map(name => [name, {
          ...timings[name],
          averageCallMs: timings[name].calls
            ? timings[name].totalMs / timings[name].calls
            : 0
        }]))
      };
    };
    const measureMutations = (iterations, mutate, forceLayout) => {
      const samples = [];
      for (let index = 0; index < iterations; index += 1) {
        const startedAt = performance.now();
        mutate(index);
        forceLayout();
        samples.push(performance.now() - startedAt);
      }
      return summarize(samples);
    };
    const measurePanelTransition = async ({ run, panel, animationName, graphLayer }) => {
      const rowsBefore = [...graphLayer.querySelectorAll('.graph-row')];
      const startedAt = performance.now();
      run();
      const triggerMs = performance.now() - startedAt;
      const animation = panel.getAnimations().find(candidate => (
        candidate.animationName === animationName
      ));
      const keyframeProperties = animation
        ? [...new Set(animation.effect.getKeyframes().flatMap(keyframe => (
            Object.keys(keyframe).filter(key => ![
              'offset',
              'computedOffset',
              'easing',
              'composite'
            ].includes(key))
          )))]
        : [];
      const frameIntervals = [];
      let previousFrame = performance.now();
      for (let index = 0; index < 40 && panel.dataset.motionState !== 'idle'; index += 1) {
        await nextFrame();
        const currentFrame = performance.now();
        frameIntervals.push(currentFrame - previousFrame);
        previousFrame = currentFrame;
      }
      const rowsAfter = [...graphLayer.querySelectorAll('.graph-row')];
      return {
        animationName: animation?.animationName || '',
        triggerMs,
        frames: summarize(frameIntervals.length ? frameIntervals : [0]),
        keyframeProperties,
        finishesIdle: panel.dataset.motionState === 'idle',
        preservesGraphRows: rowsBefore.length === rowsAfter.length &&
          rowsBefore.every((row, index) => rowsAfter[index] === row)
      };
    };

    const graph = document.querySelector('.graph-view');
    const graphView = window.app?.components?.graphView;
    const workspace = document.getElementById('workspace-body');
    const leftHandle = document.getElementById('resize-handle-left');
    const historyHandle = document.querySelector(
      '.graph-column-resizer[data-column="message"]'
    );
    if (!graph || !graphView || !workspace || !leftHandle || !historyHandle) {
      throw new Error('Required GitTree performance surfaces are missing');
    }

    const original = {
      rows: graphView.rows,
      visibleRows: graphView.visibleRows,
      hasMore: graphView.hasMore,
      selectedHash: graphView.selectedHash,
      selectedHashes: [...graphView.selectedHashes],
      selectionAnchor: graphView.selectionAnchor,
      scrollTop: graph.scrollTop,
      leftPanel: workspace.style.getPropertyValue('--left-panel'),
      storedLeftPanel: localStorage.getItem('gittree.panel.left'),
      columnWidths: { ...graphView.columnWidths },
      hasPersistedColumnWidths: graphView.hasPersistedColumnWidths,
      storedColumnWidths: localStorage.getItem('gittree.history.columns'),
      sidebarCollapsed: workspace.classList.contains('sidebar-collapsed'),
      inspectorState: window.app.inspectorState,
      storedSidebarCollapsed: localStorage.getItem('gittree.sidebar.collapsed'),
      storedInspectorState: localStorage.getItem('gittree.workspace.inspector')
    };

    let metrics;
    try {
      const syntheticRows = Array.from({ length: 10000 }, (_, index) => ({
        lane: 0,
        incoming: index > 0,
        before: index ? ['synthetic'] : [],
        after: index < 9999 ? ['synthetic'] : [],
        parents: index < 9999
          ? [{ hash: `synthetic-${index + 1}`, lane: 0, kind: 'first-parent' }]
          : [],
        commit: {
          hash: `synthetic-${String(index).padStart(10, '0')}`,
          subject: `Synthetic performance commit ${index}`,
          authorName: 'Performance fixture',
          authorEmail: 'fixture@example.com',
          date: '2026-01-01T00:00:00.000Z'
        }
      }));

      graphView.rows = syntheticRows;
      graphView.visibleRows = syntheticRows;
      graphView.hasMore = false;
      graphView.selectedHash = null;
      graphView.selectedHashes.clear();
      graphView.selectionAnchor = null;
      graph.scrollTop = 0;

      const initialRenderStartedAt = performance.now();
      graphView.applyFilter();
      graphView.renderViewport(true);
      graphView.layer.getBoundingClientRect();
      const initialRenderMs = performance.now() - initialRenderStartedAt;
      await nextFrame();

      const renderedRows = [...graphView.layer.querySelectorAll('.graph-row')];
      const maxScroll = Math.max(0, graph.scrollHeight - graph.clientHeight);
      const jumpViewportRender = measureMutations(200, index => {
        graph.scrollTop = maxScroll * (index / 199);
        graphView.renderViewport();
      }, () => graphView.layer.getBoundingClientRect().height);

      graph.scrollTop = 0;
      graphView.renderViewport(true);
      const rowsBeforeProgressiveScroll = new Map(
        [...graphView.layer.querySelectorAll('.graph-row')].map(row => [
          row.dataset.hash,
          row
        ])
      );
      graph.scrollTop = graphView.rowHeight * 3;
      graphView.renderViewport();
      const overlappingRows = [...graphView.layer.querySelectorAll('.graph-row')].filter(row =>
        rowsBeforeProgressiveScroll.has(row.dataset.hash)
      );
      const progressiveScrollReusesRows = overlappingRows.length > 0 && overlappingRows.every(row =>
        rowsBeforeProgressiveScroll.get(row.dataset.hash) === row
      );
      graph.scrollTop = 0;
      graphView.renderViewport(true);
      const shellsBeforeDistantJump = new Set(
        graphView.layer.querySelectorAll('.graph-row')
      );
      const hashesBeforeDistantJump = new Set(
        [...shellsBeforeDistantJump].map(row => row.dataset.hash)
      );
      graph.scrollTop = maxScroll;
      graphView.renderViewport();
      const rowsAfterDistantJump = [...graphView.layer.querySelectorAll('.graph-row')];
      const distantJumpReusesRowShells = rowsAfterDistantJump.some(row => (
        shellsBeforeDistantJump.has(row) && !hashesBeforeDistantJump.has(row.dataset.hash)
      ));
      const distantJumpUpdatesRowContent = rowsAfterDistantJump.every(row => {
        const source = graphView.visibleRows.find(item => item.commit.hash === row.dataset.hash);
        return source
          && row.querySelector('.graph-commit-message .truncate')?.textContent === source.commit.subject
          && row.querySelector('.graph-commit-author')?.textContent === source.commit.authorName
          && row.querySelector('.graph-commit-hash')?.textContent === source.commit.hash.slice(0, 7);
      });
      graph.scrollTop = 0;
      graphView.renderViewport(true);
      const smoothViewportRender = measureMutations(200, index => {
        graph.scrollTop = index * graphView.rowHeight * 3;
        graphView.renderViewport();
      }, () => graphView.layer.getBoundingClientRect().height);

      const jumpScrollFrames = [];
      for (let index = 0; index < 60; index += 1) {
        const startedAt = performance.now();
        graph.scrollTop = maxScroll * (index / 59);
        graphView.scheduleViewport();
        await nextFrame();
        jumpScrollFrames.push(performance.now() - startedAt);
      }

      graph.scrollTop = 0;
      graphView.renderViewport(true);
      const smoothScrollFrames = [];
      for (let index = 0; index < 120; index += 1) {
        const startedAt = performance.now();
        graph.scrollTop = index * graphView.rowHeight * 3;
        graphView.scheduleViewport();
        await nextFrame();
        smoothScrollFrames.push(performance.now() - startedAt);
      }

      const distantJumpProfile = profileDistantJumps(graph, graphView, maxScroll);

      graph.scrollTop = 0;
      graphView.renderViewport(true);
      const selectionRows = [...graphView.layer.querySelectorAll('.graph-row')];
      const selectionHashes = selectionRows.slice(0, 20).map(row => row.dataset.hash);
      const selectionObserver = new MutationObserver(() => {});
      selectionObserver.observe(graphView.layer, { childList: true, subtree: true });
      const selection = measureMutations(500, index => {
        graphView.select(selectionHashes[index % selectionHashes.length], false);
      }, () => graphView.layer.offsetWidth);
      const selectionMutations = selectionObserver.takeRecords().filter(record =>
        record.addedNodes.length || record.removedNodes.length
      ).length;
      selectionObserver.disconnect();
      const selectionPreservedRows = selectionRows.every((row, index) =>
        graphView.layer.querySelectorAll('.graph-row')[index] === row
      );

      const historyResizePreview = measureMutations(500, index => {
        historyHandle.style.transform = `translate3d(${160 * (index / 499)}px, 0, 0)`;
      }, () => historyHandle.getBoundingClientRect().left);
      historyHandle.style.removeProperty('transform');

      workspace.style.setProperty('--left-panel', '260px');
      localStorage.setItem('gittree.panel.left', '260');
      await nextFrame();
      const contractStart = leftHandle.getBoundingClientRect();
      const contractDelta = 48;
      const pointerX = contractStart.left + (contractStart.width / 2);
      const startWidth = document.getElementById('sidebar').getBoundingClientRect().width;
      const expectedWidth = Math.min(380, Math.max(220, startWidth + contractDelta));
      const storedWidthBeforeMove = localStorage.getItem('gittree.panel.left');
      const resizeRowsBefore = [...graphView.layer.querySelectorAll('.graph-row')];
      const resizeFrameSamples = [];
      const resizeOpacitySamples = [];
      const resizeBranchSamples = [];
      leftHandle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: pointerX,
        clientY: contractStart.top + 10
      }));
      const resizeHandleTransitionProperty = getComputedStyle(
        leftHandle,
        '::after'
      ).transitionProperty;
      const resizeDraggingStateObserved = leftHandle.classList.contains('is-dragging') &&
        workspace.classList.contains('is-resizing');
      for (let index = 1; index <= 24; index += 1) {
        const startedAt = performance.now();
        document.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          clientX: pointerX + (contractDelta * (index / 24)),
          clientY: contractStart.top + 10
        }));
        await nextFrame();
        resizeFrameSamples.push(performance.now() - startedAt);
        resizeOpacitySamples.push([
          document.getElementById('sidebar'),
          document.querySelector('.main'),
          document.getElementById('detail-panel')
        ].filter(panel => getComputedStyle(panel).display !== 'none').every(panel => (
          getComputedStyle(panel).opacity === '1'
        )));
        const branchListElement = document.getElementById('branch-list');
        const firstBranch = branchListElement?.querySelector('.branch-item');
        resizeBranchSamples.push(Boolean(
          branchListElement && branchListElement.getBoundingClientRect().height > 0
          && firstBranch && firstBranch.getBoundingClientRect().height > 0
        ));
      }
      const widthDuringMove = workspace.style.getPropertyValue('--left-panel');
      const storedWidthDuringMove = localStorage.getItem('gittree.panel.left');
      const resizeHandleTransform = getComputedStyle(leftHandle).transform;
      const resizeRowsDuring = [...graphView.layer.querySelectorAll('.graph-row')];
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        clientX: pointerX + contractDelta,
        clientY: contractStart.top + 10
      }));
      const widthAfterRelease = workspace.style.getPropertyValue('--left-panel');
      const storedWidth = Number(localStorage.getItem('gittree.panel.left'));

      const historyStart = historyHandle.getBoundingClientRect();
      const historyWidthBefore = graphView.columnWidths.message;
      historyHandle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: historyStart.left,
        clientY: historyStart.top + 10
      }));
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: historyStart.left + contractDelta,
        clientY: historyStart.top + 10
      }));
      const historyWidthDuring = graphView.columnWidths.message;
      await nextFrame();
      const historyTransform = getComputedStyle(historyHandle).transform;
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        clientX: historyStart.left + contractDelta,
        clientY: historyStart.top + 10
      }));
      const historyWidthAfter = graphView.columnWidths.message;
      const persistedHistoryWidth = JSON.parse(
        localStorage.getItem('gittree.history.columns')
      ).message;

      window.app.setSidebarCollapsed(false, false);
      window.app.setInspectorState('open', false);
      await nextFrame();
      const panelMotion = {
        workspaceTransitionProperty: getComputedStyle(workspace).transitionProperty,
        transitions: []
      };
      const panelTransitions = [
        {
          run: () => window.app.setSidebarCollapsed(true),
          panel: document.getElementById('sidebar'),
          animationName: 'motion-panel-exit-left'
        },
        {
          run: () => window.app.setSidebarCollapsed(false),
          panel: document.getElementById('sidebar'),
          animationName: 'motion-panel-enter-left'
        },
        {
          run: () => window.app.setInspectorState('closed'),
          panel: document.getElementById('detail-panel'),
          animationName: 'motion-panel-exit-right'
        },
        {
          run: () => window.app.setInspectorState('open'),
          panel: document.getElementById('detail-panel'),
          animationName: 'motion-panel-enter-right'
        }
      ];
      for (const transition of panelTransitions) {
        panelMotion.transitions.push(await measurePanelTransition({
          ...transition,
          graphLayer: graphView.layer
        }));
      }
      const panelMotionUsesCompositorOnly = panelMotion.transitions.every(transition => (
        transition.animationName &&
        transition.keyframeProperties.sort().join(',') === 'opacity,transform'
      ));

      const agentPanel = window.app.components.worktreeAgents;
      const originalAgentWorktrees = agentPanel.worktrees;
      const originalAgentTasks = agentPanel.tasks;
      agentPanel.worktrees = Array.from({ length: 50 }, (_value, index) => ({
        path: `C:\\benchmark\\worktree-${index}`,
        branch: `agent/benchmark-${index}`
      }));
      agentPanel.tasks = agentPanel.worktrees.map((worktree, index) => ({
        id: `benchmark-${index}`,
        worktreePath: worktree.path,
        title: `Benchmark task ${index}`,
        adapterId: ['codex', 'claude', 'opencode'][index % 3],
        status: index % 7 === 0 ? 'attention' : 'running',
        needsAttention: index % 7 === 0,
        wip: index % 5,
        ahead: index % 3,
        behind: 0,
        updatedAt: new Date(Date.now() - index * 1000).toISOString()
      }));
      const agentCardsStartedAt = performance.now();
      agentPanel.renderAgents();
      document.getElementById('agent-card-list').getBoundingClientRect();
      const agentCardsMs = performance.now() - agentCardsStartedAt;
      const renderedAgentCards = document.querySelectorAll('.agent-card').length;
      await agentPanel.ensureTerminal();
      const terminalStartedAt = performance.now();
      for (let index = 0; index < 6000; index += 1) agentPanel.terminal?.write(`line ${index}\r\n`);
      const terminalWriteMs = performance.now() - terminalStartedAt;
      const terminalBufferLines = agentPanel.terminal?.buffer.active.length || 0;
      agentPanel.worktrees = originalAgentWorktrees;
      agentPanel.tasks = originalAgentTasks;
      agentPanel.renderAgents();

      metrics = {
        syntheticCommits: syntheticRows.length,
        initialRenderMs,
        renderedRows: renderedRows.length,
        scrollRange: maxScroll,
        jumpViewportRender,
        smoothViewportRender,
        jumpScrollFrame: summarize(jumpScrollFrames),
        smoothScrollFrame: summarize(smoothScrollFrames),
        distantJumpProfile,
        selection,
        resizeLiveFrame: summarize(resizeFrameSamples),
        historyResizePreview,
        panelMotion,
        agentSessions: {
          cards: renderedAgentCards,
          cardRenderMs: agentCardsMs,
          terminalWriteMs,
          terminalBufferLines
        },
        jsHeapUsedMb: performance.memory
          ? performance.memory.usedJSHeapSize / (1024 * 1024)
          : null,
        contracts: {
          virtualizesHistory: renderedRows.length < 100,
          progressiveScrollReusesRows,
          distantJumpReusesRowShells,
          distantJumpUpdatesRowContent,
          selectionPreservesRows: selectionPreservedRows && selectionMutations === 0,
          resizeUpdatesRealtime: widthDuringMove === `${Math.round(expectedWidth)}px`,
          resizePersistsOnlyOnRelease:
            storedWidthDuringMove === storedWidthBeforeMove &&
            widthAfterRelease === `${Math.round(expectedWidth)}px` &&
            storedWidth === Math.round(expectedWidth),
          resizeKeepsContentOpaque: resizeOpacitySamples.every(Boolean),
          resizeKeepsBranchContentVisible: resizeBranchSamples.every(Boolean),
          resizePreservesGraphRows:
            resizeRowsBefore.length === resizeRowsDuring.length &&
            resizeRowsBefore.every((row, index) => resizeRowsDuring[index] === row),
          resizeHandleUsesTransformFeedback:
            resizeDraggingStateObserved &&
            resizeHandleTransitionProperty.includes('transform') &&
            resizeHandleTransform === 'none',
          historyResizeAvoidsLiveLayout: historyWidthDuring === historyWidthBefore,
          historyResizePreviewsWithTransform: historyTransform !== 'none',
          historyResizeCommitsOnRelease: historyWidthAfter === historyWidthBefore + contractDelta,
          historyResizePersistsOnRelease: persistedHistoryWidth === historyWidthAfter,
          panelMotionUsesCompositorOnly,
          rendersFiftyAgentCards: renderedAgentCards === 50,
          terminalScrollbackIsBounded: terminalBufferLines <= 5050,
          panelMotionAvoidsGridAnimation:
            !panelMotion.workspaceTransitionProperty.includes('grid-template-columns'),
          panelMotionPreservesGraphRows:
            panelMotion.transitions.every(transition => transition.preservesGraphRows),
          panelMotionCompletes:
            panelMotion.transitions.every(transition => transition.finishesIdle)
        }
      };
    } finally {
      if (graphView.raf) {
        cancelAnimationFrame(graphView.raf);
        graphView.raf = 0;
      }
      graphView.rows = original.rows;
      graphView.visibleRows = original.visibleRows;
      graphView.hasMore = original.hasMore;
      graphView.selectedHash = original.selectedHash;
      graphView.selectedHashes = new Set(original.selectedHashes);
      graphView.selectionAnchor = original.selectionAnchor;
      graphView.setColumnWidths(original.columnWidths, false);
      graphView.hasPersistedColumnWidths = original.hasPersistedColumnWidths;
      if (original.storedColumnWidths == null) {
        localStorage.removeItem('gittree.history.columns');
      } else {
        localStorage.setItem('gittree.history.columns', original.storedColumnWidths);
      }
      if (original.leftPanel) {
        workspace.style.setProperty('--left-panel', original.leftPanel);
      } else {
        workspace.style.removeProperty('--left-panel');
      }
      if (original.storedLeftPanel == null) {
        localStorage.removeItem('gittree.panel.left');
      } else {
        localStorage.setItem('gittree.panel.left', original.storedLeftPanel);
      }
      window.app.setSidebarCollapsed(original.sidebarCollapsed, false);
      window.app.setInspectorState(original.inspectorState, false);
      if (original.storedSidebarCollapsed == null) {
        localStorage.removeItem('gittree.sidebar.collapsed');
      } else {
        localStorage.setItem('gittree.sidebar.collapsed', original.storedSidebarCollapsed);
      }
      if (original.storedInspectorState == null) {
        localStorage.removeItem('gittree.workspace.inspector');
      } else {
        localStorage.setItem('gittree.workspace.inspector', original.storedInspectorState);
      }
      graph.scrollTop = original.scrollTop;
      graphView.applyFilter();
      graphView.renderViewport(true);
    }
    return metrics;
  });
}

async function runBenchmark() {
  const fixture = createElectronFixture();
  let application;
  const startedAt = performance.now();
  try {
    application = await electron.launch({
      args: [
        projectRoot,
        '--no-sandbox',
        `--user-data-dir=${fixture.userData}`,
        fixture.deepLink
      ],
      cwd: projectRoot
    });
    const launchedMs = performance.now() - startedAt;
    const page = await application.firstWindow();
    const firstWindowMs = performance.now() - startedAt;
    await page.locator('.repo-tab.active').waitFor();
    await page.locator('.graph-row').first().waitFor();
    const repositoryReadyMs = performance.now() - startedAt;
    const runtimeBefore = await readProcessMemory(application);
    const renderer = await measureRenderer(page);
    const runtimeAfter = await readProcessMemory(application);
    const runtime = await application.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome
    }));
    return {
      startup: { launchedMs, firstWindowMs, repositoryReadyMs },
      runtime: {
        ...runtime,
        before: runtimeBefore,
        after: runtimeAfter,
        totalWorkingSetMb: runtimeAfter.totalWorkingSetMb,
        processCount: runtimeAfter.processes.length
      },
      renderer
    };
  } finally {
    if (application) await application.close().catch(() => {});
    fixture.cleanup();
  }
}

async function readProcessMemory(application) {
  return application.evaluate(({ app }) => {
    const processes = app.getAppMetrics().map(metric => ({
      type: metric.type,
      name: metric.name || null,
      serviceName: metric.serviceName || null,
      workingSetMb: (metric.memory?.workingSetSize || 0) / 1024,
      privateMb: Number.isFinite(metric.memory?.privateBytes)
        ? metric.memory.privateBytes / 1024
        : null
    }));
    const privateValues = processes.map(metric => metric.privateMb).filter(Number.isFinite);
    return {
      processes,
      totalPrivateMb: privateValues.length
        ? privateValues.reduce((total, value) => total + value, 0)
        : null,
      totalWorkingSetMb: processes.reduce(
        (total, metric) => total + metric.workingSetMb,
        0
      )
    };
  });
}

async function main() {
  const runs = Math.max(1, Math.min(
    10,
    Number(readArgument('runs', process.env.GITTREE_PERF_RUNS || '1')) || 1
  ));
  const results = [];
  for (let index = 0; index < runs; index += 1) {
    results.push(await runBenchmark());
  }

  const report = {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      cpu: os.cpus()[0]?.model || 'unknown',
      logicalCpus: os.cpus().length,
      totalMemoryMb: os.totalmem() / (1024 * 1024)
    },
    summary: {
      repositoryReadyMs: summarize(results.map(result => result.startup.repositoryReadyMs)),
      workingSetMb: summarize(results.map(result => result.runtime.totalWorkingSetMb)),
      rendererWorkingSetDeltaMb: summarize(results.map(result => {
        const before = result.runtime.before.processes.find(metric => metric.type === 'Tab');
        const after = result.runtime.after.processes.find(metric => metric.type === 'Tab');
        return after?.workingSetMb - before?.workingSetMb;
      })),
      rendererPrivateDeltaMb: summarize(results.map(result => {
        const before = result.runtime.before.processes.find(metric => metric.type === 'Tab');
        const after = result.runtime.after.processes.find(metric => metric.type === 'Tab');
        return after?.privateMb - before?.privateMb;
      })),
      gpuWorkingSetDeltaMb: summarize(results.map(result => {
        const before = result.runtime.before.processes.find(metric => metric.type === 'GPU');
        const after = result.runtime.after.processes.find(metric => metric.type === 'GPU');
        return after?.workingSetMb - before?.workingSetMb;
      })),
      initialRenderMs: summarize(results.map(result => result.renderer.initialRenderMs)),
      jumpViewportRenderP95Ms: summarize(
        results.map(result => result.renderer.jumpViewportRender.p95Ms)
      ),
      smoothViewportRenderP95Ms: summarize(
        results.map(result => result.renderer.smoothViewportRender.p95Ms)
      ),
      jumpScrollFrameP95Ms: summarize(
        results.map(result => result.renderer.jumpScrollFrame.p95Ms)
      ),
      smoothScrollFrameP95Ms: summarize(
        results.map(result => result.renderer.smoothScrollFrame.p95Ms)
      ),
      selectionP95Ms: summarize(results.map(result => result.renderer.selection.p95Ms)),
      resizeLiveFrameP95Ms: summarize(
        results.map(result => result.renderer.resizeLiveFrame.p95Ms)
      ),
      panelMotionTriggerMs: summarize(results.flatMap(result => (
        result.renderer.panelMotion.transitions.map(transition => transition.triggerMs)
      ))),
      panelMotionFrameP95Ms: summarize(results.flatMap(result => (
        result.renderer.panelMotion.transitions.map(transition => transition.frames.p95Ms)
      )))
    },
    runs: results
  };

  const output = readArgument('output', process.env.GITTREE_PERF_OUTPUT || '');
  if (output) {
    const outputPath = path.resolve(projectRoot, output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));

  const contractsPass = results.every(result =>
    Object.values(result.renderer.contracts).every(Boolean)
  );
  if (!contractsPass) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
