const test = require('node:test');
const assert = require('node:assert/strict');
let GraphView;
try {
  const mod = require('../src/renderer/components/graph-view.mts');
  GraphView = mod.GraphView || mod.default || mod;
} catch {
  GraphView = require('../src/renderer/components/graph-view');
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
