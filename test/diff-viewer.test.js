const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadDiffViewer() {
  const filename = path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'diff-viewer.mts'
  );
  const buttons = new Map();
  const storage = new Map();
  global.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value)
  };
  global.document = {
    getElementById(id) {
      if (!buttons.has(id)) {
        buttons.set(id, {
          classList: { toggle() {} },
          setAttribute() {},
          onclick: null
        });
      }
      return buttons.get(id);
    }
  };
  global.window = { gitTree: {} };
  global.t = key => key;
  global.DiffParser = (() => {
    try {
      const mod = require(path.join(
        __dirname, '..', 'src', 'renderer', 'components', 'diff-parser.mts'
      ));
      return mod.DiffParser || mod.default || mod;
    } catch {
      return require(path.join(
        __dirname, '..', 'src', 'renderer', 'components', 'diff-parser.js'
      ));
    }
  })();
  const mod = require(filename);
  return mod.DiffViewer || mod.default || mod;
}

test('maximizing the inspector temporarily selects the side-by-side diff', () => {
  const DiffViewer = loadDiffViewer();
  const viewer = new DiffViewer({ innerHTML: '' }, {});

  assert.equal(viewer.mode, 'unified');
  viewer.setInspectorExpanded(true);
  assert.equal(viewer.mode, 'split');
  viewer.setInspectorExpanded(false);
  assert.equal(viewer.mode, 'unified');
});

test('diff display changes keep the detached inspector synchronized', () => {
  const DiffViewer = loadDiffViewer();
  let payloadUpdates = 0;
  const viewer = new DiffViewer(
    { innerHTML: '' },
    { pushInspectorPayload: () => { payloadUpdates += 1; } }
  );

  viewer.setMode('split');

  assert.equal(payloadUpdates, 1);
});

test('split diff pairs deletions and additions on the same visual rows', () => {
  const DiffViewer = loadDiffViewer();
  const viewer = new DiffViewer({ innerHTML: '' }, {});
  const rows = JSON.parse(JSON.stringify(viewer.parseSplitRows([
    'diff --git a/file.js b/file.js',
    'index 111..222 100644',
    '--- a/file.js',
    '+++ b/file.js',
    '@@ -1,2 +1 @@',
    '-old one',
    '-old two',
    '+new one',
    ' context'
  ].join('\n'))));
  const pairs = rows.filter(row => row.type === 'pair');

  assert.deepEqual(pairs[0], {
    type: 'pair',
    left: { content: '-old one', kind: 'del', oldLine: 1, newLine: null },
    right: { content: '+new one', kind: 'add', oldLine: null, newLine: 1 }
  });
  assert.deepEqual(pairs[1], {
    type: 'pair',
    left: { content: '-old two', kind: 'del', oldLine: 2, newLine: null },
    right: { content: '', kind: 'empty', oldLine: null, newLine: null }
  });
  assert.equal(pairs[2].left.content, ' context');
  assert.equal(pairs[2].right.content, ' context');
  assert.equal(pairs[2].left.oldLine, 3);
  assert.equal(pairs[2].right.newLine, 2);
});

test('commit diff summaries expose file status and line counts for inspector navigation', () => {
  const DiffViewer = loadDiffViewer();
  const viewer = new DiffViewer({ innerHTML: '' }, {});
  const summaries = viewer.extractFileSummaries([
    'diff --git a/src/old.js b/src/new.js',
    'similarity index 80%',
    'rename from src/old.js',
    'rename to src/new.js',
    '@@ -1 +1,2 @@',
    '-old',
    '+new',
    '+next',
    'diff --git a/README.md b/README.md',
    'new file mode 100644',
    '@@ -0,0 +1 @@',
    '+hello'
  ].join('\n'));

  assert.deepEqual(summaries, [
    {
      path: 'src/new.js', oldPath: 'src/old.js', status: 'R', additions: 2, deletions: 1
    },
    {
      path: 'README.md', oldPath: null, status: 'A', additions: 1, deletions: 0
    }
  ]);
});

