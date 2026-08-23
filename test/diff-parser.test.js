const test = require('node:test');
const assert = require('node:assert/strict');
let DiffParser;
try {
  const mod = require('../src/renderer/components/diff-parser.mts');
  DiffParser = mod.DiffParser || mod.default || mod;
} catch {
  DiffParser = require('../src/renderer/components/diff-parser');
}

const PATCH = [
  'diff --git a/example.txt b/example.txt',
  'index 1111111..2222222 100644',
  '--- a/example.txt',
  '+++ b/example.txt',
  '@@ -8,4 +8,5 @@ heading',
  ' context',
  '-removed',
  '+added',
  '+another',
  ' tail',
  '\\ No newline at end of file'
].join('\n');

test('unified parser assigns exact old and new line numbers', () => {
  const rows = DiffParser.parseUnified(PATCH);
  const numbered = rows.filter(row => ['context', 'del', 'add'].includes(row.kind));

  assert.deepEqual(
    numbered.map(row => [row.kind, row.oldLine, row.newLine]),
    [
      ['context', 8, 8],
      ['del', 9, null],
      ['add', null, 9],
      ['add', null, 10],
      ['context', 10, 11]
    ]
  );
  assert.equal(rows.at(-1).kind, 'no-newline');
  assert.equal(rows.at(-1).oldLine, null);
  assert.equal(rows.at(-1).newLine, null);
});

test('split parser pairs replacements without losing either counter', () => {
  const rows = DiffParser.parseSplit(PATCH);
  const pairs = rows.filter(row => row.type === 'pair');

  assert.deepEqual(
    pairs.map(row => [
      row.left.kind,
      row.left.oldLine,
      row.right.kind,
      row.right.newLine
    ]),
    [
      ['context', 8, 'context', 8],
      ['del', 9, 'add', 9],
      ['empty', null, 'add', 10],
      ['context', 10, 'context', 11]
    ]
  );
});

test('numberHunk supports initial commits and never counts metadata', () => {
  const rows = DiffParser.numberHunk({
    oldRange: { start: 0, count: 0 },
    newRange: { start: 1, count: 2 },
    lines: ['+first', '+second', '\\ No newline at end of file']
  });

  assert.deepEqual(rows.map(row => [row.oldLine, row.newLine]), [
    [null, 1],
    [null, 2],
    [null, null]
  ]);
});

test('file content resembling patch headers still receives line numbers inside a hunk', () => {
  const rows = DiffParser.parseUnified([
    '--- a/example.txt',
    '+++ b/example.txt',
    '@@ -1 +1 @@',
    '--- deleted content beginning with two dashes',
    '+++ added content beginning with two pluses'
  ].join('\n'));

  assert.deepEqual(
    rows.slice(-2).map(row => [row.kind, row.oldLine, row.newLine]),
    [['del', 1, null], ['add', null, 1]]
  );
});
