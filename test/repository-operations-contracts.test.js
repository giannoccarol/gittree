const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { GitService } = require('../src/main/git-service.mts');
const { registerGitHandlers } = require('../src/main/ipc/git-handlers.mts');
const { createRepository } = require('./helpers/git-repository');

function commitAll(repo, message) {
  repo.git('add', '-A');
  repo.git('commit', '-m', message);
}

function createTrackedRepository(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('base.txt', 'base\n');
  commitAll(repo, 'base');
  return repo;
}

function createDivergedRepository(t) {
  const repo = createTrackedRepository(t);
  const base = repo.git('rev-parse', 'HEAD');
  repo.git('switch', '-c', 'source');
  repo.write('first.txt', 'first\n');
  commitAll(repo, 'first source');
  const first = repo.git('rev-parse', 'HEAD');
  repo.write('second.txt', 'second\n');
  commitAll(repo, 'second source');
  const second = repo.git('rev-parse', 'HEAD');
  repo.git('switch', 'main');
  repo.write('main.txt', 'main\n');
  commitAll(repo, 'main work');
  return { repo, base, first, second };
}

function createConflictRepository(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('conflict.txt', 'base\n');
  commitAll(repo, 'base');
  repo.git('switch', '-c', 'feature');
  repo.write('conflict.txt', 'feature\n');
  commitAll(repo, 'feature change');
  const featureCommit = repo.git('rev-parse', 'HEAD');
  repo.git('switch', 'main');
  repo.write('conflict.txt', 'main\n');
  commitAll(repo, 'main change');
  return { repo, featureCommit };
}

function conflictHandler(service, channel) {
  const registrations = [];
  registerGitHandlers({
    registerManagedRepoHandler(name, implementation) {
      registrations.push({ name, implementation });
    },
    getGitService() {
      return service;
    },
    sendToRenderer() {}
  });
  return registrations.find(item => item.name === channel).implementation;
}

test('empty operation state rejects recovery commands and the queue survives a failure', async t => {
  const repo = createTrackedRepository(t);
  const service = new GitService(repo.repository);

  assert.deepEqual(await service.getOperationState(), {
    type: null,
    conflicts: [],
    canContinue: false
  });
  await assert.rejects(service.continueOperation(), /No Git operation/);
  await assert.rejects(service.abortOperation(), /No Git operation/);
  await assert.rejects(service.skipOperation(), /Only rebase and cherry-pick/);

  const failed = service.merge('--invalid-ref');
  const queuedState = service.getOperationState();
  await assert.rejects(failed, /Invalid Git ref|Git ref not found/);
  assert.equal((await queuedState).type, null);
  await assert.rejects(service.merge('main', 'invalid'), /Invalid merge strategy/);
  assert.equal((await service.getStatus()).isClean, true);
});

test('merge preserves ff, noff and squash behavior', async t => {
  const repo = createTrackedRepository(t);
  const base = repo.git('rev-parse', 'HEAD');
  repo.git('switch', '-c', 'feature');
  repo.write('feature.txt', 'feature\n');
  commitAll(repo, 'feature');
  const feature = repo.git('rev-parse', 'HEAD');
  repo.git('switch', 'main');
  const service = new GitService(repo.repository);

  const ff = await service.merge('feature', 'ff');
  assert.equal(ff.strategy, 'ff');
  assert.equal(repo.git('rev-parse', 'HEAD'), feature);

  repo.git('reset', '--hard', base);
  const noff = await service.merge('feature', 'noff');
  assert.equal(noff.strategy, 'noff');
  assert.equal(repo.git('show', '-s', '--format=%P', 'HEAD').split(/\s+/).length, 2);

  repo.git('reset', '--hard', base);
  const squash = await service.merge('feature', 'squash');
  assert.equal(squash.strategy, 'squash');
  assert.equal(repo.git('rev-parse', 'HEAD'), base);
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'feature.txt');
});

