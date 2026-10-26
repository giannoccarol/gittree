const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');

test('working tree snapshot separates staged and unstaged files and supports file staging', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('tracked.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  repo.write('tracked.txt', 'base\nchanged\n');
  repo.write('new.txt', 'new\n');

  const service = new GitService(repo.repository);
  const before = await service.getWorkingTree();
  assert.equal(before.stagedCount, 0);
  assert.equal(before.unstagedCount, 2);
  assert.ok(before.snapshotId);

  await service.stagePaths(before.snapshotId, ['tracked.txt']);
  const staged = await service.getWorkingTree();
  assert.equal(staged.files.find(file => file.path === 'tracked.txt').staged, true);

  await service.unstagePaths(staged.snapshotId, ['tracked.txt']);
  const restored = await service.getWorkingTree();
  assert.equal(restored.files.find(file => file.path === 'tracked.txt').staged, false);
});

test('stages and unstages a regenerated hunk without accepting renderer patches', async t => {
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
  const before = await service.getWorkingTree();
  const diff = await service.getWorkingDiff('partial.txt', false);
  assert.equal(diff.binary, false);
  assert.equal(diff.hunks.length, 2);

  await service.stageHunks(before.snapshotId, 'partial.txt', [diff.hunks[0].id]);
  const stagedPatch = repo.git('diff', '--cached', '--', 'partial.txt');
  const remainingPatch = repo.git('diff', '--', 'partial.txt');
  assert.match(stagedPatch, /line 2 changed/);
  assert.doesNotMatch(stagedPatch, /line 22 changed/);
  assert.match(remainingPatch, /line 22 changed/);

  const stagedSnapshot = await service.getWorkingTree();
  const stagedDiff = await service.getWorkingDiff('partial.txt', true);
  await service.unstageHunks(
    stagedSnapshot.snapshotId,
    'partial.txt',
    [stagedDiff.hunks[0].id]
  );
  assert.equal(repo.git('diff', '--cached', '--', 'partial.txt'), '');
});

test('rejects staging when the working tree snapshot is stale', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('tracked.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  repo.write('tracked.txt', 'first change\n');

  const service = new GitService(repo.repository);
  const stale = await service.getWorkingTree();
  repo.write('tracked.txt', 'second change\n');

  await assert.rejects(
    service.stagePaths(stale.snapshotId, ['tracked.txt']),
    /working tree changed/i
  );
});

test('supports initial-commit hunk staging for untracked text and detects binary diffs', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('new.txt', 'first\r\nsecond\r\n');
  repo.write('image.bin', Buffer.from([0, 1, 2, 3, 4]));
  const service = new GitService(repo.repository);

  const snapshot = await service.getWorkingTree();
  const textDiff = await service.getWorkingDiff('new.txt', false);
  assert.equal(textDiff.hunks.length, 1);
  await service.stageHunks(snapshot.snapshotId, 'new.txt', [textDiff.hunks[0].id]);
  assert.match(repo.git('diff', '--cached', '--name-only'), /new\.txt/);

  const binaryDiff = await service.getWorkingDiff('image.bin', false);
  assert.equal(binaryDiff.binary, true);
  assert.equal(binaryDiff.hunks.length, 0);
});

// More files than the old 500-path cap, under a long folder name so the
// joined paths also exceed the ~32K-character Windows command-line limit.
const BULK_FILE_COUNT = 620;
const BULK_FOLDER = 'generated/a-deliberately-long-folder-name-for-bulk-working-tree-operations';

function writeBulkFiles(repo, folder, content) {
  const paths = [];
  for (let index = 0; index < BULK_FILE_COUNT; index += 1) {
    const relativePath = `${folder}/file-${String(index).padStart(4, '0')}.txt`;
    repo.write(relativePath, `${content} ${index}\n`);
    paths.push(relativePath);
  }
  // Names that must stay data, never options or separators.
  for (const name of ['-leading-dash.txt', 'spaced name ù.txt']) {
    repo.write(`${folder}/${name}`, `${content}\n`);
    paths.push(`${folder}/${name}`);
  }
  return paths;
}

function stagedNames(repo) {
  return repo.git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort();
}

test('stages and unstages more than 500 untracked files before the first commit', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const paths = writeBulkFiles(repo, BULK_FOLDER, 'new');
  const service = new GitService(repo.repository);

  const before = await service.getWorkingTree();
  const unstaged = before.files.filter(file => file.unstaged).map(file => file.path);
  assert.equal(unstaged.length, paths.length);

  const staged = await service.stagePaths(before.snapshotId, unstaged);
  assert.equal(staged.snapshot.stagedCount, paths.length);
  assert.deepEqual(stagedNames(repo), [...paths].sort());

  const stagedPaths = staged.snapshot.files.filter(file => file.staged).map(file => file.path);
  const restored = await service.unstagePaths(staged.snapshot.snapshotId, stagedPaths);
  assert.equal(restored.snapshot.stagedCount, 0);
  assert.deepEqual(stagedNames(repo), []);
});

test('stages, unstages and discards more than 500 tracked and untracked files', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const tracked = writeBulkFiles(repo, 'tracked', 'base');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  writeBulkFiles(repo, 'tracked', 'changed');
  const untracked = writeBulkFiles(repo, BULK_FOLDER, 'new');
  const service = new GitService(repo.repository);

  const before = await service.getWorkingTree();
  const allChanged = before.files.filter(file => file.unstaged).map(file => file.path);
  assert.equal(allChanged.length, tracked.length + untracked.length);

  const staged = await service.stagePaths(before.snapshotId, allChanged);
  assert.equal(staged.snapshot.stagedCount, allChanged.length);
  assert.deepEqual(stagedNames(repo), [...allChanged].sort());

  const stagedPaths = staged.snapshot.files.filter(file => file.staged).map(file => file.path);
  const unstaged = await service.unstagePaths(staged.snapshot.snapshotId, stagedPaths);
  assert.equal(unstaged.snapshot.stagedCount, 0);
  assert.deepEqual(stagedNames(repo), []);

  const toDiscard = unstaged.snapshot.files.filter(file => file.unstaged).map(file => file.path);
  const discarded = await service.discardPaths(unstaged.snapshot.snapshotId, toDiscard);
  assert.equal(discarded.snapshot.files.length, 0);
  assert.equal(repo.git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(fs.readFileSync(path.join(repo.repository, tracked[0]), 'utf8'), 'base 0\n');
  assert.equal(fs.existsSync(path.join(repo.repository, untracked[0])), false);
});
