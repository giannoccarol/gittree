const test = require('node:test');
const assert = require('node:assert/strict');
let DiffLayout;
try {
  const mod = require('../src/renderer/components/diff-layout.mts');
  DiffLayout = mod.DiffLayout || mod.default || mod;
} catch {
  DiffLayout = require('../src/renderer/components/diff-layout');
}

test('groups diff rows by file and preserves preamble rows', () => {
  const files = DiffLayout.groupRows([
    { kind: 'header', content: 'preamble' },
    { kind: 'file', content: 'diff --git a/a.js b/a.js' },
    { kind: 'add', content: '+one' },
    { kind: 'file', content: 'diff --git a/b.js b/b.js' },
    { kind: 'del', content: '-two' }
  ], {
    isFile: row => row.kind === 'file',
    pathForFile: row => row.content
  });

  assert.deepEqual(files.map(file => [file.path, file.rows.length]), [
    [null, 1],
    ['diff --git a/a.js b/a.js', 1],
    ['diff --git a/b.js b/b.js', 1]
  ]);
});

test('file layout gives stable absolute offsets and bounded visible files', () => {
  const layout = DiffLayout.layoutFiles([
    { header: { content: 'a' }, rows: [1, 2, 3] },
    { header: { content: 'b' }, rows: Array.from({ length: 100 }, () => 1) }
  ], { rowHeight: 22, headerHeight: 36, fileGap: 12 });

  assert.equal(layout.files[0].top, 0);
  assert.equal(layout.files[0].height, 102);
  assert.equal(layout.files[1].top, 114);
  assert.equal(layout.totalHeight, 2350);
  assert.deepEqual(
    DiffLayout.visibleFiles(layout.files, 120, 100, 0).map(file => file.top),
    [114]
  );
});