function loadDiffViewerWithDom(bridge) {
  const { createElement, installGraphViewDom } = require('./helpers/graph-view-harness');
  const dom = installGraphViewDom({ bridge });
  const elements = new Map();
  global.document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, createElement('div'));
    return elements.get(id);
  };
  global.window.setTimeout = setTimeout;
  global.window.clearTimeout = clearTimeout;
  const mod = require(path.join(__dirname, '..', 'src', 'renderer', 'components', 'diff-viewer.mts'));
  const DiffViewer = mod.DiffViewer || mod.default || mod;
  return { DiffViewer, elements, restore: dom.restore };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a slower response for an earlier commit never replaces the newer selection', async () => {
  const pending = new Map();
  const bridge = {
    getCommitDetail(_repoPath, hash) {
      const entry = deferred();
      pending.set(hash, entry);
      return entry.promise;
    }
  };
  const { DiffViewer, elements, restore } = loadDiffViewerWithDom(bridge);
  try {
    const body = elements.get('detail-body') || global.document.getElementById('detail-body');
    const viewer = new DiffViewer(body, {});
    const first = viewer.showDiffForCommit('/repo', 'aaaaaaa1');
    const second = viewer.showDiffForCommit('/repo', 'bbbbbbb2');

    pending.get('bbbbbbb2').resolve({
      hash: 'bbbbbbb2', message: 'second', author_name: 'Ada', date: '2026-01-02T00:00:00Z',
      diff: 'diff --git a/b.txt b/b.txt\n@@ -0,0 +1 @@\n+b'
    });
    assert.equal(await second, true);
    pending.get('aaaaaaa1').resolve({
      hash: 'aaaaaaa1', message: 'first', author_name: 'Ada', date: '2026-01-01T00:00:00Z',
      diff: 'diff --git a/a.txt b/a.txt\n@@ -0,0 +1 @@\n+a'
    });
    assert.equal(await first, false);

    assert.equal(viewer.activeHash, 'bbbbbbb2');
    assert.match(viewer.currentDiff, /b\.txt/);
    assert.deepEqual(viewer.fileSummaries.map(file => file.path), ['b.txt']);
    assert.equal(global.document.getElementById('detail-title').textContent, 'second');
  } finally {
    restore();
  }
});

test('another view taking over the inspector releases the commit', async () => {
  const pending = new Map();
  const bridge = {
    getCommitDetail(_repoPath, hash) {
      const entry = deferred();
      pending.set(hash, entry);
      return entry.promise;
    }
  };
  const { DiffViewer, restore } = loadDiffViewerWithDom(bridge);
  try {
    const { InspectorPanel } = require('../src/renderer/components/inspector-panel.mts');
    const body = global.document.getElementById('detail-body');
    let viewer = null;
    const panel = new InspectorPanel({
      panel: global.document.getElementById('detail-panel'),
      title: global.document.getElementById('detail-title'),
      body,
      onKindChange: next => { if (next !== 'commit') viewer.releaseCommit(); }
    });
    viewer = new DiffViewer(body, {}, panel);

    const shown = viewer.showDiffForCommit('/repo', 'aaaaaaa1');
    pending.get('aaaaaaa1').resolve({
      hash: 'aaaaaaa1', message: 'commit', author_name: 'Ada', date: '2026-01-01T00:00:00Z',
      diff: 'diff --git a/a.txt b/a.txt\n@@ -0,0 +1 @@\n+a'
    });
    await shown;
    assert.equal(panel.kind, 'commit');
    assert.equal(global.document.getElementById('detail-meta').classList.contains('is-hidden'), false);

    const workingBody = panel.present('working-file', { title: 'b.txt' });
    const marker = { textContent: 'working file diff', className: 'working-diff' };
    workingBody.replaceChildren(marker);

    viewer.setMode('split');
    assert.deepEqual(body.children, [marker], 'a layout change does not bring the commit back');
    assert.equal(viewer.currentDiff, null);
    assert.deepEqual(viewer.fileSummaries, []);
    assert.equal(global.document.getElementById('detail-meta').classList.contains('is-hidden'), true);

    const late = viewer.showDiffForCommit('/repo', 'bbbbbbb2');
    panel.present('working-file', { title: 'b.txt' });
    workingBody.replaceChildren(marker);
    pending.get('bbbbbbb2').resolve({ hash: 'bbbbbbb2', message: 'late', diff: 'diff --git a/z b/z' });
    assert.equal(await late, false);
    assert.deepEqual(body.children, [marker], 'a commit still loading cannot replace the file diff');
  } finally {
    restore();
  }
});
