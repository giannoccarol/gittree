const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository, git } = require('./helpers/git-repository');

function commit(cwd, file, content, message) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', message);
}

/** Leaves `cwd` in a conflicted merge of `branch` into its current branch. */
function startConflictedMerge(cwd, branch) {
  assert.throws(() => git(cwd, 'merge', '--no-ff', branch));
}

function createConflictingBranches(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  commit(repo.repository, 'conflict.txt', 'base\n', 'base');
  repo.git('branch', 'theirs');
  repo.git('switch', 'theirs');
  commit(repo.repository, 'conflict.txt', 'theirs\n', 'theirs');
  repo.git('switch', 'main');
  return repo;
}

test('a reused service sees operations started after its first state read', async t => {
  const repo = createConflictingBranches(t);
  const service = new GitService(repo.repository);
  assert.deepEqual(await service.getOperationState(), {
    type: null,
    conflicts: [],
    canContinue: false
  });
  await service.getWorkingTree();

  repo.git('switch', '-c', 'ours');
  commit(repo.repository, 'conflict.txt', 'ours\n', 'ours');
  startConflictedMerge(repo.repository, 'theirs');
  assert.deepEqual(await service.getOperationState(), {
    type: 'merge',
    conflicts: ['conflict.txt'],
    canContinue: false
  });
  await assert.rejects(service.getWorkingTree(), /pending merge/);
  assert.equal(
    await service.resolveGitPath('MERGE_HEAD'),
    path.join(fs.realpathSync(repo.repository), '.git', 'MERGE_HEAD')
  );
  await service.abortOperation();
  assert.equal((await service.getOperationState()).type, null);
});

test('a linked worktree re-created with another admin directory keeps detecting its state', async t => {
  const repo = createConflictingBranches(t);
  const first = path.join(repo.root, 'a', 'linked');
  const second = path.join(repo.root, 'b', 'linked');
  repo.git('worktree', 'add', '-b', 'first-work', first, 'main');
  // The admin directory `linked` is taken, so this worktree gets `linked1`.
  repo.git('worktree', 'add', '-b', 'second-work', second, 'main');
  const service = new GitService(second);
  assert.match(await service.resolveGitPath('MERGE_HEAD'), /worktrees[\\/]linked1[\\/]MERGE_HEAD$/);
  assert.equal((await service.getOperationState()).type, null);

  repo.git('worktree', 'remove', '--force', second);
  repo.git('worktree', 'remove', '--force', first);
  repo.git('worktree', 'add', second, 'second-work');
  assert.match(await service.resolveGitPath('MERGE_HEAD'), /worktrees[\\/]linked[\\/]MERGE_HEAD$/);

  commit(second, 'conflict.txt', 'second\n', 'second');
  startConflictedMerge(second, 'theirs');
  assert.equal((await service.getOperationState()).type, 'merge');
  assert.equal((await new GitService(repo.repository).getOperationState()).type, null);
});

test('state paths still resolve when the repository metadata is missing or replaced', async t => {
  const repo = createConflictingBranches(t);
  const service = new GitService(repo.repository);
  assert.equal((await service.getOperationState()).type, null);

  const moved = path.join(repo.root, 'moved.git');
  fs.renameSync(path.join(repo.repository, '.git'), moved);
  await assert.rejects(service.getOperationState());

  // `.git` becomes a gitdir file that points at the moved directory.
  fs.writeFileSync(path.join(repo.repository, '.git'), `gitdir: ${moved}\n`);
  assert.equal(
    await service.resolveGitPath('MERGE_HEAD'),
    path.join(fs.realpathSync(moved), 'MERGE_HEAD')
  );
  repo.git('switch', '-c', 'ours');
  commit(repo.repository, 'conflict.txt', 'ours\n', 'ours');
  startConflictedMerge(repo.repository, 'theirs');
  assert.equal((await service.getOperationState()).type, 'merge');
});
