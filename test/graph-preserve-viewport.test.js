const test = require('node:test');
const assert = require('node:assert/strict');
const { GraphView } = require('../src/renderer/components/graph-view.mts');
const { createGraphViewHarness } = require('./helpers/graph-view-harness');

function makeCommits() {
  return ['a1', 'b2', 'c3'].map((hash, index, all) => ({
    hash: `commit-${hash}`,
    parents: index < all.length - 1 ? [`commit-${all[index + 1]}`] : [],
    subject: `Subject ${index}`,
    authorName: 'Ada',
    authorEmail: 'ada@example.test',
    date: '2026-01-01'
  }));
}

// A backend without snapshot support: every fetch returns the same commits.
function createBridge() {
  return {
    async getGraphPage() {
      return { commits: makeCommits(), refs: [], nextOffset: 3, hasMore: false };
    }
  };
}

function createLoadedHarness() {
  return createGraphViewHarness(GraphView, {
    bridge: createBridge(),
    storage: {
      'gittree.history.view': JSON.stringify({
        '/repo': { sort: 'date-desc' },
        '/other-repo': { sort: 'date-desc' }
      })
    }
  });
}

test('fetch con preserveViewport riusa i nodi riga esistenti', async () => {
  const harness = createLoadedHarness();
  try {
    const { view } = harness;
    await view.load('/repo');
    const firstRow = view.layer.children[0];

    await view.load('/repo', { preserveViewport: true });

    assert.equal(view.layer.children.length, 3);
    assert.equal(
      view.layer.children[0],
      firstRow,
      'la prima riga del grafo deve conservare la stessa istanza DOM dopo il fetch'
    );
  } finally {
    harness.restore();
  }
});

test('apertura di un altro repository ricostruisce le righe', async () => {
  const harness = createLoadedHarness();
  try {
    const { view } = harness;
    await view.load('/repo');
    const previousRows = [...view.layer.children];

    await view.load('/other-repo', {});

    assert.equal(view.layer.children.length, 3);
    for (const row of view.layer.children) {
      assert.equal(previousRows.includes(row), false);
    }
  } finally {
    harness.restore();
  }
});
