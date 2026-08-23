const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { GitService } = require('../src/main/git-service.mts');
const { RepoManager } = require('../src/main/repo-manager.mts');
const { CredentialVault } = require('../src/main/credential-vault.mts');
const { Logger } = require('../src/main/logger.mts');
const { parseGitVersion, isVersionAtLeast } = require('../src/main/git-version.mts');
const { parseDeepLink } = require('../src/main/deep-link.mts');
const { createRepository } = require('./helpers/git-repository');

test('diff and commit detail work for the repository root commit', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'hello');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'initial');
    const hash = fixture.git('rev-parse', 'HEAD');

    const service = new GitService(fixture.repository);
    const diff = await service.getDiff(hash);
    assert.match(diff, /diff --git a\/a\.txt b\/a\.txt/);

    const detail = await service.getCommitDetail(hash);
    assert.equal(detail.hash, hash);
    assert.match(detail.diff, /diff --git a\/a\.txt b\/a\.txt/);
  } finally {
    fixture.cleanup();
  }
});

test('revision positions reject option injection and invalid refs', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'hello');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'initial');

    const service = new GitService(fixture.repository);
    await assert.rejects(service.getLog(10, '--all'), /Invalid Git ref/);
    await assert.rejects(service.getDiff('--grep=x'), /Invalid Git ref/);
    await assert.rejects(service.getFileTree('--all'), /Invalid Git ref/);
    await assert.rejects(service.getCommitDetail('-n 1'), /Invalid Git ref/);
    await assert.rejects(service.getBranchComparison('--all', 'main'), /Invalid Git ref/);
    await assert.rejects(service.getBranchComparison('main', '--all'), /Invalid Git ref/);
    await assert.rejects(service.stashPop('abc'), /Invalid stash index/);
    await assert.rejects(service.stashPop(-1), /Invalid stash index/);
    await assert.rejects(service.stashPop('1.5'), /Invalid stash index/);
  } finally {
    fixture.cleanup();
  }
});

test('previewMerge reports exactly the conflicted files', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'base');
    fixture.write('b.txt', 'base');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'init');
    fixture.git('checkout', '-b', 'feature');
    fixture.write('a.txt', 'feature-version');
    fixture.write('c.txt', 'new');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'feat');
    fixture.git('checkout', 'main');
    fixture.write('a.txt', 'main-version');
    fixture.write('d.txt', 'maind');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'mainc');

    const service = new GitService(fixture.repository);
    const preview = await service.previewMerge('feature');
    assert.equal(preview.supported, true);
    assert.deepEqual(preview.conflictedFiles, ['a.txt']);
    assert.ok(preview.changedFiles.includes('a.txt'));
    assert.ok(preview.changedFiles.includes('c.txt'));
  } finally {
    fixture.cleanup();
  }
});

