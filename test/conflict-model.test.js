const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasUnresolvedMarkers,
  parseConflictBlocks,
  safeCombination
} = require('../src/main/conflict-model.mts');

test('conflict blocks preserve CRLF content and offsets for multiple conflicts', () => {
  const result = [
    'before',
    '<<<<<<< HEAD',
    'current one',
    '=======',
    'incoming one',
    '>>>>>>> feature',
    'middle',
    '<<<<<<< HEAD',
    'same',
    '||||||| base',
    'base',
    '=======',
    'same',
    '>>>>>>> feature',
    'after'
  ].join('\r\n');
  const blocks = parseConflictBlocks(result);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].current, 'current one\r\n');
  assert.equal(blocks[0].incoming, 'incoming one\r\n');
  assert.equal(blocks[1].base, 'base\r\n');
  assert.equal(blocks[1].smartCombination, 'same\r\n');
  assert.equal(result.slice(blocks[0].startOffset, blocks[0].endOffset).startsWith('<<<<<<<'), true);
  assert.equal(hasUnresolvedMarkers(result), true);
  assert.equal(hasUnresolvedMarkers('resolved\r\ncontent'), false);
});

test('smart combination is available only when one side is unchanged or both agree', () => {
  assert.equal(safeCombination('base\n', 'base\n', 'incoming\n'), 'incoming\n');
  assert.equal(safeCombination('base\n', 'current\n', 'base\n'), 'current\n');
  assert.equal(safeCombination(null, 'same\n', 'same\n'), 'same\n');
  assert.equal(safeCombination('base\n', 'current\n', 'incoming\n'), null);
});
