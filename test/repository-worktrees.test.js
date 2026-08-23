const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { RepositoryWorktrees } = require('../src/main/git/repository-worktrees.mts');

test('parses complete porcelain worktree state', async () => {
  const worktrees = new RepositoryWorktrees({
    git: {
      raw: async () => [
        'worktree C:/repo',
        'HEAD abcdef',
        'branch refs/heads/main',
        '',
        'worktree C:/linked',
        'HEAD 123456',
        'detached',
        'locked agent running',
        'prunable stale metadata',
        ''
      ].join('\n')
    },
    repoPath: path.resolve('repo'),
    assertNoPendingOperation: async () => {},
    assertValidBranchName: async value => value,
    assertCommitish: async value => value
  });

  assert.deepEqual(await worktrees.list(), [
    {
      path: 'C:/repo', head: 'abcdef', branch: 'main',
      detached: false, locked: false, lockReason: '', prunable: false, pruneReason: ''
    },
    {
      path: 'C:/linked', head: '123456', branch: '',
      detached: true, locked: true, lockReason: 'agent running',
      prunable: true, pruneReason: 'stale metadata'
    }
  ]);
});

test('creates new and existing-branch worktrees with explicit base semantics', async () => {
  const calls = [];
  const worktrees = new RepositoryWorktrees({
    git: { raw: async args => { calls.push(args); } },
    repoPath: path.resolve('repo'),
    assertNoPendingOperation: async () => calls.push(['pending']),
    assertValidBranchName: async value => calls.push(['branch', value]),
    assertCommitish: async value => calls.push(['base', value])
  });
  const first = path.resolve('linked-new');
  const second = path.resolve('linked-existing');

  assert.deepEqual(
    await worktrees.create({ directory: first, branch: 'feature/new', baseRef: 'main' }),
    { success: true, path: first, branch: 'feature/new', baseRef: 'main', createdBranch: true }
  );
  assert.deepEqual(
    await worktrees.create({ directory: second, branch: 'release', createBranch: false }),
    { success: true, path: second, branch: 'release', baseRef: 'release', createdBranch: false }
  );
  assert.deepEqual(calls, [
    ['pending'], ['branch', 'feature/new'], ['base', 'main'],
    ['worktree', 'add', '-b', 'feature/new', first, 'main'],
    ['pending'], ['branch', 'release'],
    ['worktree', 'add', second, 'release']
  ]);
});

test('locks, unlocks and refuses unsafe worktree directories', async () => {
  const calls = [];
  const worktrees = new RepositoryWorktrees({
    git: { raw: async args => calls.push(args) },
    repoPath: path.resolve('repo'),
    assertNoPendingOperation: async () => {},
    assertValidBranchName: async () => {},
    assertCommitish: async () => {}
  });

  await assert.rejects(
    worktrees.create({ directory: 'relative', branch: 'topic', baseRef: 'main' }),
    /Invalid worktree directory/
  );
  await worktrees.lock(path.resolve('linked'), 'agent running');
  await worktrees.unlock(path.resolve('linked'));
  assert.deepEqual(calls, [
    ['worktree', 'lock', '--reason', 'agent running', path.resolve('linked')],
    ['worktree', 'unlock', path.resolve('linked')]
  ]);
});

test('parses dirty and synchronization state without exposing file contents', () => {
  const worktrees = new RepositoryWorktrees({
    git: { raw: async () => '' }, repoPath: path.resolve('repo'),
    assertNoPendingOperation: async () => {}, assertValidBranchName: async () => {},
    assertCommitish: async () => {}
  });
  assert.deepEqual(worktrees.parseStatus([
    '# branch.oid abc', '# branch.head main', '# branch.ab +3 -2',
    '1 .M N... 100644 100644 100644 abc abc file.txt', '? new.txt'
  ].join('\n')), { dirty: true, changes: 2, ahead: 3, behind: 2 });
});
