const test = require('node:test');
const assert = require('node:assert/strict');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');

test('graph pages expose topology parents and refs from every branch', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());

  repo.write('base.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  repo.git('switch', '-c', 'feature/topic');
  repo.write('feature.txt', 'feature\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'feature');
  repo.git('switch', 'main');
  repo.write('main.txt', 'main\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'main');
  repo.git('merge', '--no-ff', 'feature/topic', '-m', 'merge topic');

  const service = new GitService(repo.repository);
  const page = await service.getGraphPage(0, 500);
  const mergeCommit = page.commits.find(commit => commit.subject === 'merge topic');

  assert.equal(mergeCommit.parents.length, 2);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextOffset, page.commits.length);
  assert.ok(page.refs.some(ref => ref.fullName === 'refs/heads/main'));
  assert.ok(page.refs.some(ref => ref.fullName === 'refs/heads/feature/topic'));
});

test('compareCommits returns differing files with status and unified diff', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());

  repo.write('base.txt', 'base\n');
  repo.write('shared.txt', 'original\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'initial');
  const hashA = repo.git('rev-parse', 'HEAD');

  repo.write('shared.txt', 'modified\n');
  repo.write('added.txt', 'new file\n');
  repo.git('add', '.');
  repo.git('rm', '--cached', 'base.txt');
  repo.git('commit', '-m', 'second');
  const hashB = repo.git('rev-parse', 'HEAD');

  const service = new GitService(repo.repository);
  const result = await service.compareCommits(hashA, hashB);

  assert.equal(result.base, hashA);
  assert.equal(result.compare, hashB);
  assert.ok(result.files.length >= 3);

  const added = result.files.find(f => f.path === 'added.txt');
  assert.equal(added.status, 'A');

  const modified = result.files.find(f => f.path === 'shared.txt');
  assert.equal(modified.status, 'M');

  const deleted = result.files.find(f => f.path === 'base.txt');
  assert.equal(deleted.status, 'D');

  assert.ok(result.diff.includes('shared.txt'));
  assert.ok(result.diff.includes('added.txt'));
});

test('compareCommits rejects invalid refs', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());

  repo.write('file.txt', 'content\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'init');

  const service = new GitService(repo.repository);
  await assert.rejects(
    service.compareCommits('nonexistent-ref', 'HEAD'),
    /Git ref not found/
  );
});

test('getCommitFileDiff returns parsed diff for a single file between two commits', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());

  repo.write('target.txt', 'line1\nline2\n');
  repo.write('other.txt', 'other\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'first');
  const hashA = repo.git('rev-parse', 'HEAD');

  repo.write('target.txt', 'line1\nmodified\nline3\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'second');
  const hashB = repo.git('rev-parse', 'HEAD');

  const service = new GitService(repo.repository);
  const diff = await service.getCommitFileDiff(hashA, hashB, 'target.txt');

  assert.equal(diff.path, 'target.txt');
  assert.ok(diff.hunks.length > 0);
  const allLines = diff.hunks.flatMap(h => h.lines);
  assert.ok(allLines.some(l => l.type === 'add'));
  assert.ok(allLines.some(l => l.type === 'delete'));
});

test('parseNameStatus handles renames and standard statuses', () => {
  const repo = createRepository();
  const service = new GitService(repo.repository);

  const raw = 'M\0src/app.js\0A\0new-file.txt\0D\0old-file.txt\0R100\0old-name.js\0new-name.js\0';
  const files = service.parseNameStatus(raw);

  assert.equal(files.length, 4);
  assert.deepEqual(files[0], { path: 'src/app.js', oldPath: null, status: 'M' });
  assert.deepEqual(files[1], { path: 'new-file.txt', oldPath: null, status: 'A' });
  assert.deepEqual(files[2], { path: 'old-file.txt', oldPath: null, status: 'D' });
  assert.deepEqual(files[3], { path: 'new-name.js', oldPath: 'old-name.js', status: 'R' });

  repo.cleanup();
});
