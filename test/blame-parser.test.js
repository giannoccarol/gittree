const test = require('node:test');
const assert = require('node:assert/strict');

const { parseBlamePorcelain } = require('../src/main/git/blame-parser.mts');

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

const SAMPLE = [
  `${HASH_A} 1 1 2`,
  'author Ada Lovelace',
  'author-mail <ada@example.com>',
  'author-time 1755600000',
  'author-tz +0200',
  'committer Ada Lovelace',
  'committer-mail <ada@example.com>',
  'committer-time 1755600000',
  'committer-tz +0200',
  'summary feat: first line',
  'boundary',
  'filename file.txt',
  '\tfirst content line',
  `${HASH_B} 2 2`,
  'author Grace Hopper',
  'summary fix: second line',
  '\tsecond content line'
].join('\n');

test('parses porcelain records and skips content lines', () => {
  const rows = parseBlamePorcelain(SAMPLE);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    hash: HASH_A,
    originalLine: 1,
    finalLine: 1,
    author: 'Ada Lovelace',
    summary: 'feat: first line'
  });
  assert.deepEqual(rows[1], {
    hash: HASH_B,
    originalLine: 2,
    finalLine: 2,
    author: 'Grace Hopper',
    summary: 'fix: second line'
  });
});

test('tolerates empty and malformed input', () => {
  assert.deepEqual(parseBlamePorcelain(''), []);
  assert.deepEqual(parseBlamePorcelain(null), []);
  assert.deepEqual(parseBlamePorcelain('random lines\n\twithout records'), []);
});

test('keeps the author empty when porcelain omits metadata', () => {
  const rows = parseBlamePorcelain(`${'1'.repeat(40)} 1 1\n\tcontent`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].author, '');
  assert.equal(rows[0].summary, '');
});
