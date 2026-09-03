const test = require('node:test');
const assert = require('node:assert/strict');
let GraphView;
try {
  const mod = require('../src/renderer/components/graph-view.mts');
  GraphView = mod.GraphView || mod.default || mod;
} catch {
  const mod = require('../src/renderer/components/graph-view');
  GraphView = mod.GraphView || mod.default || mod;
}

function makeElement() {
  const element = {
    children: [],
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    title: '',
    innerHTML: '',
    classList: {
      contains(value) {
        return String(element.className).split(' ').includes(value);
      },
      add() {},
      remove() {},
      toggle() {}
    },
    append(...nodes) {
      element.children.push(...nodes);
    },
    appendChild(node) {
      element.children.push(node);
      return node;
    },
    replaceChildren(...nodes) {
      if (nodes.length === 1 && nodes[0] && nodes[0].isFragment === true) {
        element.children = [...nodes[0].children];
      } else {
        element.children = [...nodes];
      }
    },
    setAttribute() {},
    querySelector() { return null; }
  };
  return element;
}

function installDomStubs() {
  const previousDocument = global.document;
  const previousLocalStorage = global.localStorage;
  const previousT = global.t;
  const previousI18next = global.i18next;
  global.i18next = { language: 'en' };
  global.document = {
    createElement: () => makeElement(),
    createElementNS: () => makeElement(),
    createTextNode: text => ({ textContent: String(text) }),
    createDocumentFragment: () => {
      const fragment = makeElement();
      fragment.isFragment = true;
      return fragment;
    }
  };
  global.localStorage = {
    getItem: key => (
      key === 'gittree.test.history'
        ? JSON.stringify({
          '/repo': { sort: 'date-desc' },
          '/other-repo': { sort: 'date-desc' }
        })
        : null
    ),
    setItem: () => {}
  };
  global.t = key => key;
  return () => {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousT === undefined) delete global.t;
    else global.t = previousT;
    if (previousI18next === undefined) delete global.i18next;
    else global.i18next = previousI18next;
  };
}

function makeCommits() {
  return ['a1', 'b2', 'c3'].map((hash, index) => ({
    commit: {
      hash: `commit-${hash}`,
      subject: `Subject ${index}`,
      authorName: 'Ada',
      date: '2026-01-01'
    },
    lane: 0,
    incoming: false,
    before: [],
    parents: []
  }));
}

function createLoadedView() {
  const view = Object.create(GraphView.prototype);
  view.rowHeight = 38;
  view.overscan = 20;
  view.container = { scrollTop: 0, clientHeight: 600 };
  view.body = makeElement();
  view.body.contains = () => true;
  view.layer = makeElement();
  view.body.appendChild(view.layer);
  view.generation = 0;
  view.repoPath = '/repo';
  view.rows = makeCommits();
  view.visibleRows = [...view.rows];
  view.hashes = new Set(view.rows.map(row => row.commit.hash));
  view.refsByHash = new Map();
  view.selectedHashes = new Set();
  view.selectedHash = null;
  view.selectionAnchor = null;
  view.sortMode = 'date-desc';
  view.laneCount = 1;
  view.dataRevision = 1;
  view.renderedRange = [-1, -1];
  view.renderedDataRevision = -1;
  view.layoutState = { lanes: [] };
  view.offset = 0;
  view.hasMore = false;
  view.loading = false;
  view.filters = { query: '', author: '', ref: 'all' };
  view.app = { syncInspectorWorkspace() {} };
  view.syncHistoryControls = () => {};
  view.formatLocalizedDate = () => 'Jan 1, 2026';
  view.historyStateStorageKey = 'gittree.test.history';
  // Simulate a fetch that returns the same commits.
  view.loadNextPage = async () => {
    view.rows = makeCommits();
    view.visibleRows = [...view.rows];
    view.hashes = new Set(view.rows.map(row => row.commit.hash));
    view.hasMore = false;
    return true;
  };
  view.renderViewport(true);
  return view;
}

test('fetch con preserveViewport riusa i nodi riga esistenti', async () => {
  const restore = installDomStubs();
  try {
    const view = createLoadedView();
    const firstRow = view.layer.children[0];

    await view.load('/repo', { preserveViewport: true });

    assert.equal(view.layer.children.length, 3);
    assert.equal(
      view.layer.children[0],
      firstRow,
      'la prima riga del grafo deve conservare la stessa istanza DOM dopo il fetch'
    );
  } finally {
    restore();
  }
});

test('apertura di un altro repository ricostruisce le righe', async () => {
  const restore = installDomStubs();
  try {
    const view = createLoadedView();
    const previousRows = [...view.layer.children];

    await view.load('/other-repo', {});

    assert.equal(view.layer.children.length, 3);
    for (const row of view.layer.children) {
      assert.equal(previousRows.includes(row), false);
    }
  } finally {
    restore();
  }
});
