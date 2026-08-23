const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConflictBlocks } = require('../src/main/conflict-model.mts');
let highlight;
try {
  highlight = require('../src/renderer/components/conflict-highlight.mts');
} catch {
  highlight = require('../src/renderer/components/conflict-highlight');
}

test('classifies a simple two-way block', () => {
  const content = 'line1\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nline9\n';
  const blocks = parseConflictBlocks(content);
  assert.equal(blocks.length, 1);

  const lines = highlight.buildHighlightLines(content, blocks);
  assert.deepEqual(lines.map(line => line.kind), [
    'plain', 'marker', 'current', 'separator', 'incoming', 'marker', 'plain'
  ]);
  assert.deepEqual(lines.map(line => line.text), [
    'line1', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> branch', 'line9'
  ]);
});

test('classifies a three-way block with base section', () => {
  const content = [
    'a',
    '<<<<<<< HEAD',
    'ours',
    '||||||| base',
    'original',
    '=======',
    'theirs',
    '>>>>>>> branch',
    'b'
  ].join('\n');
  const blocks = parseConflictBlocks(content);
  assert.equal(blocks.length, 1);
  assert.notEqual(blocks[0].base, null);

  const lines = highlight.buildHighlightLines(content, blocks);
  assert.deepEqual(lines.map(line => line.kind), [
    'plain', 'marker', 'current', 'marker', 'base', 'separator', 'incoming', 'marker', 'plain'
  ]);
});

test('classifies multiple blocks and keeps plain lines untouched', () => {
  const content = 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\nmiddle\n<<<<<<< HEAD\nx2\n=======\ny2\n>>>>>>> b\nz\n';
  const blocks = parseConflictBlocks(content);
  assert.equal(blocks.length, 2);

  const lines = highlight.buildHighlightLines(content, blocks);
  assert.deepEqual(lines.map(line => line.kind), [
    'plain', 'marker', 'current', 'separator', 'incoming', 'marker',
    'plain',
    'marker', 'current', 'separator', 'incoming', 'marker',
    'plain'
  ]);
});

test('handles empty sides inside a block', () => {
  const content = 'a\n<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> b\n';
  const blocks = parseConflictBlocks(content);
  assert.equal(blocks.length, 1);

  const lines = highlight.buildHighlightLines(content, blocks);
  assert.deepEqual(lines.map(line => line.kind), [
    'plain', 'marker', 'separator', 'incoming', 'marker'
  ]);
});

test('handles CRLF line endings', () => {
  const content = 'a\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> b\r\n';
  const blocks = parseConflictBlocks(content);
  assert.equal(blocks.length, 1);

  const lines = highlight.buildHighlightLines(content, blocks);
  assert.deepEqual(lines.map(line => line.kind), [
    'plain', 'marker', 'current', 'separator', 'incoming', 'marker'
  ]);
  assert.equal(lines[2].text, 'ours');
});

test('treats content without markers as fully plain', () => {
  const content = 'hello\nworld\n';
  const lines = highlight.buildHighlightLines(content, []);
  assert.deepEqual(lines.map(line => line.kind), ['plain', 'plain']);
  assert.equal(lines.length, 2);
});

test('stray marker-like text outside parsed blocks stays plain', () => {
  const content = '<<<<<<< not a real conflict\n=======\n>>>>>>>\n';
  const lines = highlight.buildHighlightLines(content, []);
  assert.deepEqual(lines.map(line => line.kind), ['plain', 'plain', 'plain']);
});