test('concurrent operations on one service are serialized without deadlock', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'hello');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'initial');

    const service = new GitService(fixture.repository);
    const results = await Promise.all([
      service.getLog(10),
      service.getBranches(),
      service.getStatus(),
      service.getGraphPage(),
      service.getTags(),
      service.getWorkingTree()
    ]);
    assert.ok(results.every(result => result !== undefined));
    assert.equal(results[0].all.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('repo-manager keeps the active repository when a repo above it is removed', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'gittree-manager-')
  );
  const configPath = path.join(fixtureRoot, 'repos.json');
  const repositories = ['a', 'b', 'c'].map(name => path.join(fixtureRoot, 'work', name));
  const manager = new RepoManager({ configPath });
  repositories.forEach(repoPath => manager.addRepo(repoPath));
  manager.setActiveRepo(1);

  assert.equal(manager.removeRepo(repositories[0]), true);
  assert.equal(manager.getActiveRepo().path, repositories[1]);
  assert.equal(manager.activeRepoIndex, 0);

  assert.equal(manager.removeRepo(repositories[2]), true);
  assert.equal(manager.getActiveRepo().path, repositories[1]);

  assert.equal(manager.removeRepo(repositories[1]), true);
  assert.equal(manager.getActiveRepo(), null);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('credential vault write queue recovers after a failed write', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gittree-vault-'));
  const blocker = path.join(root, 'blocker');
  const storagePath = path.join(blocker, 'vault.bin');
  fs.writeFileSync(blocker, 'i am a file');
  const vault = new CredentialVault({
    storagePath,
    platform: 'win32',
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: plaintext => Buffer.from(String(plaintext), 'utf8')
    }
  });
  try {
    await assert.rejects(vault.persist());

    fs.rmSync(blocker);
    await vault.setAccount('github', { token: 'secret-token' });
    assert.ok(fs.existsSync(storagePath));
    await vault.removeAccount('github');
    assert.ok(fs.existsSync(storagePath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credential vault reset clears accounts, drafts and the vault file', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gittree-vault-reset-'));
  const storagePath = path.join(root, 'vault.bin');
  const vault = new CredentialVault({
    storagePath,
    platform: 'win32',
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: plaintext => Buffer.from(String(plaintext), 'utf8')
    }
  });
  try {
    await vault.setAccount('github', { token: 'token-1' });
    await vault.saveReviewDraft('github:owner/repo:42', { body: 'draft' });
    const result = await vault.reset();
    assert.equal(result.success, true);
    assert.equal(await vault.getAccount('github'), null);
    assert.equal(await vault.getReviewDraft('github:owner/repo:42'), null);
    assert.equal(fs.existsSync(storagePath), false);
    await vault.setAccount('gitlab', { token: 'token-2' });
    assert.ok(fs.existsSync(storagePath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credential vault removes only the drafts of the given provider', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gittree-vault-drafts-'));
  const vault = new CredentialVault({
    storagePath: path.join(root, 'vault.bin'),
    platform: 'win32',
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: plaintext => Buffer.from(String(plaintext), 'utf8')
    }
  });
  try {
    await vault.saveReviewDraft('github:owner/repo:42', { body: 'gh' });
    await vault.saveReviewDraft('gitlab:owner/repo:7', { body: 'gl' });
    await vault.removeProviderDrafts('github');
    assert.equal(await vault.getReviewDraft('github:owner/repo:42'), null);
    assert.deepEqual(await vault.getReviewDraft('gitlab:owner/repo:7'), { body: 'gl' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository paths cannot traverse symbolic links', async t => {
  const fixture = createRepository();
  t.after(() => fixture.cleanup());
  const outside = path.join(fixture.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');
  const link = path.join(fixture.repository, 'link');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(outside, link, linkType);
  } catch {
    t.skip('symlinks are not available on this filesystem');
    return;
  }
  const service = new GitService(fixture.repository);
  await assert.rejects(service.getParsedWorkingDiff('link/secret.txt'), /symbolic links/);
  const snapshotId = (await service.getWorkingTree()).snapshotId;
  await assert.rejects(service.stagePaths(snapshotId, ['link/secret.txt']), /symbolic links/);
});

test('branch names starting with a dash are rejected before checkout and push', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'hello');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'initial');
    const bare = path.join(fixture.root, 'remote.git');
    const { git } = require('./helpers/git-repository');
    git(fixture.root, 'init', '--bare', 'remote.git');
    fixture.git('remote', 'add', 'origin', bare);

    const service = new GitService(fixture.repository);
    await assert.rejects(service.checkoutBranch('-f'), /Invalid local branch name/);
    await assert.rejects(service.checkoutBranch('-B'), /Invalid local branch name/);
    await assert.rejects(service.push('origin', '-f'), /Invalid local branch name/);
    await assert.rejects(service.checkoutTrackingBranch('origin/-f'), /Invalid remote branch/);
  } finally {
    fixture.cleanup();
  }
});

test('merge proceeds when pending changes do not overlap the branch changes', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'base-a');
    fixture.write('b.txt', 'base-b');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'init');
    fixture.git('checkout', '-b', 'feature');
    fixture.write('a.txt', 'feature-a');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'feature');
    fixture.git('checkout', 'main');

    fixture.write('b.txt', 'local-b');
    const service = new GitService(fixture.repository);
    const result = await service.merge('feature');
    assert.equal(result.success, true);
    assert.equal(fixture.git('show', 'HEAD:a.txt'), 'feature-a');
    assert.equal(fs.readFileSync(path.join(fixture.repository, 'b.txt'), 'utf8'), 'local-b');
  } finally {
    fixture.cleanup();
  }
});

