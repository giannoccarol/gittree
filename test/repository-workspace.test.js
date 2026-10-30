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

function linkOrSkip(t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    t.skip('symbolic links are not available on this filesystem');
    return false;
  }
}

test('Repository workspace re-resolves a registered link after it is retargeted', t => {
  const first = createRepository();
  const second = createRepository();
  t.after(() => first.cleanup());
  t.after(() => second.cleanup());
  const link = path.join(first.root, 'current');
  if (!linkOrSkip(t, first.repository, link)) return;
  const workspace = new RepositoryWorkspace({
    repoStore: new MemoryRepoStore([{ path: link, name: 'current' }])
  });

  assert.equal(workspace.isManaged(first.repository), true);
  assert.equal(workspace.isManaged(link), true);
  assert.equal(workspace.getGitService(link).repoPath, fs.realpathSync.native(first.repository));

  fs.unlinkSync(link);
  linkOrSkip(t, second.repository, link);
  assert.equal(workspace.isManaged(first.repository), false);
  assert.throws(() => workspace.assertManaged(first.repository), /not opened/);
  assert.equal(workspace.isManaged(second.repository), true);
  assert.equal(workspace.isManaged(link), true);
});

test('Repository workspace admits a request link only while it resolves to a registered repository', t => {
  const registered = createRepository();
  const unregistered = createRepository();
  t.after(() => registered.cleanup());
  t.after(() => unregistered.cleanup());
  const workspace = new RepositoryWorkspace({ repoStore: new MemoryRepoStore() });
  workspace.addTrustedRepository(registered.repository);
  const link = path.join(unregistered.root, 'request-link');
  if (!linkOrSkip(t, registered.repository, link)) return;

  assert.equal(workspace.isManaged(link), true);
  assert.equal(workspace.getGitService(link), workspace.getGitService(registered.repository));

  fs.unlinkSync(link);
  linkOrSkip(t, unregistered.repository, link);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(workspace.isManaged(link), false);
    assert.equal(workspace.isManaged(unregistered.repository), false);
    assert.throws(() => workspace.getGitService(link), /not opened/);
  }
  assert.equal(workspace.isManaged(registered.repository), true);
});

test('Repository workspace recognizes a registered path created as a link after a lookup', t => {
  const target = createRepository();
  t.after(() => target.cleanup());
  const entry = path.join(target.root, 'created-later');
  const workspace = new RepositoryWorkspace({
    repoStore: new MemoryRepoStore([{ path: entry, name: 'created-later' }])
  });
  assert.equal(workspace.isManaged(entry), true);
  assert.equal(workspace.isManaged(target.repository), false);

  if (!linkOrSkip(t, target.repository, entry)) return;
  assert.equal(workspace.isManaged(target.repository), true);
});

test('Repository workspace forgets removed repositories and keeps store order', t => {
  const first = createRepository();
  const second = createRepository();
  t.after(() => first.cleanup());
  t.after(() => second.cleanup());
  const store = new MemoryRepoStore();
  const workspace = new RepositoryWorkspace({ repoStore: store });
  workspace.addTrustedRepository(first.repository);
  workspace.addTrustedRepository(second.repository);
  const firstPath = fs.realpathSync.native(first.repository);
  // A second spelling of the first repository registered after it.
  store.repositories.push({ path: `${firstPath}${path.sep}`, name: 'duplicate' });

  assert.equal(workspace.managedRepository(first.repository).path, firstPath);
  assert.equal(workspace.remove(first.repository), true);
  assert.equal(workspace.managedRepository(first.repository).name, 'duplicate');
  assert.equal(workspace.remove(first.repository), true);
  assert.equal(workspace.isManaged(first.repository), false);
  assert.throws(() => workspace.getGitService(first.repository), /not opened/);
  assert.equal(workspace.isManaged(second.repository), true);
});

test('Repository workspace reports a missing registered repository like before', t => {
  const fixture = createRepository();
  t.after(() => fixture.cleanup());
  const missing = path.join(fixture.root, 'missing');
  const workspace = new RepositoryWorkspace({
    repoStore: new MemoryRepoStore([{ path: missing, name: 'missing' }])
  });
  assert.equal(workspace.isManaged(missing), true);
  assert.throws(() => workspace.getGitService(missing), { code: 'ENOENT' });
  assert.equal(workspace.remove(missing), true);
});

test('Repository workspace resolves only the request and its match on a managed lookup', t => {
  const fixtures = Array.from({ length: 12 }, () => createRepository());
  t.after(() => fixtures.forEach(fixture => fixture.cleanup()));
  let calls = 0;
  const realpathSync = (value, options) => {
    calls += 1;
    return fs.realpathSync.native(value, options);
  };
  realpathSync.native = realpathSync;
  const workspace = new RepositoryWorkspace({
    repoStore: new MemoryRepoStore(),
    fileSystem: { ...fs, realpathSync }
  });
  fixtures.forEach(fixture => workspace.addTrustedRepository(fixture.repository));
  const last = fixtures[fixtures.length - 1].repository;
  workspace.getGitService(last);

  calls = 0;
  workspace.assertManaged(last);
  workspace.getGitService(last);
  assert.ok(calls <= 5, `expected at most 5 realpath calls, got ${calls}`);
});
