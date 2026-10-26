const test = require('node:test');
const assert = require('node:assert/strict');
const { GraphView } = require('../src/renderer/components/graph-view.mts');
const { createGraphViewHarness } = require('./helpers/graph-view-harness');

const ROW_HEIGHT = 38;
const HEADER = 36;

function commit(id, parents, extra = {}) {
  return {
    hash: id.padEnd(40, '0'),
    parents: parents.map(parent => parent.padEnd(40, '0')),
    subject: `subject ${id}`,
    authorName: 'Ada',
    authorEmail: 'ada@example.test',
    date: '2026-03-01T10:00:00+01:00',
    ...extra
  };
}

function linearHistory(count, prefix = 'c') {
  const id = index => `${prefix}${index.toString(16).padStart(4, '0')}`;
  return Array.from({ length: count }, (_, index) => commit(
    id(index),
    index < count - 1 ? [id(index + 1)] : []
  ));
}

function refsFor(commits) {
  return [
    { fullName: 'HEAD', shortName: 'HEAD', type: 'head', commit: commits[0].hash, upstream: '' },
    { fullName: 'refs/heads/main', shortName: 'main', type: 'branch', commit: commits[0].hash, upstream: '' }
  ];
}

// Emulates the main-process protocol: one current snapshot; refs are omitted
// when the caller already holds that snapshot.
function createSnapshotBridge(initial) {
  const state = { ...initial, calls: [], gate: null };
  state.getGraphPage = async (repoPath, options = {}) => {
    state.calls.push({ repoPath, ...options });
    if (state.gate) await state.gate;
    const { offset = 0, limit = 500, snapshot } = options;
    const slice = state.commits.slice(offset, offset + limit + 1);
    const page = slice.slice(0, limit);
    return structuredClone({
      commits: page,
      refs: snapshot === state.snapshot ? [] : state.refs,
      nextOffset: offset + page.length,
      hasMore: slice.length > limit,
      snapshot: state.snapshot
    });
  };
  return state;
}

async function loadAll(view) {
  while (view.hasMore) {
    if (!(await view.loadNextPage())) break;
  }
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve));
};

function scrollToRow(harness, row) {
  harness.container.scrollTop = HEADER + row * ROW_HEIGHT;
  harness.view.renderViewport();
}

test('scroll paging sends the snapshot and keeps refs omitted by continuation pages', async () => {
  const commits = linearHistory(1200);
  const bridge = createSnapshotBridge({ commits, refs: refsFor(commits), snapshot: 'aaaa1111' });
  const harness = createGraphViewHarness(GraphView, { bridge });
  try {
    const { view } = harness;
    await view.load('/repo');
    await loadAll(view);

    assert.deepEqual(bridge.calls.map(call => [call.offset, call.limit, call.snapshot]), [
      [0, 500, undefined],
      [500, 500, 'aaaa1111'],
      [1000, 500, 'aaaa1111']
    ]);
    assert.equal(view.rows.length, 1200);
    assert.deepEqual(view.refsByHash.get(commits[0].hash).map(ref => ref.shortName), ['HEAD', 'main']);
    const badges = view.layer.children[0].children[1].children[0].children;
    assert.deepEqual(badges.map(badge => badge.textContent), ['HEAD', 'main']);
  } finally {
    harness.restore();
  }
});

test('an unchanged snapshot reload keeps every row and needs one request', async () => {
  const commits = linearHistory(1300);
  const bridge = createSnapshotBridge({ commits, refs: refsFor(commits), snapshot: 'bbbb2222' });
  const harness = createGraphViewHarness(GraphView, { bridge });
  try {
    const { view, container } = harness;
    await view.load('/repo');
    await loadAll(view);
    scrollToRow(harness, 1000);
    view.select(commits[1001].hash, false);
    const rows = view.rows;
    const renderedRow = view.layer.children[0];
    bridge.calls.length = 0;

    await view.load('/repo', { preserveViewport: true });

    assert.deepEqual(bridge.calls.map(call => [call.offset, call.snapshot]), [[0, 'bbbb2222']]);
    assert.equal(view.rows, rows);
    assert.equal(view.layer.children[0], renderedRow);
    assert.equal(container.scrollTop, HEADER + 1000 * ROW_HEIGHT);
    assert.deepEqual([...view.selectedHashes], [commits[1001].hash]);
    assert.equal(view.hasMore, false);
  } finally {
    harness.restore();
  }
});