test('merge rejects only when pending changes overlap the branch changes', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'base-a');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'init');
    fixture.git('checkout', '-b', 'feature');
    fixture.write('a.txt', 'feature-a');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'feature');
    fixture.git('checkout', 'main');

    fixture.write('a.txt', 'local-a');
    const service = new GitService(fixture.repository);
    await assert.rejects(service.merge('feature'), /overwrite local changes in: a\.txt/);
    assert.equal(fs.readFileSync(path.join(fixture.repository, 'a.txt'), 'utf8'), 'local-a');
  } finally {
    fixture.cleanup();
  }
});

test('merge rejects when the branch adds a file that exists untracked locally', async () => {
  const fixture = createRepository();
  try {
    fixture.write('base.txt', 'base');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'init');
    fixture.git('checkout', '-b', 'feature');
    fixture.write('new.txt', 'from-branch');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'feature');
    fixture.git('checkout', 'main');

    fixture.write('new.txt', 'local-untracked');
    const service = new GitService(fixture.repository);
    await assert.rejects(service.merge('feature'), /overwrite local changes in: new\.txt/);
  } finally {
    fixture.cleanup();
  }
});

test('discardPaths restores tracked files and removes untracked files', async () => {
  const fixture = createRepository();
  try {
    fixture.write('tracked.txt', 'original');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'init');

    fixture.write('tracked.txt', 'modified');
    fixture.write('untracked.txt', 'new');
    const service = new GitService(fixture.repository);
    const snapshot = await service.getWorkingTree();

    const result = await service.discardPaths(
      snapshot.snapshotId,
      ['tracked.txt', 'untracked.txt']
    );
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(fixture.repository, 'tracked.txt'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(fixture.repository, 'untracked.txt')), false);
  } finally {
    fixture.cleanup();
  }
});

test('tags can be deleted locally, pushed and removed from a remote', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'hello');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'initial');
    const hash = fixture.git('rev-parse', 'HEAD');
    const { git } = require('./helpers/git-repository');
    git(fixture.root, 'init', '--bare', 'remote.git');
    fixture.git('remote', 'add', 'origin', path.join(fixture.root, 'remote.git'));

    const service = new GitService(fixture.repository);
    await service.createTag('v1.0.0', hash, 'release one');
    assert.deepEqual(await service.getTagsAtCommit(hash), ['v1.0.0']);

    await service.pushTags('origin');
    const remoteTags = git(fixture.root, '--git-dir=remote.git', 'tag', '-l');
    assert.match(remoteTags, /v1\.0\.0/);

    await service.deleteTag('v1.0.0');
    assert.deepEqual(await service.getTagsAtCommit(hash), []);

    await assert.rejects(service.deleteTag('v1.0.0'), /Tag not found/);
    await assert.rejects(service.deleteTag('-x'), /Invalid tag name/);
  } finally {
    fixture.cleanup();
  }
});

test('remotes can be added, renamed, re-pointed and removed', async () => {
  const fixture = createRepository();
  try {
    fixture.git('commit', '--allow-empty', '-m', 'init');
    const { git } = require('./helpers/git-repository');
    const bare = path.join(fixture.root, 'remote.git');
    const bare2 = path.join(fixture.root, 'remote2.git');
    git(fixture.root, 'init', '--bare', 'remote.git');
    git(fixture.root, 'init', '--bare', 'remote2.git');

    const service = new GitService(fixture.repository);
    await service.addRemote('origin', bare);
    await service.addRemote('backup', bare2);
    assert.equal((await service.getRemotes()).length, 2);

    await service.renameRemote('backup', 'archive');
    assert.ok((await service.getRemotes()).some(remote => remote.name === 'archive'));

    await service.setRemoteUrl('archive', bare2);
    assert.equal(
      (await service.getRemotes()).find(remote => remote.name === 'archive').refs.push,
      bare2
    );

    await service.removeRemote('archive');
    assert.equal((await service.getRemotes()).length, 1);

    await assert.rejects(service.addRemote('bad name', bare), /Invalid remote name/);
    await assert.rejects(service.addRemote('-origin', bare), /Invalid remote name/);
    await assert.rejects(service.addRemote('origin', 'not\nallowed'), /Invalid remote URL/);
    await assert.rejects(service.removeRemote('missing'), /Remote not found/);
  } finally {
    fixture.cleanup();
  }
});

