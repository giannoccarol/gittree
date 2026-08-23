const test = require('node:test');
const assert = require('node:assert/strict');
const { GitService } = require('../src/main/git-service.mts');
const { createRepository } = require('./helpers/git-repository');

function createHistoryFixture(t) {
  const repo = createRepository();
  t.after(() => repo.cleanup());

  repo.write('target.txt', 'root target\n');
  repo.write('untouched.txt', 'root untouched\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'root commit');
  const root = repo.git('rev-parse', 'HEAD');

  repo.git('switch', '-c', 'feature/topic');
  repo.write('target.txt', 'feature target\n');
  repo.write('feature-only.txt', 'feature one\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'feature one');
  const featureOne = repo.git('rev-parse', 'HEAD');
  repo.write('feature-two.txt', 'feature two\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'feature two');

  repo.git('switch', 'main');
  repo.write('target.txt', 'main target\n');
  repo.write('main-only.txt', 'main one\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'main one');
  repo.write('main-two.txt', 'main two\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'main two');

  return {
    repo,
    service: new GitService(repo.repository),
    root,
    featureOne
  };
}

test('Git history queries preserve their public repository contract', async t => {
  const fixture = createHistoryFixture(t);
  const { service, root, featureOne } = fixture;

  await t.test('getLog clamps counts and accepts a revision range', async () => {
    const range = 'main..feature/topic';
    const clampedMinimum = await service.getLog(-100, range);
    const completeRange = await service.getLog(Number.POSITIVE_INFINITY, range);

    assert.equal(clampedMinimum.all.length, 1);
    assert.equal(clampedMinimum.latest.message, 'feature two');
    assert.deepEqual(
      completeRange.all.map(commit => commit.message),
      ['feature two', 'feature one']
    );
  });

  await t.test('graph paging uses one look-ahead commit and stable offsets', async () => {
    const first = await service.getGraphPage(0, 2);
    const second = await service.getGraphPage(first.nextOffset, 2);
    const last = await service.getGraphPage(second.nextOffset, 2);
    const commits = [...first.commits, ...second.commits, ...last.commits];

    assert.equal(first.commits.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 2);
    assert.equal(second.commits.length, 2);
    assert.equal(second.hasMore, true);
    assert.equal(second.nextOffset, 4);
    assert.equal(last.commits.length, 1);
    assert.equal(last.hasMore, false);
    assert.equal(last.nextOffset, 5);
    assert.equal(new Set(commits.map(commit => commit.hash)).size, 5);
    assert.ok(first.refs.some(ref => ref.fullName === 'refs/heads/main'));
    assert.ok(first.refs.some(ref => ref.fullName === 'refs/heads/feature/topic'));
  });

  await t.test('root commit diff, detail and file filtering stay stable', async () => {
    const rootDiff = await service.getDiff(root);
    const detail = await service.getCommitDetail(root);
    const filtered = await service.getDiff(featureOne, 'target.txt');
    const parsed = await service.getCommitFileDiff(root, featureOne, 'target.txt');

    assert.match(rootDiff, /target\.txt/);
    assert.match(rootDiff, /untouched\.txt/);
    assert.equal(detail.hash, root);
    assert.equal(detail.message, 'root commit');
    assert.equal(detail.diff, rootDiff);
    assert.ok(detail.files.some(line => line.includes('target.txt')));
    assert.match(filtered, /target\.txt/);
    assert.doesNotMatch(filtered, /feature-only\.txt/);
    assert.equal(parsed.path, 'target.txt');
    assert.ok(parsed.hunks.some(hunk => (
      hunk.lines.some(line => line.type === 'add')
      && hunk.lines.some(line => line.type === 'delete')
    )));

    await assert.rejects(
      service.getDiff(featureOne, '../outside.txt'),
      /outside the repository/
    );
    await assert.rejects(
      service.getCommitFileDiff(root, featureOne, '../outside.txt'),
      /outside the repository/
    );
  });

  await t.test('branch comparison keeps its normalized shape and validates refs', async () => {
    const comparison = await service.getBranchComparison('main', 'feature/topic', 10);

    assert.equal(comparison.base, 'main');
    assert.equal(comparison.compare, 'feature/topic');
    assert.deepEqual(
      comparison.commits.map(commit => commit.message),
      ['feature two', 'feature one']
    );
    assert.match(comparison.diff, /feature-only\.txt/);
    assert.ok(Array.isArray(comparison.commits));

    await assert.rejects(
      service.getBranchComparison('--all', 'feature/topic', 10),
      /Invalid Git ref/
    );
    await assert.rejects(
      service.getBranchComparison('main', '--all', 10),
      /Invalid Git ref/
    );
  });

  await t.test('blame exposes per-line hashes, authors and summaries', async () => {
    const blame = await service.getBlame('main-two.txt', 'HEAD');

    assert.equal(blame.path, 'main-two.txt');
    assert.equal(blame.hash, 'HEAD');
    assert.equal(blame.rows.length, 1);
    assert.equal(blame.rows[0].finalLine, 1);
    assert.equal(blame.rows[0].author, 'GitTree Tests');
    assert.equal(blame.rows[0].summary, 'main two');

    const atCommit = await service.getBlame('target.txt', root);
    assert.equal(atCommit.rows.length, 1);
    assert.equal(atCommit.rows[0].summary, 'root commit');

    await assert.rejects(
      service.getBlame('../outside.txt'),
      /outside the repository/
    );
    await assert.rejects(
      service.getBlame('target.txt', '--all'),
      /Invalid Git ref/
    );
  });
});