test('a changed snapshot reload stages large slices up to the anchor before swapping', async () => {
  const commits = linearHistory(3000);
  const bridge = createSnapshotBridge({ commits, refs: refsFor(commits), snapshot: 'cccc3333' });
  const harness = createGraphViewHarness(GraphView, { bridge });
  try {
    const { view, container } = harness;
    await view.load('/repo');
    for (let page = 0; page < 3; page += 1) await view.loadNextPage();
    scrollToRow(harness, 1200);
    const anchor = view.visibleRows[1200].commit.hash;
    view.select(anchor, false);
    const fetched = linearHistory(5, 'f').map((entry, index, all) => ({
      ...entry,
      parents: [index < all.length - 1 ? all[index + 1].hash : commits[0].hash]
    }));
    bridge.commits = [...fetched, ...commits];
    bridge.refs = refsFor(bridge.commits);
    bridge.snapshot = 'dddd4444';
    bridge.calls.length = 0;

    let release;
    bridge.gate = new Promise(resolve => { release = resolve; });
    const reload = view.load('/repo', { preserveViewport: true });
    await settle();
    assert.equal(view.rows.length, 2000, 'the previous history stays visible while staging');
    assert.equal(view.layer.children.length > 0, true);
    release();
    bridge.gate = null;
    await reload;

    assert.deepEqual(bridge.calls.map(call => [call.offset, call.limit, call.snapshot]), [
      [0, 500, 'cccc3333'],
      [500, 1000, 'dddd4444']
    ]);
    assert.equal(view.snapshot, 'dddd4444');
    assert.equal(view.rows.length, 1500);
    assert.equal(view.rows[0].commit.hash, fetched[0].hash);
    assert.equal(container.scrollTop, HEADER + 1205 * ROW_HEIGHT);
    assert.deepEqual([...view.selectedHashes], [anchor]);
    assert.equal(view.hasMore, true);
    assert.equal(view.offset, 1500);
  } finally {
    harness.restore();
  }
});

test('history that moves under a continuation page reloads around the viewport', async () => {
  const commits = linearHistory(1200);
  const bridge = createSnapshotBridge({ commits, refs: refsFor(commits), snapshot: 'eeee5555' });
  const harness = createGraphViewHarness(GraphView, { bridge });
  try {
    const { view } = harness;
    await view.load('/repo');
    const extra = { ...commit('n0', []), parents: [commits[0].hash] };
    bridge.commits = [extra, ...commits];
    bridge.refs = refsFor(bridge.commits);
    bridge.snapshot = 'ffff6666';
    bridge.calls.length = 0;

    assert.equal(await view.loadNextPage(), false);
    await settle();

    assert.deepEqual(bridge.calls.map(call => [call.offset, call.snapshot]), [
      [500, 'eeee5555'],
      [0, 'eeee5555']
    ]);
    assert.equal(view.snapshot, 'ffff6666');
    assert.equal(view.rows[0].commit.hash, extra.hash);
    assert.equal(view.loading, false);
  } finally {
    harness.restore();
  }
});

