const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { simpleGit } = require('simple-git');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository, git } = require('./helpers/git-repository');

// GitService inherits process.env: keep the developer's Git config out of it.
const isolatedEnvironment = {
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
};
const previousEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map(key => [key, process.env[key]])
);
Object.assign(process.env, isolatedEnvironment);
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function commit(repo, file, content, message) {
  repo.write(file, content);
  repo.git('add', '-A');
  repo.git('commit', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

/** A clone whose origin/HEAD points to main, like a repository cloned from a host. */
function createClone(t) {
  const seed = createRepository();
  t.after(() => seed.cleanup());
  const remotePath = path.join(seed.root, 'remote.git');
  git(seed.root, 'init', '--bare', remotePath);
  git(remotePath, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  commit(seed, 'README.md', 'base\n', 'base');
  seed.git('remote', 'add', 'origin', remotePath);
  seed.git('push', 'origin', 'main');
  seed.git('switch', '-c', 'feature/topic');
  commit(seed, 'topic.txt', 'topic\n', 'topic');
  seed.git('push', 'origin', 'feature/topic', 'feature/topic:gone');

  const clonePath = path.join(seed.root, 'clone');
  git(seed.root, 'clone', remotePath, clonePath);
  const clone = {
    root: seed.root,
    repository: clonePath,
    git: (...args) => git(clonePath, ...args),
    write(relativePath, content) {
      fs.mkdirSync(path.dirname(path.join(clonePath, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(clonePath, relativePath), content);
    }
  };
  clone.git('config', 'user.name', 'GitTree Tests');
  clone.git('config', 'user.email', 'gittree@example.test');
  return { clone, remotePath };
}

function sortedByFullName(branches) {
  return [...branches].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

test('branch metadata characterizes a clone with tracking, gone and worktree branches', async t => {
  const { clone, remotePath } = createClone(t);
  // feature/topic: one local commit ahead, one remote commit behind.
  clone.git('switch', 'feature/topic');
  const shared = clone.git('rev-parse', 'HEAD');
  const ahead = commit(clone, 'local.txt', 'local\n', 'local only');
  clone.git('switch', '-c', 'remote-work', shared);
  const behind = commit(clone, 'remote.txt', 'remote\n', 'remote only');
  clone.git('switch', 'feature/topic');
  clone.git('branch', '-D', 'remote-work');
  // gone: its upstream disappears from the remote and is pruned.
  clone.git('branch', '--track', 'gone', 'origin/gone');
  git(remotePath, 'branch', '-D', 'gone');
  clone.git('fetch', '--prune', 'origin');
  clone.git('update-ref', 'refs/remotes/origin/feature/topic', behind);
  // plain: no upstream; checked out in a linked worktree.
  clone.git('branch', 'plain', 'main');
  clone.git('worktree', 'add', path.join(clone.root, 'linked'), 'plain');
  // A tag named like a local branch makes its short name ambiguous.
  clone.git('tag', 'plain', 'main');
  const main = clone.git('rev-parse', 'main');

  const metadata = await new GitService(clone.repository).getBranchMetadata();

  assert.equal(metadata.current, 'feature/topic');
  assert.equal(metadata.defaultBranch, 'main');
  assert.deepEqual(metadata.remotes, [{
    name: 'origin',
    fetchUrl: remotePath,
    pushUrl: remotePath,
    provider: metadata.remotes[0].provider
  }]);
  assert.deepEqual(metadata.branches, [
    {
      fullName: 'refs/heads/feature/topic',
      name: 'feature/topic',
      kind: 'local',
      commit: ahead,
      current: true,
      upstream: 'origin/feature/topic',
      remote: 'origin',
      ahead: 1,
      behind: 1
    },
    {
      fullName: 'refs/heads/gone',
      name: 'gone',
      kind: 'local',
      commit: shared,
      current: false,
      upstream: 'origin/gone',
      remote: 'origin',
      ahead: 0,
      behind: 0
    },
    {
      fullName: 'refs/heads/main',
      name: 'main',
      kind: 'local',
      commit: main,
      current: false,
      upstream: 'origin/main',
      remote: 'origin',
      ahead: 0,
      behind: 0
    },
    {
      fullName: 'refs/heads/plain',
      name: 'heads/plain',
      kind: 'local',
      commit: main,
      current: false,
      upstream: '',
      remote: '',
      ahead: 0,
      behind: 0
    },
    {
      fullName: 'refs/remotes/origin/feature/topic',
      name: 'origin/feature/topic',
      kind: 'remote',
      commit: behind,
      current: false,
      upstream: '',
      remote: 'origin',
      ahead: 0,
      behind: 0
    },
    {
      fullName: 'refs/remotes/origin/main',
      name: 'origin/main',
      kind: 'remote',
      commit: main,
      current: false,
      upstream: '',
      remote: 'origin',
      ahead: 0,
      behind: 0
    }
  ]);
  assert.deepEqual(metadata.branches, sortedByFullName(metadata.branches));
});

test('branch metadata keeps the short-name quirk of an ambiguous current branch', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  commit(repo, 'a.txt', 'a\n', 'first');
  repo.git('tag', 'main');

  const metadata = await new GitService(repo.repository).getBranchMetadata();

  assert.equal(metadata.current, 'main');
  assert.equal(metadata.branches[0].name, 'heads/main');
  assert.equal(metadata.branches[0].current, false);
});

test('branch metadata falls back to main, master or the current branch without origin/HEAD', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  commit(repo, 'a.txt', 'a\n', 'first');
  const service = new GitService(repo.repository);

  assert.equal((await service.getBranchMetadata()).defaultBranch, 'main');
  repo.git('branch', '-m', 'main', 'master');
  assert.equal((await service.getBranchMetadata()).defaultBranch, 'master');
  repo.git('branch', '-m', 'master', 'trunk');
  const metadata = await service.getBranchMetadata();
  assert.equal(metadata.current, 'trunk');
  assert.equal(metadata.defaultBranch, 'trunk');
});

test('branch metadata reads a dangling or non-origin default remote HEAD like symbolic-ref', async t => {
  const { clone } = createClone(t);
  clone.git('switch', '-c', 'work');
  clone.git('branch', '-D', 'main');
  // origin/HEAD keeps pointing at a remote branch that no longer exists.
  clone.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  const service = new GitService(clone.repository);
  assert.equal((await service.getBranchMetadata()).defaultBranch, 'develop');

  clone.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature/topic');
  assert.equal((await service.getBranchMetadata()).defaultBranch, 'feature/topic');

  clone.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  assert.equal((await service.getBranchMetadata()).defaultBranch, 'work');
});

test('branch metadata reports the legacy current name for detached, rebasing and unborn HEADs', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const service = new GitService(repo.repository);
  const legacyCurrent = async () => (await simpleGit(repo.repository).branchLocal()).current || '';

  const unborn = await service.getBranchMetadata();
  assert.deepEqual(unborn, { current: '', defaultBranch: '', branches: [], remotes: [] });

  const first = commit(repo, 'a.txt', 'base\n', 'first');
  repo.git('switch', '--detach', first);
  let metadata = await service.getBranchMetadata();
  assert.equal(metadata.current, repo.git('rev-parse', '--short', first));
  assert.equal(metadata.current, await legacyCurrent());
  assert.equal(metadata.defaultBranch, 'main');
  assert.equal(metadata.branches.some(branch => branch.current), false);

  // Detaching at a branch name reports the full ref, as `git branch -v` does.
  repo.git('switch', 'main');
  repo.git('switch', '--detach', 'main');
  metadata = await service.getBranchMetadata();
  assert.equal(metadata.current, await legacyCurrent());
  assert.equal(metadata.branches.find(branch => branch.name === 'main').current, metadata.current === 'main');

  repo.git('switch', 'main');
  repo.git('switch', '-c', 'side');
  commit(repo, 'a.txt', 'side\n', 'side change');
  repo.git('switch', 'main');
  commit(repo, 'a.txt', 'main\n', 'main change');
  repo.git('switch', 'side');
  assert.throws(() => repo.git('rebase', 'main'));
  metadata = await service.getBranchMetadata();
  assert.equal(metadata.current, await legacyCurrent());
  assert.equal(metadata.branches.some(branch => branch.current), false);
  repo.git('rebase', '--abort');

  repo.git('switch', '--orphan', 'orphan');
  metadata = await service.getBranchMetadata();
  assert.equal(metadata.current, '');
  assert.equal(metadata.defaultBranch, 'main');
  assert.deepEqual(metadata.branches.map(branch => branch.name), ['main', 'side']);
});