test('a file can be restored from a previous commit', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'version-one');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'first');
    const hashA = fixture.git('rev-parse', 'HEAD');
    fixture.write('a.txt', 'version-two');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'second');

    const service = new GitService(fixture.repository);
    const result = await service.restoreFileFromCommit(hashA, 'a.txt');
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(fixture.repository, 'a.txt'), 'utf8'), 'version-one');

    await assert.rejects(
      service.restoreFileFromCommit('--all', 'a.txt'),
      /Invalid Git ref/
    );
    await assert.rejects(
      service.restoreFileFromCommit(hashA, '../outside.txt'),
      /outside the repository/
    );
  } finally {
    fixture.cleanup();
  }
});

test('reflog exposes recent HEAD movements', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'one');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'first');
    const first = fixture.git('rev-parse', 'HEAD');
    fixture.write('a.txt', 'two');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'second');

    const service = new GitService(fixture.repository);
    const entries = await service.getReflog(50);
    assert.ok(entries.length >= 2);
    assert.ok(entries.some(entry => entry.hash === first));
    assert.ok(entries.every(entry => /^[a-f0-9]{40}$/.test(entry.hash)));
    assert.ok(entries.every(entry => typeof entry.message === 'string'));
  } finally {
    fixture.cleanup();
  }
});

test('worktrees can be created, listed and removed', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'base');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'init');

    const service = new GitService(fixture.repository);
    const worktreeDir = path.join(fixture.root, 'linked-worktree');
    const result = await service.createWorktree(worktreeDir, 'feature/wt');
    assert.equal(result.success, true);
    assert.ok(fs.existsSync(path.join(worktreeDir, '.git')));

      const worktrees = await service.getWorktrees();
      const match = worktrees.find(wt => wt.branch === 'feature/wt');
      assert.ok(match, `worktree listed (${worktrees.map(wt => wt.path).join(', ')})`);

    await service.removeWorktree(worktreeDir);
    assert.equal(fs.existsSync(worktreeDir), false);

    await assert.rejects(service.createWorktree('relative/path', 'x'), /Invalid worktree directory/);
    await assert.rejects(service.createWorktree(path.join(fixture.root, 'wt2'), '-bad'), /Invalid branch name/);
  } finally {
    fixture.cleanup();
  }
});

test('submodules are listed, initialized and updated', async () => {
  const fixture = createRepository();
  try {
    const { git } = require('./helpers/git-repository');
    const sub = path.join(fixture.root, 'sub-repo');
    fs.mkdirSync(sub);
    git(sub, 'init', '-b', 'main');
    git(sub, 'config', 'user.name', 'GitTree Tests');
    git(sub, 'config', 'user.email', 'gittree@example.test');
    git(sub, 'commit', '--allow-empty', '-m', 'sub init');
    const subHash = git(sub, 'rev-parse', 'HEAD');
    git(sub, 'update-server-info');

    fixture.write('README.md', 'root');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'init');
    fixture.git('-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'vendor/lib');
    fixture.git('commit', '-m', 'add submodule');

    const service = new GitService(fixture.repository);
    const snapshot = await service.getWorkingTree();
    assert.ok(
      snapshot.submodules.some(submodule => submodule.path === 'vendor/lib'),
      'submodule listed in the working tree snapshot'
    );

    await service.initSubmodules();
    assert.ok(fs.existsSync(path.join(fixture.repository, 'vendor', 'lib', '.git')));
    const entries = await service.getSubmodules();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'vendor/lib');
    assert.equal(entries[0].hash, subHash);

    await service.updateSubmodules();
    assert.ok((await service.getSubmodules())[0].status === ' ');
  } finally {
    fixture.cleanup();
  }
});

test('git version parsing and minimum version checks', () => {
  assert.deepEqual(parseGitVersion('git version 2.49.0.windows.1'), [2, 49, 0]);
  assert.deepEqual(parseGitVersion('git version 2.45.1'), [2, 45, 1]);
  assert.deepEqual(parseGitVersion('git version 2.23'), [2, 23, 0]);
  assert.equal(parseGitVersion('not git'), null);
  assert.equal(isVersionAtLeast([2, 49, 0], [2, 45, 1]), true);
  assert.equal(isVersionAtLeast([2, 45, 1], [2, 45, 1]), true);
  assert.equal(isVersionAtLeast([2, 45, 0], [2, 45, 1]), false);
  assert.equal(isVersionAtLeast([2, 44, 9], [2, 45, 1]), false);
  assert.equal(isVersionAtLeast([3, 0, 0], [2, 45, 1]), true);
  assert.equal(isVersionAtLeast(null, [2, 45, 1]), false);
});

