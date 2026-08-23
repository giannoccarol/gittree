const test = require('node:test');
const assert = require('node:assert/strict');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');

function createDivergedRepository(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('base.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  repo.git('switch', '-c', 'source');
  repo.write('first.txt', 'first\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'first source');
  const first = repo.git('rev-parse', 'HEAD');
  repo.write('second.txt', 'second\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'second source');
  const second = repo.git('rev-parse', 'HEAD');
  repo.git('switch', 'main');
  repo.write('main.txt', 'main\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'main work');
  return { repo, first, second };
}

test('previews and cherry-picks selected commits parent-first regardless of selection order', async t => {
  const { repo, first, second } = createDivergedRepository(t);
  const service = new GitService(repo.repository);

  const preview = await service.previewCommitAction('cherry-pick', [second, first]);
  assert.equal(preview.allowed, true);
  assert.deepEqual(preview.commits.map(commit => commit.hash), [first, second]);
  assert.deepEqual(preview.files.sort(), ['first.txt', 'second.txt']);

  const result = await service.cherryPickCommits([second, first]);
  assert.equal(result.success, true);
  assert.equal(repo.git('log', '-2', '--format=%s'), 'second source\nfirst source');
});

test('rebase preview rejects HEAD and ancestor targets but accepts a diverged target', async t => {
  const { repo } = createDivergedRepository(t);
  const service = new GitService(repo.repository);
  const head = repo.git('rev-parse', 'HEAD');
  const ancestor = repo.git('rev-parse', 'HEAD~1');
  const source = repo.git('rev-parse', 'source');

  assert.equal(
    (await service.previewCommitAction('rebase', [head])).allowed,
    false
  );
  assert.match(
    (await service.previewCommitAction('rebase', [ancestor])).reason,
    /ancestor/i
  );
  assert.equal(
    (await service.previewCommitAction('rebase', [source])).allowed,
    true
  );
});

test('cherry-pick conflicts are recovered after service recreation and can be skipped', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('conflict.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  repo.git('switch', '-c', 'source');
  repo.write('conflict.txt', 'source\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'source change');
  const sourceCommit = repo.git('rev-parse', 'HEAD');
  repo.git('switch', 'main');
  repo.write('conflict.txt', 'main\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'main change');

  const service = new GitService(repo.repository);
  await assert.rejects(service.cherryPickCommits([sourceCommit]), /cherry-pick/i);
  const recovered = new GitService(repo.repository);
  assert.deepEqual(await recovered.getOperationState(), {
    type: 'cherry-pick',
    conflicts: ['conflict.txt'],
    canContinue: false
  });
  await recovered.skipOperation();
  assert.equal((await recovered.getOperationState()).type, null);
  assert.equal(repo.git('show', 'HEAD:conflict.txt'), 'main');
});

test('merge commits remain excluded from cherry-pick milestone', async t => {
  const { repo } = createDivergedRepository(t);
  repo.git('merge', '--no-ff', 'source', '-m', 'merge source');
  const mergeHash = repo.git('rev-parse', 'HEAD');
  const service = new GitService(repo.repository);

  const preview = await service.previewCommitAction('cherry-pick', [mergeHash]);
  assert.equal(preview.allowed, false);
  assert.match(preview.reason, /merge commit/i);
});
