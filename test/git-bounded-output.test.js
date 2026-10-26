const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readBoundedGitOutput } = require('../src/main/git/bounded-git-output.mts');
const { createRepository } = require('./helpers/git-repository');

function createLargeCommit(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('large.txt', Array.from({ length: 5000 }, (_, index) => `line ${index}`).join('\n'));
  repo.git('add', '.');
  repo.git('commit', '-m', 'large file');
  return repo;
}

test('bounded git output returns the complete text below the limit', async t => {
  const repo = createLargeCommit(t);
  const expected = execFileSync('git', ['show', '--format=', 'HEAD'], {
    cwd: repo.repository,
    encoding: 'utf8'
  });

  const output = await readBoundedGitOutput(repo.repository, ['show', '--format=', 'HEAD'], 10 * 1024 * 1024);

  assert.equal(output.truncated, false);
  assert.equal(output.text, expected);
});

test('bounded git output stops at the limit on a complete line', async t => {
  const repo = createLargeCommit(t);

  const output = await readBoundedGitOutput(repo.repository, ['show', '--format=', 'HEAD'], 1024);

  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.text) <= 1024);
  assert.ok(output.text.endsWith('\n'));
  assert.match(output.text, /^diff --git a\/large\.txt b\/large\.txt/);
});

test('bounded git output rejects with the Git error message', async t => {
  const repo = createLargeCommit(t);

  await assert.rejects(
    readBoundedGitOutput(repo.repository, ['show', 'does-not-exist'], 1024),
    /does-not-exist|unknown revision|bad revision/
  );
});
