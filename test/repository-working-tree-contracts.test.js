const test = require('node:test');
const assert = require('node:assert/strict');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');

test('normalizes status for staged, unstaged, untracked and renamed files', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('modified.txt', 'base\n');
  repo.write('rename-from.txt', 'rename me\n');
  repo.write('staged.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');

  repo.write('modified.txt', 'changed but unstaged\n');
  repo.write('staged.txt', 'changed and staged\n');
  repo.write('untracked.txt', 'new\n');
  repo.git('add', 'staged.txt');
  repo.git('mv', 'rename-from.txt', 'renamed.txt');

  const status = await new GitService(repo.repository).getStatus();

  assert.deepEqual(Object.keys(status).sort(), [
    'ahead',
    'behind',
    'conflicted',
    'created',
    'current',
    'deleted',
    'detached',
    'files',
    'isClean',
    'modified',
    'not_added',
    'renamed',
    'staged',
    'tracking'
  ].sort());
  assert.equal(status.current, 'main');
  assert.equal(status.detached, false);
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.equal(status.isClean, false);
  assert.ok(status.modified.includes('modified.txt'));
  assert.ok(status.staged.includes('staged.txt'));
  assert.ok(status.not_added.includes('untracked.txt'));
  assert.deepEqual(status.renamed, [{ from: 'rename-from.txt', to: 'renamed.txt' }]);
  assert.ok(status.files.every(file => (
    typeof file.path === 'string'
    && typeof file.index === 'string'
    && typeof file.working_dir === 'string'
  )));
});

test('guards snapshots and validates path lists through stagePaths', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('new.txt', 'new\n');
  const service = new GitService(repo.repository);

  await assert.rejects(
    service.stagePaths('not-a-snapshot', ['new.txt']),
    /Invalid working tree snapshot/
  );

  const { snapshotId } = await service.getWorkingTree();
  await service.assertWorkingTreeSnapshot(snapshotId);
  assert.deepEqual(service.validatePathList(['new.txt', 'new.txt']), ['new.txt']);
  await assert.rejects(
    service.stagePaths(snapshotId, []),
    /Select between 1 and 500 repository paths/
  );
  await assert.rejects(
    service.stagePaths(snapshotId, Array(501).fill('new.txt')),
    /Select between 1 and 500 repository paths/
  );
  await assert.rejects(
    service.stagePaths(snapshotId, ['../outside.txt']),
    /outside the repository/
  );

  const result = await service.stagePaths(snapshotId, ['new.txt', 'new.txt']);
  assert.equal(result.success, true);
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'new.txt');
});

test('unstages files in a repository without a first commit', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('initial.txt', 'initial content\n');
  const service = new GitService(repo.repository);

  const initial = await service.getWorkingTree();
  const staged = await service.stagePaths(initial.snapshotId, ['initial.txt']);
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'initial.txt');

  const result = await service.unstagePaths(staged.snapshot.snapshotId, ['initial.txt']);
  assert.equal(result.success, true);
  assert.equal(repo.git('diff', '--cached', '--name-only'), '');
  assert.equal(result.snapshot.files.find(file => file.path === 'initial.txt').untracked, true);
});

test('reports an index-only change as noDiff and never exposes raw patch hunks', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('tracked.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  repo.write('tracked.txt', 'staged change\n');
  repo.git('add', 'tracked.txt');
  const service = new GitService(repo.repository);

  const indexOnly = await service.getParsedWorkingDiff('tracked.txt', false);
  assert.deepEqual(indexOnly, {
    path: 'tracked.txt',
    staged: false,
    binary: false,
    hunks: [],
    noDiff: true,
    reason: 'working-tree-matches-index'
  });

  repo.write('tracked.txt', 'staged change\nunstaged change\n');
  const publicDiff = await service.getWorkingDiff('tracked.txt', false);
  assert.equal(publicDiff.path, 'tracked.txt');
  assert.equal(publicDiff.staged, false);
  assert.equal(publicDiff.binary, false);
  assert.ok(publicDiff.hunks.length > 0);
  assert.ok(publicDiff.hunks.every(hunk => !Object.hasOwn(hunk, 'raw')));
});

test('validates hunk IDs, deduplicates selections and rejects stale snapshots', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const original = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  repo.write('partial.txt', original);
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  repo.write(
    'partial.txt',
    original
      .replace('line 2\n', 'line 2 changed\n')
      .replace('line 22\n', 'line 22 changed\n')
  );
  const service = new GitService(repo.repository);
  const snapshot = await service.getWorkingTree();
  const diff = await service.getWorkingDiff('partial.txt', false);
  assert.equal(diff.hunks.length, 2);

  await assert.rejects(
    service.stageHunks(snapshot.snapshotId, 'partial.txt', []),
    /Select between 1 and 200 diff hunks/
  );
  await assert.rejects(
    service.stageHunks(snapshot.snapshotId, 'partial.txt', ['not-a-hash']),
    /Invalid diff hunk/
  );
  await assert.rejects(
    service.stageHunks(snapshot.snapshotId, 'partial.txt', ['0'.repeat(64)]),
    /Working tree changed; refresh Changes and try again/
  );

  const result = await service.stageHunks(
    snapshot.snapshotId,
    'partial.txt',
    [diff.hunks[0].id, diff.hunks[0].id]
  );
  assert.equal(result.success, true);
  assert.match(repo.git('diff', '--cached', '--', 'partial.txt'), /line 2 changed/);

  await assert.rejects(
    service.stageHunks(snapshot.snapshotId, 'partial.txt', [diff.hunks[1].id]),
    /Working tree changed; refresh Changes and try again/
  );
});

test('parses working patches through the stable GitService helper', t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const service = new GitService(repo.repository);
  const patch = [
    'diff --git a/file.txt b/file.txt',
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-old',
    '+new',
    ''
  ].join('\n');

  const parsed = service.parseWorkingDiff('file.txt', false, patch);

  assert.equal(parsed.path, 'file.txt');
  assert.equal(parsed.staged, false);
  assert.equal(parsed.binary, false);
  assert.equal(parsed.hunks.length, 1);
  assert.deepEqual(parsed.hunks[0].oldRange, { start: 1, lines: 2 });
  assert.deepEqual(parsed.hunks[0].newRange, { start: 1, lines: 2 });
  assert.deepEqual(
    parsed.hunks[0].lines.map(line => line.type),
    ['context', 'delete', 'add']
  );
  assert.match(parsed.hunks[0].id, /^[a-f0-9]{64}$/);
});
