const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { GitService } = require('../src/main/git-service.mts');
const { RepositoryWorkspace } = require('../src/main/repository-workspace.mts');
const { createRepository } = require('./helpers/git-repository');

class MemoryRepoStore {
  constructor(repositories = []) {
    this.repositories = [...repositories];
    this.activeIndex = repositories.length ? 0 : -1;
  }

  addRepo(repoPath) {
    let index = this.repositories.findIndex(repo => repo.path === repoPath);
    if (index === -1) {
      this.repositories.push({ path: repoPath, name: path.basename(repoPath) });
      index = this.repositories.length - 1;
    }
    this.activeIndex = index;
    return this.getActiveRepo();
  }

  addRepos(repoPaths) {
    const added = repoPaths.map(repoPath => this.addRepo(repoPath));
    return { added, existing: [], activeRepo: this.getActiveRepo() };
  }

  removeRepo(repoPath) {
    const index = this.repositories.findIndex(repo => repo.path === repoPath);
    if (index === -1) return false;
    this.repositories.splice(index, 1);
    this.activeIndex = this.repositories.length ? 0 : -1;
    return true;
  }

  setActiveRepo(index) {
    if (index < 0 || index >= this.repositories.length) return null;
    this.activeIndex = index;
    return this.getActiveRepo();
  }

  getActiveRepo() {
    return this.repositories[this.activeIndex] || null;
  }

  getAllRepos() {
    return this.repositories;
  }
}

test('Repository workspace admits only a directory selected by the main process', t => {
  const selected = createRepository();
  const arbitrary = createRepository();
  t.after(() => selected.cleanup());
  t.after(() => arbitrary.cleanup());
  const workspace = new RepositoryWorkspace({ repoStore: new MemoryRepoStore() });

  workspace.authorizeDirectory(selected.repository);
  assert.equal(workspace.canInspect(selected.repository), true);
  assert.equal(workspace.canInspect(arbitrary.repository), false);
  assert.throws(
    () => workspace.addAuthorizedRepository(arbitrary.repository),
    /not authorized/i
  );

  const repository = workspace.addAuthorizedRepository(selected.repository);
  assert.equal(repository.path, fs.realpathSync.native(selected.repository));
  assert.equal(workspace.isManaged(selected.repository), true);
  assert.doesNotThrow(() => workspace.assertManaged(selected.repository));
  assert.equal(
    workspace.addAuthorizedRepository(selected.repository).path,
    fs.realpathSync.native(selected.repository)
  );
});

test('Repository workspace recognizes a canonical path through an existing alias', () => {
  const aliasPath = path.resolve('workspace-alias');
  const canonicalPath = path.resolve('workspace-canonical');
  const realpathSync = value => (
    path.normalize(value) === path.normalize(aliasPath) ? canonicalPath : path.normalize(value)
  );
  realpathSync.native = realpathSync;
  const workspace = new RepositoryWorkspace({
    repoStore: new MemoryRepoStore([{ path: canonicalPath, name: 'canonical' }]),
    fileSystem: { realpathSync },
    platform: 'win32'
  });

  assert.equal(workspace.isManaged(aliasPath), true);
  assert.doesNotThrow(() => workspace.assertManaged(aliasPath));
});

test('Independent repositories retain parallel queues', async t => {
  const firstFixture = createRepository();
  const secondFixture = createRepository();
  t.after(() => firstFixture.cleanup());
  t.after(() => secondFixture.cleanup());
  const workspace = new RepositoryWorkspace({
    repoStore: new MemoryRepoStore(),
    createGitService: (repoPath, options) => new GitService(repoPath, options)
  });
  workspace.addTrustedRepository(firstFixture.repository);
  workspace.addTrustedRepository(secondFixture.repository);
  const firstService = workspace.getGitService(firstFixture.repository);
  const secondService = workspace.getGitService(secondFixture.repository);
  const order = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });

  const first = firstService.runExclusive(async () => {
    order.push('first:start');
    await gate;
  });
  const second = secondService.runExclusive(async () => order.push('second'));

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first:start', 'second']);
  releaseFirst();
  await Promise.all([first, second]);
});

test('Repository workspace authorizes only repositories returned by an approved scan', t => {
  const fixture = createRepository();
  const unrelated = createRepository();
  t.after(() => fixture.cleanup());
  t.after(() => unrelated.cleanup());
  const workspace = new RepositoryWorkspace({ repoStore: new MemoryRepoStore() });

  workspace.authorizeDirectory(fixture.root);
  const scanRoot = workspace.beginScan(fixture.root);
  workspace.authorizeScanResults(scanRoot, [fixture.repository, unrelated.repository]);

  assert.equal(workspace.canAdd(fixture.repository), true);
  assert.equal(workspace.canAdd(unrelated.repository), false);
  const result = workspace.addAuthorizedRepositories([
    fixture.repository,
    unrelated.repository
  ]);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].path, fs.realpathSync.native(fixture.repository));
  assert.deepEqual(result.existing, []);
  assert.deepEqual(result.failed, [{
    path: unrelated.repository,
    error: 'Repository path was not authorized'
  }]);
  assert.equal(result.activeRepo.path, fs.realpathSync.native(fixture.repository));
});

test('Linked worktrees share one observable operation queue', async t => {
  const fixture = createRepository();
  t.after(() => fixture.cleanup());
  fixture.write('README.md', 'root\n');
  fixture.git('add', 'README.md');
  fixture.git('commit', '-m', 'root');
  const linkedPath = path.join(fixture.root, 'linked-worktree');
  fixture.git('worktree', 'add', '-b', 'linked', linkedPath);

  const workspace = new RepositoryWorkspace({
    repoStore: new MemoryRepoStore(),
    createGitService: (repoPath, options) => new GitService(repoPath, options)
  });
  workspace.addTrustedRepository(fixture.repository);
  workspace.addTrustedRepository(linkedPath);
  const primary = workspace.getGitService(fixture.repository);
  const linked = workspace.getGitService(linkedPath);
  const order = [];
  let releasePrimary;
  const gate = new Promise(resolve => { releasePrimary = resolve; });

  const first = primary.runExclusive(async () => {
    order.push('primary:start');
    await gate;
    order.push('primary:end');
  });
  const second = linked.runExclusive(async () => order.push('linked'));

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['primary:start']);
  releasePrimary();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['primary:start', 'primary:end', 'linked']);
});
