const test = require('node:test');
const assert = require('node:assert/strict');
const { createElement, installGraphViewDom } = require('./helpers/graph-view-harness');
const { InspectorGraph } = require('../src/renderer/components/inspector-graph.mts');

function snapshot(count, selectedHash = null) {
  return {
    revision: 1,
    laneCount: 1,
    selectedHash,
    rows: Array.from({ length: count }, (_, index) => ({
      hash: `hash${String(index).padStart(36, '0')}`,
      subject: `Commit ${index}`,
      lane: 0,
      parents: index < count - 1 ? [{ lane: 0 }] : [],
      refs: index === 0 ? [{ type: 'head', shortName: 'HEAD' }, { type: 'branch', shortName: 'main' }] : [],
      before: [index ? `hash${String(index).padStart(36, '0')}` : null]
    }))
  };
}

function setup() {
  const dom = installGraphViewDom();
  global.document.body = createElement('body');
  const container = createElement('div');
  container.clientHeight = 380;
  const calls = [];
  const graph = new InspectorGraph({
    container,
    translate: key => key,
    onSelect: hash => calls.push(['select', hash]),
    onNavigate: direction => calls.push(['navigate', direction])
  });
  graph.mount();
  return { ...dom, container, graph, calls };
}

function rowsOf(graph) {
  return graph.layer.children.filter(row => row.classList.contains('inspector-graph-row'));
}

test('the compact history lists each commit with its subject and first branch', () => {
  const { graph, restore } = setup();
  try {
    graph.update(snapshot(200));
    const first = rowsOf(graph).find(row => row.dataset.hash === graph.rows[0].hash);
    const parts = first.children.map(child => child.className);
    assert.deepEqual(parts, ['inspector-graph-lanes', 'badge badge-branch inspector-graph-ref', 'inspector-graph-subject']);
    assert.equal(first.children[2].textContent, 'Commit 0');
    assert.equal(first.style.transform, 'translate3d(0, 0px, 0)');
    assert.ok(rowsOf(graph).length < 40, 'rows are virtualized');
  } finally {
    restore();
  }
});

test('scrolling keeps visible rows attached and the selection is revealed', () => {
  const { graph, container, restore } = setup();
  try {
    graph.update(snapshot(200));
    container.scrollTop = 38 * 30;
    graph.renderViewport();
    const before = new Map(rowsOf(graph).map(row => [row.dataset.hash, row]));
    let removed = 0;
    const remove = graph.layer.removeChild;
    graph.layer.removeChild = node => { removed += 1; return remove(node); };
    container.scrollTop += 38 * 2;
    graph.renderViewport();
    assert.equal(removed, 0);
    assert.equal(rowsOf(graph).filter(row => before.get(row.dataset.hash) === row).length, before.size - 2);

    graph.update({ ...snapshot(200), selectedHash: graph.rows[150].hash });
    assert.ok(container.scrollTop <= 150 * 38 && container.scrollTop + container.clientHeight >= 151 * 38);
  } finally {
    restore();
  }
});

test('arrow keys ask the history to move and Enter selects the focused row', () => {
  const { graph, container, calls, restore } = setup();
  try {
    graph.update(snapshot(20));
    const prevented = [];
    const row = rowsOf(graph)[0];
    const key = (name, target) => container.dispatch('keydown', {
      key: name,
      target: target || container,
      preventDefault: () => prevented.push(name)
    });
    key('ArrowDown');
    key('ArrowUp');
    row.closest = () => row;
    key('Enter', row);
    assert.deepEqual(calls, [['navigate', 'older'], ['navigate', 'newer'], ['select', row.dataset.hash]]);
    assert.deepEqual(prevented, ['ArrowDown', 'ArrowUp', 'Enter']);
  } finally {
    restore();
  }
});
