const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { RepoManager } = require('../src/main/repo-manager.mts');

function createManager(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-workspace-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    configPath: path.join(root, 'repos.json'),
    manager: new RepoManager({
      configPath: path.join(root, 'repos.json'),
      now: () => '2026-08-11T00:00:00.000Z',
      ...options
    })
  };
}

test('RepoManager normalizes repository identity and returns defensive copies', t => {
  const { manager, configPath } = createManager(t, { platform: 'win32' });
  const repositoryPath = path.resolve('Fixture-Repository');

  manager.addRepo(repositoryPath);
  manager.addRepo(repositoryPath.toLocaleLowerCase('en-US'));
  const repositories = manager.getAllRepos();
  repositories[0].name = 'mutated';

  assert.equal(manager.getAllRepos().length, 1);
  assert.notEqual(manager.getAllRepos()[0].name, 'mutated');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    repos: [{
      path: path.normalize(repositoryPath),
      name: path.basename(repositoryPath),
      addedAt: '2026-08-11T00:00:00.000Z'
    }],
    activeRepoIndex: 0
  });
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['repos.json']);
});

test('RepoManager rejects malformed persisted state and clamps active selection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-workspace-load-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'repos.json');
  fs.writeFileSync(configPath, JSON.stringify({
    repos: [
      { path: path.resolve('one'), addedAt: 'first' },
      { path: '', addedAt: 'invalid' }
    ],
    activeRepoIndex: 99
  }));

  const manager = new RepoManager({ configPath });

  assert.equal(manager.getAllRepos().length, 1);
  assert.equal(manager.getActiveRepo().path, path.resolve('one'));
});