test('merge permits non-overlapping local changes and rejects overlapping changes', async t => {
  const allowedRepo = createTrackedRepository(t);
  allowedRepo.git('switch', '-c', 'feature');
  allowedRepo.write('incoming.txt', 'feature\n');
  commitAll(allowedRepo, 'incoming');
  allowedRepo.git('switch', 'main');
  allowedRepo.write('local.txt', 'local\n');
  const allowed = await new GitService(allowedRepo.repository).merge('feature');
  assert.equal(allowed.success, true);
  assert.equal(fs.readFileSync(path.join(allowedRepo.repository, 'local.txt'), 'utf8'), 'local\n');

  const blockedRepo = createTrackedRepository(t);
  blockedRepo.git('switch', '-c', 'feature');
  blockedRepo.write('base.txt', 'feature\n');
  commitAll(blockedRepo, 'incoming overlap');
  blockedRepo.git('switch', 'main');
  blockedRepo.write('base.txt', 'local\n');
  await assert.rejects(
    new GitService(blockedRepo.repository).merge('feature'),
    /overwrite local changes in: base\.txt/
  );
});

test('rebase preflight covers dirty, detached, invalid and successful targets', async t => {
  const { repo } = createDivergedRepository(t);
  repo.git('switch', 'source');
  const service = new GitService(repo.repository);
  const main = repo.git('rev-parse', 'main');

  repo.write('dirty.txt', 'dirty\n');
  await assert.rejects(service.rebaseOnto('main'), /clean working tree/);
  assert.match(
    (await service.previewCommitAction('rebase', [main])).reason,
    /working tree must be clean/i
  );
  fs.rmSync(path.join(repo.repository, 'dirty.txt'));

  repo.git('switch', '--detach');
  assert.match(
    (await service.previewCommitAction('rebase', [main])).reason,
    /detached HEAD/i
  );
  repo.git('switch', 'source');

  await assert.rejects(service.rebaseOnto('missing-target'), /Git ref not found/);
  const result = await service.rebaseOnto('main');
  assert.equal(result.success, true);
  assert.doesNotThrow(() => repo.git('merge-base', '--is-ancestor', 'main', 'source'));
});

test('cherry-pick deduplicates and orders commits while rejecting invalid and merge commits', async t => {
  const { repo, first, second } = createDivergedRepository(t);
  const service = new GitService(repo.repository);
  const preview = await service.previewCommitAction('cherry-pick', [second, first, second]);

  assert.deepEqual(preview.commits.map(commit => commit.hash), [first, second]);
  await assert.rejects(service.previewCommitAction('cherry-pick', []), /between 1 and 500/);
  await assert.rejects(
    service.previewCommitAction('cherry-pick', ['not-a-hash']),
    /Invalid commit hash/
  );
  const result = await service.cherryPickCommits([second, first, second]);
  assert.deepEqual(result.commits, [first, second]);

  const mergeRepo = createDivergedRepository(t).repo;
  mergeRepo.git('merge', '--no-ff', 'source', '-m', 'merge source');
  const mergeHash = mergeRepo.git('rev-parse', 'HEAD');
  const mergePreview = await new GitService(mergeRepo.repository)
    .previewCommitAction('cherry-pick', [mergeHash]);
  assert.equal(mergePreview.allowed, false);
  assert.match(mergePreview.reason, /merge commits require a mainline/i);
});

test('GitService preserves direct operation helper contracts', async t => {
  const { repo, first, second } = createDivergedRepository(t);
  const service = new GitService(repo.repository);

  assert.deepEqual(service.validateCommitHashes([first, first]), [first]);
  const metadata = await service.getCommitActionMetadata([second, first]);
  assert.deepEqual(
    service.sortCommitsParentFirst(metadata).map(commit => commit.hash),
    [first, second]
  );
  assert.equal(await service.isAncestor(first, second), true);
  assert.deepEqual(
    (await service.getCommitFiles(metadata)).sort(),
    ['first.txt', 'second.txt']
  );
  assert.equal(service.parseConflictBlocks(
    '<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feature\n'
  ).length, 1);

  const result = await service.rebaseOntoCommit(second);
  assert.equal(result.success, true);
  assert.equal(result.target, second);
  assert.doesNotThrow(() => repo.git('merge-base', '--is-ancestor', second, 'HEAD'));
});

