const test = require('node:test');
const assert = require('node:assert/strict');
let GraphView;
let graphAnchorIsLoaded;
try {
  const mod = require('../src/renderer/components/graph-view.mts');
  GraphView = mod.GraphView || mod.default || mod;
  graphAnchorIsLoaded = mod.graphAnchorIsLoaded;
} catch {
  const mod = require('../src/renderer/components/graph-view');
  GraphView = mod.GraphView || mod.default || mod;
  graphAnchorIsLoaded = mod.graphAnchorIsLoaded;
}

function createView(scrollTop) {
  const view = Object.create(GraphView.prototype);
  view.container = { scrollTop };
  view.rowHeight = 38;
  view.visibleRows = Array.from({ length: 10 }, (_, index) => ({
    commit: { hash: `commit-${index}` }
  }));
  view.hashes = new Set(view.visibleRows.map(row => row.commit.hash));
  view.selectedHashes = new Set();
  view.selectedHash = null;
  view.selectionAnchor = null;
  return view;
}

test('remote refresh preserves the exact top of the commit history viewport', () => {
  const view = createView(0);
  const state = view.captureViewportState();

  view.container.scrollTop = 36;
  view.restoreViewportState(state);

  assert.equal(view.container.scrollTop, 0);
});

test('remote refresh keeps the visible commit anchored away from the top', () => {
  const view = createView(131);
  const state = view.captureViewportState();

  view.visibleRows.unshift({ commit: { hash: 'new-remote-commit' } });
  view.hashes.add('new-remote-commit');
  view.restoreViewportState(state);

  assert.equal(view.container.scrollTop, 169);
});

test('inspector snapshot exposes only graph geometry and tooltip metadata', () => {
  const view = Object.create(GraphView.prototype);
  view.rows = [{
    commit: { hash: 'abc1234', subject: 'Inspector layout', authorName: 'Ada' },
    lane: 1,
    incoming: true,
    before: ['parent', 'abc1234'],
    after: ['parent'],
    parents: [{ hash: 'parent', lane: 0, kind: 'first-parent' }]
  }];
  view.refsByHash = new Map([['abc1234', [{
    fullName: 'refs/heads/main', shortName: 'main', type: 'branch', upstream: 'origin/main'
  }]]]);
  view.dataRevision = 7;
  view.laneCount = 2;
  view.hasMore = false;
  view.selectedHash = 'abc1234';

  assert.deepEqual(view.getInspectorSnapshot(), {
    revision: 7,
    laneCount: 2,
    hasMore: false,
    selectedHash: 'abc1234',
    rows: [{
      hash: 'abc1234',
      subject: 'Inspector layout',
      lane: 1,
      incoming: true,
      before: ['parent', 'abc1234'],
      parents: [{ hash: 'parent', lane: 0, kind: 'first-parent' }],
      refs: [{ shortName: 'main', type: 'branch' }]
    }]
  });
});

test('graphAnchorIsLoaded finds anchors in visible or full topology rows', () => {
  const rows = [{ commit: { hash: 'deep' } }];
  const visible = [{ commit: { hash: 'top' } }];
  assert.equal(graphAnchorIsLoaded(null, rows, visible), true);
  assert.equal(graphAnchorIsLoaded('top', rows, visible), true);
  assert.equal(graphAnchorIsLoaded('deep', rows, visible), true);
  assert.equal(graphAnchorIsLoaded('missing', rows, visible), false);
});

test('ensureAnchorLoaded loads pages until the anchor commit is present', async () => {
  const view = Object.create(GraphView.prototype);
  view.generation = 1;
  view.hasMore = true;
  view.rows = [];
  view.visibleRows = [];
  let calls = 0;
  view.loadNextPage = async () => {
    calls += 1;
    if (calls === 1) {
      view.rows = [{ commit: { hash: 'page-1' } }];
      view.visibleRows = [...view.rows];
      view.hasMore = true;
      return true;
    }
    view.rows.push({ commit: { hash: 'anchor-commit' } });
    view.visibleRows = [...view.rows];
    view.hasMore = false;
    return true;
  };

  await view.ensureAnchorLoaded('anchor-commit', 1);

  assert.equal(calls, 2);
  assert.equal(graphAnchorIsLoaded('anchor-commit', view.rows, view.visibleRows), true);
});

test('ensureAnchorLoaded stops when generation changes', async () => {
  const view = Object.create(GraphView.prototype);
  view.generation = 2;
  view.hasMore = true;
  view.rows = [];
  view.visibleRows = [];
  let calls = 0;
  view.loadNextPage = async () => {
    calls += 1;
    return true;
  };

  await view.ensureAnchorLoaded('missing', 1);

  assert.equal(calls, 0);
});
