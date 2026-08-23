const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanRepositories } = require('../src/main/repository-scanner.mts');

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function marker(root, relativePath, kind = 'directory') {
  const repository = path.join(root, relativePath);
  fs.mkdirSync(repository, { recursive: true });
  if (kind === 'file') {
    fs.writeFileSync(path.join(repository, '.git'), 'gitdir: ../metadata/worktree\n');
  } else {
    fs.mkdirSync(path.join(repository, '.git'));
  }
  return repository;
}

const normalizedPath = value =>
  String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const matchesRelative = (absolutePath, relativePath) =>
  normalizedPath(absolutePath).endsWith(`/${normalizedPath(relativePath)}`);

test('workspace scanning finds repositories and worktrees but stops below a repository', async t => {
  const root = createWorkspace(t);
  marker(root, 'apps/application');
  marker(root, 'worktrees/release', 'file');
  marker(root, 'apps/application/vendor/nested');
  marker(root, 'node_modules/dependency');
  fs.mkdirSync(path.join(root, 'bare.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bare.git', 'HEAD'), 'ref: refs/heads/main\n');

  const result = await scanRepositories(root);
  const expectedRelative = ['apps/application', 'worktrees/release'];

  assert.equal(result.canceled, false);
  assert.equal(result.repositories.length, expectedRelative.length);
  for (const relative of expectedRelative) {
    assert.ok(
      result.repositories.some(repo => matchesRelative(repo.path, relative)),
      `scan found ${relative} (${result.repositories.map(repo => repo.path).join(', ')})`
    );
  }
  assert.ok(result.scannedDirectories >= 4);
});

test('workspace scanning reports progress and can be canceled', async t => {
  const root = createWorkspace(t);
  for (let index = 0; index < 20; index += 1) {
    marker(root, `group-${index}/repository`);
  }
  const controller = new AbortController();
  const progress = [];

  const result = await scanRepositories(root, {
    signal: controller.signal,
    onProgress(update) {
      progress.push(update);
      if (update.scannedDirectories >= 2) controller.abort();
    }
  });

  assert.equal(result.canceled, true);
  assert.ok(progress.length >= 2);
  assert.ok(result.repositories.length < 20);
});

test('workspace scanning rejects a missing or non-directory root', async t => {
  const root = createWorkspace(t);
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'not a directory');

  await assert.rejects(scanRepositories(file), /directory/i);
  await assert.rejects(scanRepositories(path.join(root, 'missing')), /directory/i);
});