test('merge, rebase and cherry-pick state survives GitService recreation', async t => {
  const mergeFixture = createConflictRepository(t);
  const mergeService = new GitService(mergeFixture.repo.repository);
  await assert.rejects(mergeService.merge('feature', 'noff'), /Failed to merge/);
  const recoveredMerge = new GitService(mergeFixture.repo.repository);
  assert.equal((await recoveredMerge.getOperationState()).type, 'merge');
  await recoveredMerge.abortOperation();

  const rebaseFixture = createConflictRepository(t);
  rebaseFixture.repo.git('switch', 'feature');
  const rebaseService = new GitService(rebaseFixture.repo.repository);
  await assert.rejects(rebaseService.rebaseOnto('main'), /Failed to rebase/);
  const recoveredRebase = new GitService(rebaseFixture.repo.repository);
  assert.equal((await recoveredRebase.getOperationState()).type, 'rebase');
  const rebaseConflict = await recoveredRebase.readConflict('conflict.txt');
  assert.equal(rebaseConflict.current, 'main\n');
  assert.equal(rebaseConflict.incoming, 'feature\n');
  await recoveredRebase.abortOperation();

  const cherryFixture = createConflictRepository(t);
  const cherryService = new GitService(cherryFixture.repo.repository);
  await assert.rejects(
    cherryService.cherryPickCommits([cherryFixture.featureCommit]),
    /Failed to cherry-pick/
  );
  const recoveredCherry = new GitService(cherryFixture.repo.repository);
  assert.equal((await recoveredCherry.getOperationState()).type, 'cherry-pick');
  await recoveredCherry.skipOperation();
  assert.equal((await recoveredCherry.getOperationState()).type, null);
});

test('text conflicts preserve resolution strategies and reject unsafe results', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const files = ['manual.txt', 'ours.txt', 'theirs.txt', 'invalid.txt', 'stale.txt', 'markers.txt', 'large.txt'];
  for (const file of files) repo.write(file, 'base\n');
  commitAll(repo, 'base conflicts');
  repo.git('switch', '-c', 'feature');
  for (const file of files) repo.write(file, 'feature\n');
  commitAll(repo, 'feature conflicts');
  repo.git('switch', 'main');
  for (const file of files) repo.write(file, 'main\n');
  commitAll(repo, 'main conflicts');

  const service = new GitService(repo.repository);
  await assert.rejects(service.merge('feature', 'noff'), /Failed to merge/);

  const manual = await service.readConflict('manual.txt');
  await service.resolveConflict('manual.txt', {
    strategy: 'manual',
    snapshotId: manual.snapshotId,
    content: 'resolved\n'
  });
  const ours = await service.readConflict('ours.txt');
  await service.resolveConflict('ours.txt', { strategy: 'ours', snapshotId: ours.snapshotId });
  const theirs = await service.readConflict('theirs.txt');
  await service.resolveConflict('theirs.txt', {
    strategy: 'theirs',
    snapshotId: theirs.snapshotId
  });
  assert.equal(
    fs.readFileSync(path.join(repo.repository, 'ours.txt'), 'utf8').replaceAll('\r\n', '\n'),
    'main\n'
  );
  assert.equal(
    fs.readFileSync(path.join(repo.repository, 'theirs.txt'), 'utf8').replaceAll('\r\n', '\n'),
    'feature\n'
  );

  const invalid = await service.readConflict('invalid.txt');
  await assert.rejects(
    service.resolveConflict('invalid.txt', {
      strategy: 'automatic',
      snapshotId: invalid.snapshotId
    }),
    /Invalid conflict strategy/
  );
  await assert.rejects(
    service.resolveConflict('stale.txt', {
      strategy: 'manual',
      snapshotId: '0'.repeat(64),
      content: 'resolved\n'
    }),
    /changed externally/i
  );
  const markers = await service.readConflict('markers.txt');
  await assert.rejects(
    service.resolveConflict('markers.txt', {
      strategy: 'manual',
      snapshotId: markers.snapshotId,
      content: markers.result
    }),
    /unresolved conflict markers/i
  );
  const large = await service.readConflict('large.txt');
  await assert.rejects(
    service.resolveConflict('large.txt', {
      strategy: 'manual',
      snapshotId: large.snapshotId,
      content: 'x'.repeat((50 * 1024 * 1024) + 1)
    }),
    /too large/i
  );

  for (const file of ['invalid.txt', 'stale.txt', 'markers.txt', 'large.txt']) {
    const conflict = await service.readConflict(file);
    await service.resolveConflict(file, { strategy: 'ours', snapshotId: conflict.snapshotId });
  }
  assert.equal((await service.getOperationState()).canContinue, true);
  await service.continueOperation();
  assert.equal((await service.getOperationState()).type, null);
  assert.equal(repo.git('show', 'HEAD:manual.txt'), 'resolved');
});