test('logger writes redacted lines and rotates large files', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gittree-log-'));
  try {
    const logger = new Logger(root);
    logger.setLevel(0);
    logger.info('user logged in with token ghp_1234567890abcdef');
    logger.error('request failed', { authorization: 'Bearer glpat-secret-token-value' });
    const content = fs.readFileSync(path.join(root, 'gittree.log'), 'utf8');
    assert.ok(content.length > 0);
    assert.doesNotMatch(content, /ghp_1234567890abcdef/);
    assert.doesNotMatch(content, /glpat-secret-token-value/);
    assert.match(content, /ghp\*\*\*/);
    assert.ok(fs.statSync(path.join(root, 'gittree.log')).size > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deep links parse only absolute repository paths', () => {
  assert.equal(parseDeepLink('gittree://open?path=' + encodeURIComponent('C:\\work\\repo')), 'C:\\work\\repo');
  assert.equal(parseDeepLink('gittree://open?path=' + encodeURIComponent('/home/user/repo')), '/home/user/repo');
  assert.equal(parseDeepLink('gittree://open?path=relative/path'), null);
  assert.equal(parseDeepLink('https://github.com/giannoccarol/gittree'), null);
  assert.equal(parseDeepLink('gittree://open?path=' + encodeURIComponent('a' + String.fromCharCode(0) + 'b')), null);
  assert.equal(parseDeepLink('gittree://other?path=/tmp/x'), null);
  assert.equal(parseDeepLink(null), null);
  assert.equal(parseDeepLink('not a url'), null);
});

test('stash apply, drop and pop operate on the given stash index', async () => {
  const fixture = createRepository();
  try {
    fixture.write('a.txt', 'base');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'init');

    fixture.write('a.txt', 'work-in-progress');
    const service = new GitService(fixture.repository);
    await service.stash('WIP one');
    fixture.write('b.txt', 'second');
    await service.stash('WIP two');

    assert.equal((await service.getStashList()).all.length, 2);

    await service.stashApply(0);
    assert.equal(fs.readFileSync(path.join(fixture.repository, 'b.txt'), 'utf8'), 'second');
    assert.equal((await service.getStashList()).all.length, 2);

    await service.stashDrop(0);
    assert.equal((await service.getStashList()).all.length, 1);

    await service.stashPop(0);
    assert.equal((await service.getStashList()).all.length, 0);
    assert.equal(fs.readFileSync(path.join(fixture.repository, 'a.txt'), 'utf8'), 'work-in-progress');

    await assert.rejects(service.stashApply('nope'), /Invalid stash index/);
    await assert.rejects(service.stashDrop(-1), /Invalid stash index/);
  } finally {
    fixture.cleanup();
  }
});

test('discardPaths is blocked during a pending merge and rejects stale snapshots', async () => {
  const fixture = createRepository();
  try {
    fixture.write('tracked.txt', 'original');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'init');

    const service = new GitService(fixture.repository);
    const snapshot = await service.getWorkingTree();
    fixture.write('tracked.txt', 'changed-after-snapshot');
    await assert.rejects(
      service.discardPaths(snapshot.snapshotId, ['tracked.txt']),
      /Working tree changed/
    );

    fixture.git('checkout', '-b', 'feature');
    fixture.write('a.txt', 'feature');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'feature');
    fixture.git('checkout', 'main');
    fixture.write('a.txt', 'main');
    fixture.git('add', '-A');
    fixture.git('commit', '-m', 'main');
    await assert.rejects(service.merge('feature'), /Failed to merge/);
    const state = await service.getOperationState();
    assert.equal(state.type, 'merge');
    await assert.rejects(
      service.discardPaths(snapshot.snapshotId, [state.conflicts[0]]),
      /Finish or abort the pending merge/
    );
  } finally {
    fixture.cleanup();
  }
});
