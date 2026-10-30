const test = require('node:test');
const assert = require('node:assert/strict');
const { createElement, installGraphViewDom } = require('./helpers/graph-view-harness');
const { DiffRenderer } = require('../src/renderer/components/diff-renderer.mts');

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findAll(root, className) {
  const found = [];
  walk(root, node => {
    if (node.classList?.contains(className)) found.push(node);
  });
  return found;
}

function text(node) {
  if (!node) return '';
  if (!node.children?.length) return String(node.textContent ?? '');
  return node.children.map(text).join('');
}

function setup({ clientHeight = 600, createFileActions = null } = {}) {
  const dom = installGraphViewDom();
  global.window.setTimeout = setTimeout;
  global.window.clearTimeout = clearTimeout;
  const body = createElement('div');
  body.clientHeight = clientHeight;
  const renderer = new DiffRenderer({
    body,
    translate: key => key,
    createFileActions,
    prefersReducedMotion: () => true
  });
  return { ...dom, body, renderer };
}

const SMALL_PATCH = [
  'diff --git a/src/app.js b/src/app.js',
  'index 111..222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-const value = 1;',
  '+const value = 2;',
  ' end',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  'index 000..333',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1 @@',
  '+hello'
].join('\n');

function largePatch(lines) {
  const rows = ['diff --git a/big.txt b/big.txt', '--- a/big.txt', '+++ b/big.txt', `@@ -1,${lines} +1,${lines} @@`];
  for (let index = 0; index < lines; index += 1) rows.push(` line ${index}`);
  return rows.join('\n');
}

test('unified rendering groups lines by file with numbers and word highlights', () => {
  const { body, renderer, restore } = setup({
    createFileActions: path => {
      const action = createElement('button');
      action.className = 'file-action';
      action.textContent = `act:${path}`;
      return [action];
    }
  });
  try {
    renderer.render(SMALL_PATCH, { mode: 'unified', wordLevel: true });
    const blocks = findAll(body, 'diff-file-block');
    assert.deepEqual(blocks.map(block => block.dataset.filePath), ['src/app.js', 'README.md']);
    assert.equal(text(findAll(blocks[0], 'diff-file-path')[0]), 'src/app.js');
    assert.equal(findAll(blocks[0], 'file-action')[0].textContent, 'act:src/app.js');

    const lines = findAll(blocks[0], 'diff-line');
    const kinds = lines.map(line => line.className.replace('diff-line ', ''));
    assert.deepEqual(kinds, ['header', 'header', 'header', 'hunk', 'context', 'del', 'add', 'context']);
    const added = lines[6];
    assert.deepEqual(findAll(added, 'diff-line-num').map(number => number.textContent), ['', '2']);
    // Characterized as-is: the +/- marker is part of the compared text.
    assert.equal(findAll(added, 'diff-word')[0].textContent, '+const value = 2');
    assert.equal(body.style['--diff-gutter-digits'], '1');
  } finally {
    restore();
  }
});

test('word highlighting can be turned off', () => {
  const { body, renderer, restore } = setup();
  try {
    renderer.render(SMALL_PATCH, { mode: 'unified', wordLevel: false });
    assert.equal(findAll(body, 'diff-word').length, 0);
  } finally {
    restore();
  }
});

test('split rendering pairs removed and added lines in two columns', () => {
  const { body, renderer, restore } = setup();
  try {
    renderer.render(SMALL_PATCH, { mode: 'split', wordLevel: true });
    assert.equal(body.children[0].className, 'diff-split');
    const columns = findAll(body, 'diff-split-columns');
    assert.ok(columns.length >= 2);
    const firstFileLines = findAll(columns[0], 'diff-line');
    assert.equal(firstFileLines.length % 2, 0);
    const pair = firstFileLines.slice(2, 4).map(line => line.className);
    assert.deepEqual(pair, ['diff-line del', 'diff-line add']);
  } finally {
    restore();
  }
});

test('an empty patch renders the no-changes placeholder', () => {
  const { body, renderer, restore } = setup();
  try {
    renderer.render('', { mode: 'unified', wordLevel: true });
    assert.equal(body.children.length, 1);
    assert.equal(body.children[0].className, 'diff-placeholder');
    assert.equal(body.children[0].children[0].className, 'ph ph-check-circle');
    assert.equal(body.children[0].children[1].textContent, 'details.noChanges');
  } finally {
    restore();
  }
});

test('large patches are virtualized and render only rows near the viewport', () => {
  const { body, renderer, restore } = setup({ clientHeight: 600 });
  try {
    renderer.render(largePatch(5000), { mode: 'unified', wordLevel: true });
    assert.ok(body.classList.contains('diff-virtualized'));
    const layer = body.children[0];
    assert.equal(layer.className, 'diff-virtual-layer');
    assert.ok(Number.parseFloat(layer.style.height) > 5000 * 22);
    const rendered = findAll(layer, 'diff-line').length;
    assert.ok(rendered > 20 && rendered < 120, `rendered ${rendered} lines`);
  } finally {
    restore();
  }
});

test('virtualized scrolling rebuilds rows only when the viewport nears the rendered edge', () => {
  const { body, renderer, restore } = setup({ clientHeight: 600 });
  try {
    renderer.render(largePatch(5000), { mode: 'unified', wordLevel: true });
    const layer = body.children[0];
    let rebuilds = 0;
    const replace = layer.replaceChildren;
    layer.replaceChildren = (...nodes) => { rebuilds += 1; return replace(...nodes); };

    for (let step = 1; step <= 9; step += 1) {
      body.scrollTop = step * 22;
      renderer.renderVirtualViewport();
    }
    assert.equal(rebuilds, 0, 'small scroll steps reuse the rendered rows');

    body.scrollTop = 400;
    renderer.renderVirtualViewport();
    assert.equal(rebuilds, 1);
    const first = findAll(layer, 'diff-line')
      .map(line => Number.parseFloat(line.style.top))
      .sort((left, right) => left - right)[0];
    assert.ok(first <= 400 - 220, 'rows above the viewport stay rendered after a rebuild');

    body.clientHeight = 800;
    renderer.renderVirtualViewport();
    assert.equal(rebuilds, 2, 'a resized viewport renders again');
  } finally {
    restore();
  }
});
