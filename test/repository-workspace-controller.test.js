const test = require('node:test');
const assert = require('node:assert/strict');
let RepositoryWorkspaceController;
try {
  const mod = require('../src/renderer/repository-workspace-controller.mts');
  RepositoryWorkspaceController = mod.RepositoryWorkspaceController || mod.default || mod;
} catch {
  RepositoryWorkspaceController = require('../src/renderer/repository-workspace-controller');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createElement() {
  const classes = new Set();
  return {
    dataset: {},
    attributes: {},
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      toggle(value, force) {
        if (force) classes.add(value);
        else classes.delete(value);
      },
      contains: value => classes.has(value)
    },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

function createDocument() {
  const workspace = createElement();
  const sidebar = createElement();
  const main = createElement();
  const inspector = createElement();
  const indicators = [createElement(), createElement(), createElement()];
  return {
    workspace,
    sidebar,
    main,
    inspector,
    indicators,
    getElementById(id) {
      return { workspace, sidebar, 'detail-panel': inspector }[id] || null;
    },
    querySelector(selector) {
      return selector === '.main' ? main : null;
    },
    querySelectorAll() {
      return indicators;
    }
  };
}

function createHarness({ graphLoad, supportingLoad } = {}) {
  const calls = [];
  const document = createDocument();
  const graph = graphLoad || deferred();
  const supporting = supportingLoad || deferred();
  const state = { repo: null };
  const components = {
    welcome: {
      hide: () => calls.push('welcome:hide'),
      markStep: step => calls.push(`welcome:${step}`)
    },
    graphView: {
      load: repoPath => {
        calls.push(`graph:${repoPath}`);
        return graph.promise;
      },
      select: hash => calls.push(`select:${hash}`)
    },
    branchList: {
      load: repoPath => {
        calls.push(`branches:${repoPath}`);
        return supporting.promise;
      }
    },
    changes: { load: repoPath => calls.push(`changes:${repoPath}`) },
    pullRequests: { load: repoPath => calls.push(`pull-requests:${repoPath}`) },
    diffViewer: { clear: () => calls.push('diff:clear') },
    statusBar: {
      setBranch: branch => calls.push(`status:branch:${branch}`),
      setRepo: repo => calls.push(`status:repo:${repo}`)
    },
    conflict: { open: operation => calls.push(`conflict:${operation.type}`) }
  };
  const bridge = { platform: 'win32' };
  const controller = new RepositoryWorkspaceController({
    bridge,
    document,
    translate: (key, values) => key === 'statusBar.onBranch' ? `On ${values.branch}` : key,
    state,
    components,
    createLoadSession: (_bridge, repoPath) => ({
      repoPath,
      operationState: async () => ({ type: repoPath.endsWith('repo-a') ? 'merge' : null })
    }),
    callbacks: {
      syncRemoteBusyUI: () => calls.push('remote:sync'),
      restoreWorkspaceMode: repoPath => calls.push(`mode:${repoPath.endsWith('repo-a') ? 'changes' : 'history'}`),
      loadStashes: repoPath => calls.push(`stashes:${repoPath}`),
      loadTags: repoPath => calls.push(`tags:${repoPath}`),
      updateStatus: repoPath => calls.push(`update-status:${repoPath}`),
      syncCurrentRepositoryState: repoPath => {
        calls.push(`sync:${repoPath}`);
        return repoPath.endsWith('repo-a') ? 'main' : 'feature';
      }
    }
  });
  return { controller, state, calls, graph, supporting, document };
}

test('repository activation exposes the graph before supporting views settle', async () => {
  const { controller, state, calls, graph, supporting, document } = createHarness();
  const opening = controller.open({ path: 'C:\\repo-a', name: 'Repo A' }, { selectHash: 'abc123' });

  assert.equal(state.repo.path, 'C:\\repo-a');
  assert.deepEqual(calls.slice(0, 6), [
    'welcome:hide',
    'remote:sync',
    'mode:changes',
    'graph:C:\\repo-a',
    'branches:C:\\repo-a',
    'changes:C:\\repo-a'
  ]);
  assert.equal(document.workspace.dataset.loadState, 'loading');

  graph.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(document.workspace.dataset.loadState, 'interactive');
  assert.ok(calls.includes('diff:clear'));
  assert.ok(calls.includes('select:abc123'));
  assert.equal(calls.includes('sync:C:\\repo-a'), false);

  supporting.resolve();
  await opening;

  assert.equal(document.workspace.dataset.loadState, 'settled');
  assert.ok(calls.includes('sync:C:\\repo-a'));
  assert.ok(calls.includes('status:branch:On main'));
  assert.ok(calls.includes('status:repo:Repo A'));
  assert.ok(calls.includes('welcome:open'));
  assert.ok(calls.includes('conflict:merge'));
});

test('a newer activation prevents an obsolete repository from publishing settled state', async () => {
  const firstGraph = deferred();
  const firstSupporting = deferred();
  const { controller, calls } = createHarness({
    graphLoad: firstGraph,
    supportingLoad: firstSupporting
  });
  const first = controller.open({ path: 'C:\\repo-a', name: 'Repo A' });

  const secondGraph = deferred();
  const secondSupporting = deferred();
  controller.components.graphView.load = repoPath => {
    calls.push(`graph:${repoPath}`);
    return secondGraph.promise;
  };
  controller.components.branchList.load = repoPath => {
    calls.push(`branches:${repoPath}`);
    return secondSupporting.promise;
  };
  const second = controller.open({ path: 'C:\\repo-b', name: 'Repo B' });

  firstGraph.resolve();
  firstSupporting.resolve();
  await first;
  assert.equal(calls.includes('sync:C:\\repo-a'), false);

  secondGraph.resolve();
  secondSupporting.resolve();
  await second;
  assert.ok(calls.includes('sync:C:\\repo-b'));
  assert.ok(calls.includes('status:repo:Repo B'));
});

test('failed activation clears loading state and the next activation can proceed', async () => {
  const graph = deferred();
  const supporting = deferred();
  const { controller, document } = createHarness({ graphLoad: graph, supportingLoad: supporting });
  const failed = controller.open({ path: 'C:\\repo-a', name: 'Repo A' });
  graph.reject(new Error('graph failed'));
  supporting.resolve();

  await assert.rejects(failed, /graph failed/);
  assert.equal(document.workspace.dataset.loadState, 'settled');

  const nextGraph = deferred();
  const nextSupporting = deferred();
  controller.components.graphView.load = () => nextGraph.promise;
  controller.components.branchList.load = () => nextSupporting.promise;
  const next = controller.open({ path: 'C:\\repo-b', name: 'Repo B' });
  nextGraph.resolve();
  nextSupporting.resolve();
  await next;

  assert.equal(document.workspace.dataset.loadState, 'settled');
});

test('repository identity follows platform path casing and destroy cancels pending publication', async () => {
  const { controller, state, calls, graph, supporting } = createHarness();
  state.repo = { path: 'C:\\Repo-A' };
  assert.equal(controller.isCurrentRepository('c:\\repo-a'), true);

  const opening = controller.open({ path: 'C:\\repo-a', name: 'Repo A' });
  controller.destroy();
  graph.resolve();
  supporting.resolve();
  await opening;

  assert.equal(calls.includes('sync:C:\\repo-a'), false);
});
