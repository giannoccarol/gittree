const test = require('node:test');
const assert = require('node:assert/strict');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');

function createConflictingRepository(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('conflict.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  repo.git('switch', '-c', 'feature');
  repo.write('conflict.txt', 'feature\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'feature change');
  repo.git('switch', 'main');
  repo.write('conflict.txt', 'main\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'main change');
  return repo;
}

test('merge conflicts expose real stage content and continue after a manual resolution', async t => {
  const repo = createConflictingRepository(t);
  const service = new GitService(repo.repository);

  await assert.rejects(service.merge('feature', 'noff'), /Failed to merge/);
  const pending = await service.getOperationState();
  assert.deepEqual(pending, {
    type: 'merge',
    conflicts: ['conflict.txt'],
    canContinue: false
  });

  const conflict = await service.readConflict('conflict.txt');
  assert.equal(conflict.binary, false);
  assert.equal(conflict.base, 'base\n');
  assert.equal(conflict.ours, 'main\n');
  assert.equal(conflict.theirs, 'feature\n');
  assert.equal(conflict.current, 'main\n');
  assert.equal(conflict.incoming, 'feature\n');
  assert.match(conflict.snapshotId, /^[a-f0-9]{64}$/);
  assert.equal(conflict.blocks.length, 1);
  assert.equal(conflict.blocks[0].current.trim(), 'main');
  assert.equal(conflict.blocks[0].incoming.trim(), 'feature');

  await service.resolveConflict('conflict.txt', {
    strategy: 'manual',
    snapshotId: conflict.snapshotId,
    content: 'resolved\n'
  });
  assert.equal((await service.getOperationState()).canContinue, true);
  await service.continueOperation();

  assert.equal((await service.getOperationState()).type, null);
  assert.equal(repo.git('show', 'HEAD:conflict.txt'), 'resolved');
});

test('an in-progress merge can be aborted without changing the current branch', async t => {
  const repo = createConflictingRepository(t);
  const service = new GitService(repo.repository);

  await assert.rejects(service.merge('feature', 'noff'));
  await service.abortOperation();

  assert.equal((await service.getOperationState()).type, null);
  assert.equal(repo.git('branch', '--show-current'), 'main');
  assert.equal(repo.git('show', 'HEAD:conflict.txt'), 'main');
});

test('rebase conflicts use Git stage semantics and can continue with the rebased commit', async t => {
  const repo = createConflictingRepository(t);
  repo.git('switch', 'feature');
  const service = new GitService(repo.repository);

  await assert.rejects(service.rebaseOnto('main'), /Failed to rebase/);
  assert.equal((await service.getOperationState()).type, 'rebase');

  const conflict = await service.readConflict('conflict.txt');
  assert.equal(conflict.ours, 'main\n');
  assert.equal(conflict.theirs, 'feature\n');

  await service.resolveConflict('conflict.txt', {
    strategy: 'theirs',
    snapshotId: conflict.snapshotId
  });
  await service.continueOperation();

  assert.equal((await service.getOperationState()).type, null);
  assert.equal(repo.git('show', 'HEAD:conflict.txt'), 'feature');
});

test('binary conflicts reject manual text and repository paths cannot escape the worktree', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('image.bin', Buffer.from([0, 1, 2]));
  repo.git('add', '.');
  repo.git('commit', '-m', 'base binary');
  repo.git('switch', '-c', 'feature');
  repo.write('image.bin', Buffer.from([0, 3, 4]));
  repo.git('add', '.');
  repo.git('commit', '-m', 'feature binary');
  repo.git('switch', 'main');
  repo.write('image.bin', Buffer.from([0, 5, 6]));
  repo.git('add', '.');
  repo.git('commit', '-m', 'main binary');

  const service = new GitService(repo.repository);
  await assert.rejects(service.merge('feature', 'noff'));
  assert.equal((await service.readConflict('image.bin')).binary, true);
  await assert.rejects(
    service.resolveConflict('image.bin', {
      strategy: 'manual',
      snapshotId: (await service.readConflict('image.bin')).snapshotId,
      content: 'text'
    }),
    /Binary conflicts/
  );
  await assert.rejects(service.readConflict('../outside.txt'), /outside the repository/);
  await service.abortOperation();
});

test('conflict resolution rejects stale snapshots and unresolved markers', async t => {
  const repo = createConflictingRepository(t);
  const service = new GitService(repo.repository);
  await assert.rejects(service.merge('feature', 'noff'));
  const conflict = await service.readConflict('conflict.txt');

  await assert.rejects(
    service.resolveConflict('conflict.txt', {
      strategy: 'manual',
      snapshotId: '0'.repeat(64),
      content: 'resolved\n'
    }),
    /changed externally/i
  );
  await assert.rejects(
    service.resolveConflict('conflict.txt', {
      strategy: 'manual',
      snapshotId: conflict.snapshotId,
      content: conflict.result
    }),
    /unresolved conflict markers/i
  );
  assert.deepEqual((await service.getOperationState()).conflicts, ['conflict.txt']);
  await service.abortOperation();
});
