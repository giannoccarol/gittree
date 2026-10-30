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
    assert.equal(findAll(blocks[0], 'path-directory')[0].textContent, 'src/');
    assert.equal(findAll(blocks[0], 'path-name')[0].textContent, 'app.js');
    assert.equal(text(findAll(blocks[0], 'diff-file-stats')[0]), '+1−1');
    assert.equal(findAll(blocks[1], 'diff-file-status')[0].className, 'diff-file-status is-a');
    assert.deepEqual(renderer.files.map(file => [file.path, file.status, file.additions, file.deletions]), [
      ['src/app.js', 'M', 1, 1],
      ['README.md', 'A', 1, 0]
    ]);
    assert.equal(findAll(blocks[0], 'file-action')[0].textContent, 'act:src/app.js');

    const lines = findAll(blocks[0], 'diff-line');
    const kinds = lines.map(line => line.className.replace('diff-line ', ''));
    assert.deepEqual(kinds, ['hunk', 'context', 'del', 'add', 'context'], 'index and ---/+++ lines are hidden');
    const added = lines[3];
    assert.deepEqual(findAll(added, 'diff-line-num').map(number => number.textContent), ['', '2']);
    assert.equal(findAll(added, 'diff-word')[0].textContent, '2');
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
    assert.deepEqual(firstFileLines.slice(2, 4).map(line => findAll(line, 'diff-word')[0]?.textContent), ['1', '2']);
    assert.equal(findAll(body, 'diff-file-block').length, 2);
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

test('renames, mode changes and binary files are described in the file header', () => {
  const { body, renderer, restore } = setup();
  try {
    renderer.render([
      'diff --git a/old/name.txt b/new/name.txt',
      'similarity index 90%',
      'rename from old/name.txt',
      'rename to new/name.txt',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/logo.png b/logo.png',
      'index 111..222 100644',
      'Binary files a/logo.png and b/logo.png differ'
    ].join('\n'), { mode: 'unified', wordLevel: true });
    const blocks = findAll(body, 'diff-file-block');
    assert.deepEqual(blocks.map(block => block.dataset.filePath), ['new/name.txt', 'run.sh', 'logo.png']);
    assert.equal(findAll(blocks[0], 'diff-file-status')[0].className, 'diff-file-status is-r');
    assert.equal(findAll(blocks[0], 'diff-file-note')[0].textContent, 'details.renamedFrom');
    assert.equal(findAll(blocks[1], 'diff-file-note')[0].textContent, '100644 → 100755');
    const binaryLines = findAll(blocks[2], 'diff-line');
    assert.equal(binaryLines.length, 1);
    assert.equal(text(findAll(binaryLines[0], 'diff-line-content')[0]), 'details.binaryFile');
    assert.equal(renderer.files[2].binary, true);
  } finally {
    restore();
  }
});

test('large split diffs keep removed and added lines on the same row', () => {
  const { body, renderer, restore } = setup({ clientHeight: 600 });
  try {
    const rows = ['diff --git a/big.txt b/big.txt', '@@ -1,1500 +1,1500 @@'];
    for (let index = 0; index < 1500; index += 1) rows.push(`-old ${index}`, `+new ${index}`);
    renderer.render(rows.join('\n'), { mode: 'split', wordLevel: true });
    assert.ok(body.classList.contains('diff-virtualized'));
    const columns = findAll(body, 'diff-split-columns');
    assert.ok(columns.length > 0);
    const [left, right] = columns[1].children;
    assert.equal(left.className, 'diff-line del');
    assert.equal(right.className, 'diff-line add');
  } finally {
    restore();
  }
});

test('a file header collapses and expands its lines; lock files start collapsed', () => {
  const { body, renderer, restore } = setup();
  try {
    const patch = [
      SMALL_PATCH,
      'diff --git a/package-lock.json b/package-lock.json',
      '@@ -1 +1 @@',
      '-{"lockfileVersion": 2}',
      '+{"lockfileVersion": 3}'
    ].join('\n');
    renderer.render(patch, { mode: 'unified', wordLevel: true });
    let blocks = findAll(body, 'diff-file-block');
    assert.equal(blocks[2].dataset.filePath, 'package-lock.json');
    assert.ok(blocks[2].classList.contains('is-collapsed'));
    assert.equal(findAll(blocks[2], 'diff-line').length, 0);
    assert.equal(findAll(blocks[2], 'diff-file-header')[0].getAttribute('aria-expanded'), 'false');

    renderer.toggleFile('src/app.js');
    blocks = findAll(body, 'diff-file-block');
    assert.ok(blocks[0].classList.contains('is-collapsed'));
    assert.equal(findAll(blocks[0], 'diff-line').length, 0);

    renderer.render(patch, { mode: 'split', wordLevel: true });
    blocks = findAll(body, 'diff-file-block');
    assert.ok(blocks[0].classList.contains('is-collapsed'), 'a layout change keeps collapsed files');

    renderer.toggleFile('src/app.js');
    blocks = findAll(body, 'diff-file-block');
    assert.equal(blocks[0].classList.contains('is-collapsed'), false);
    assert.ok(findAll(blocks[0], 'diff-line').length > 0);

    renderer.render(SMALL_PATCH, { mode: 'unified', wordLevel: true });
    assert.equal(renderer.collapsed.size, 0, 'a new patch starts expanded');
  } finally {
    restore();
  }
});
