const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// GitService reads the process environment: keep the developer's global Git
// configuration (pull.rebase, credential helpers) out of these assertions.
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { GitService } = require('../src/main/git-service.mts');
const { createRepository, git } = require('./helpers/git-repository');

function createDivergedRepository(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('base.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  const remote = path.join(repo.root, 'origin.git');
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare', '-b', 'main');
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '--set-upstream', 'origin', 'main');

  const other = path.join(repo.root, 'other');
  git(repo.root, 'clone', remote, other);
  fs.writeFileSync(path.join(other, 'remote.txt'), 'remote\n');
  git(other, 'add', '.');
  git(other, 'commit', '-m', 'remote change');
  git(other, 'push');

  repo.write('local.txt', 'local\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'local change');
  return repo;
}

test('pulling diverged branches merges when no pull strategy is configured', async t => {
  const repo = createDivergedRepository(t);
  const service = new GitService(repo.repository);

  const result = await service.pull('origin', null);

  assert.equal(result.success, true);
  assert.equal(repo.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  assert.ok(fs.existsSync(path.join(repo.repository, 'remote.txt')));
  assert.ok(fs.existsSync(path.join(repo.repository, 'local.txt')));
});

test('a configured pull.rebase is respected', async t => {
  const repo = createDivergedRepository(t);
  repo.git('config', 'pull.rebase', 'true');
  const service = new GitService(repo.repository);

  await service.pull('origin', null);

  assert.equal(repo.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 2);
  assert.equal(repo.git('log', '-1', '--format=%s'), 'local change');
});

test('a configured pull.ff=only still refuses diverged branches', async t => {
  const repo = createDivergedRepository(t);
  repo.git('config', 'pull.ff', 'only');
  const service = new GitService(repo.repository);

  await assert.rejects(service.pull('origin', null), /Failed to pull/);
  assert.equal(repo.git('log', '-1', '--format=%s'), 'local change');
});

test('a per-branch rebase setting is respected', async t => {
  const repo = createDivergedRepository(t);
  repo.git('config', 'branch.main.rebase', 'true');
  const service = new GitService(repo.repository);

  assert.deepEqual(await service.defaultPullReconcileOptions(), {});
  await service.pull('origin', null);
  assert.equal(repo.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 2);
});