test('binary, added and deleted conflicts remain readable and paths stay contained', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('image.bin', Buffer.from([0, 1, 2]));
  repo.write('deleted.txt', 'base\n');
  commitAll(repo, 'base special conflicts');
  repo.git('switch', '-c', 'feature');
  repo.write('image.bin', Buffer.from([0, 3, 4]));
  repo.write('deleted.txt', 'feature\n');
  repo.write('added.txt', 'feature\n');
  commitAll(repo, 'feature special conflicts');
  repo.git('switch', 'main');
  repo.write('image.bin', Buffer.from([0, 5, 6]));
  fs.rmSync(path.join(repo.repository, 'deleted.txt'));
  repo.write('added.txt', 'main\n');
  commitAll(repo, 'main special conflicts');

  const service = new GitService(repo.repository);
  await assert.rejects(service.merge('feature', 'noff'), /Failed to merge/);
  assert.equal((await service.readConflict('image.bin')).binary, true);
  assert.equal((await service.readConflict('added.txt')).base, '');
  const deleted = await service.readConflict('deleted.txt');
  assert.equal(deleted.current, '');
  assert.equal(deleted.incoming, 'feature\n');
  await assert.rejects(service.readConflict('../outside.txt'), /outside the repository/);

  const outside = path.join(repo.root, 'outside');
  const link = path.join(repo.repository, 'link');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.readConflict('link/secret.txt'), /symbolic links/);
  await service.abortOperation();
});

test('real IPC handlers retain conflict envelopes for merge, rebase and cherry-pick', async t => {
  const mergeFixture = createConflictRepository(t);
  const mergeService = new GitService(mergeFixture.repo.repository);
  const mergeResult = await conflictHandler(mergeService, 'git:merge')(
    mergeFixture.repo.repository,
    'feature',
    'noff'
  );
  assert.match(mergeResult.error, /Failed to merge/);
  assert.equal(mergeResult.conflictState.type, 'merge');
  await mergeService.abortOperation();

  const rebaseFixture = createConflictRepository(t);
  rebaseFixture.repo.git('switch', 'feature');
  const rebaseService = new GitService(rebaseFixture.repo.repository);
  const rebaseResult = await conflictHandler(rebaseService, 'git:branch-rebase')(
    rebaseFixture.repo.repository,
    'main'
  );
  assert.match(rebaseResult.error, /Failed to rebase/);
  assert.equal(rebaseResult.conflictState.type, 'rebase');
  await rebaseService.abortOperation();

  const cherryFixture = createConflictRepository(t);
  const cherryService = new GitService(cherryFixture.repo.repository);
  const cherryResult = await conflictHandler(cherryService, 'git:cherry-pick')(
    cherryFixture.repo.repository,
    [cherryFixture.featureCommit]
  );
  assert.match(cherryResult.error, /Failed to cherry-pick/);
  assert.equal(cherryResult.conflictState.type, 'cherry-pick');
  await cherryService.abortOperation();
});