test('a newer load stops a staged reload from publishing', async () => {
  const commits = linearHistory(1200);
  const bridge = createSnapshotBridge({ commits, refs: refsFor(commits), snapshot: 'abab7777' });
  const harness = createGraphViewHarness(GraphView, { bridge });
  try {
    const { view } = harness;
    await view.load('/repo');
    bridge.snapshot = 'cdcd8888';
    let release;
    bridge.gate = new Promise(resolve => { release = resolve; });
    const staged = view.load('/repo', { preserveViewport: true });
    await settle();
    const other = linearHistory(3, 'o');
    bridge.commits = other;
    bridge.refs = refsFor(other);
    bridge.snapshot = 'efef9999';
    const replacement = view.load('/other');
    release();
    bridge.gate = null;
    await Promise.all([staged, replacement]);

    assert.equal(view.repoPath, '/other');
    assert.deepEqual(view.rows.map(row => row.commit.hash), other.map(entry => entry.hash));
    assert.equal(view.snapshot, 'efef9999');
  } finally {
    harness.restore();
  }
});

test('typing in the history filter re-filters once after the query settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commits = linearHistory(600);
  const bridge = createSnapshotBridge({ commits, refs: refsFor(commits), snapshot: '12341234' });
  const harness = createGraphViewHarness(GraphView, { bridge });
  try {
    const { view, controls } = harness;
    await view.load('/repo');
    await loadAll(view);
    let filters = 0;
    const original = view.applyFilter;
    view.applyFilter = function countedApplyFilter() {
      filters += 1;
      return original.call(this);
    };
    const input = controls['history-filter-query'];
    for (const value of ['s', 'su', 'sub', 'subject c002']) {
      input.value = value;
      input.dispatch('input');
    }
    t.mock.timers.tick(149);
    assert.equal(filters, 0);
    assert.equal(view.filters.query, '');

    t.mock.timers.tick(1);
    assert.equal(filters, 1);
    assert.equal(view.filters.query, 'subject c002');
    assert.deepEqual(
      view.visibleRows.map(row => row.commit.hash),
      commits.filter(entry => entry.subject.includes('subject c002')).map(entry => entry.hash)
    );
    assert.equal(view.visibleRows.length, 16);

    input.value = 'subject 2';
    input.dispatch('input');
    controls['history-filter-clear'].dispatch('click');
    t.mock.timers.tick(500);
    assert.equal(filters, 2, 'clearing cancels the pending query');
    assert.equal(view.filters.query, '');
    assert.equal(view.visibleRows.length, 600);
  } finally {
    harness.restore();
  }
});

test('progressive scrolling reuses row content and rebuilds only entering rows', async () => {
  const commits = linearHistory(1200);
  const bridge = createSnapshotBridge({ commits, refs: refsFor(commits), snapshot: '56785678' });
  const harness = createGraphViewHarness(GraphView, { bridge });
  try {
    const { view } = harness;
    await view.load('/repo');
    scrollToRow(harness, 100);
    view.renderViewport(true);
    const svgByHash = new Map(view.layer.children.map(row => [row.dataset.hash, row.children[0].children[0]]));
    let svgBuilds = 0;
    const original = view.createGraphSvg;
    view.createGraphSvg = function countedSvg(...args) {
      svgBuilds += 1;
      return original.apply(this, args);
    };

    harness.container.scrollTop += ROW_HEIGHT * 3;
    view.renderViewport();

    assert.equal(svgBuilds, 3);
    const kept = view.layer.children.filter(row => svgByHash.has(row.dataset.hash));
    assert.ok(kept.length > 20);
    assert.ok(kept.every(row => row.children[0].children[0] === svgByHash.get(row.dataset.hash)));

    // Content-affecting changes refresh reused rows in place.
    view.mergeRefs([{ fullName: 'refs/tags/v1', shortName: 'v1', type: 'tag', commit: kept[0].dataset.hash, upstream: '' }]);
    view.dataRevision += 1;
    view.renderViewport();
    const tagged = view.layer.children.find(row => row.dataset.hash === kept[0].dataset.hash);
    assert.equal(tagged, kept[0]);
    assert.deepEqual(tagged.children[1].children[0].children.map(badge => badge.textContent), ['v1']);
  } finally {
    harness.restore();
  }
});
